const express = require('express');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const multer = require('multer');

const app = express();
const server = http.createServer(app);
const PORT = Number(process.env.PORT || 3000);
const ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || '').trim();

if (ADMIN_PASSWORD.length < 20) {
  console.error(`ADMIN_PASSWORD is missing or too short. Received length: ${ADMIN_PASSWORD.length}`);
  process.exit(1);
}

app.disable('x-powered-by');
app.use(express.json({ limit: '25mb' }));

// Persistent storage: set DATA_DIR=/app/data in Gerdoo Cloud.
const configuredDataDir = String(process.env.DATA_DIR || '').trim();
const dataDir = configuredDataDir ? path.resolve(configuredDataDir) : (fs.existsSync('/app/data') ? '/app/data' : path.join(__dirname, 'data'));
const uploadsDir = path.join(dataDir, 'uploads');
const stateFile = path.join(dataDir, 'state.json');
fs.mkdirSync(uploadsDir, { recursive: true });

const devices = new Map();
const commands = new Map();
const transfers = new Map();

const upload = multer({ dest: uploadsDir, limits: { fileSize: 5 * 1024 * 1024 * 1024 } });
const hash = value => crypto.createHash('sha256').update(String(value)).digest('hex');

function safeEqual(a, b) {
  const x = Buffer.from(hash(a));
  const y = Buffer.from(hash(b));
  return crypto.timingSafeEqual(x, y);
}

// ---------- مدیریت حافظه و ذخیره ----------
let saveTimer = null;
let dirty = false;

function markDirty() {
  dirty = true;
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    if (dirty) {
      dirty = false;
      saveStateNow();
    }
  }, 1500); // حداکثر هر ۱.۵ ثانیه یک‌بار ذخیره
}

function saveStateNow() {
  try {
    // فقط داده‌های لازم را نگه می‌داریم
    const state = {
      devices: [...devices.values()],
      commands: [...commands.values()].slice(-200),      // حداکثر ۲۰۰ دستور اخیر
      transfers: [...transfers.values()].slice(-300).map(({ savedPath, ...t }) => ({ ...t, savedPath }))
    };
    const tmp = `${stateFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, stateFile);
  } catch (e) {
    console.error('saveState failed:', e.message);
  }
}

function loadState() {
  if (!fs.existsSync(stateFile)) return;
  try {
    const s = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    for (const d of s.devices || []) devices.set(d.deviceId, d);
    for (const c of s.commands || []) commands.set(c.id, c);
    for (const t of s.transfers || []) transfers.set(t.id, t);
    console.log(`Loaded ${devices.size} devices, ${commands.size} commands, ${transfers.size} transfers`);
  } catch (e) {
    console.error('Could not load state:', e.message);
  }
}
loadState();

// پاک‌سازی دوره‌ای حافظه (هر ۱۰ دقیقه)
setInterval(() => {
  const now = Date.now();
  const maxAge = 24 * 60 * 60 * 1000; // ۲۴ ساعت

  for (const [id, c] of commands) {
    if (c.status !== 'pending' && c.status !== 'delivered' && (now - (c.createdAt || 0)) > maxAge) {
      commands.delete(id);
    }
  }
  for (const [id, t] of transfers) {
    if (t.status === 'complete' || t.status === 'cancelled') {
      if ((now - (t.completedAt || t.cancelledAt || t.createdAt || 0)) > maxAge) {
        transfers.delete(id);
      }
    }
  }
  markDirty();
  console.log(`Memory cleanup: devices=${devices.size}, commands=${commands.size}, transfers=${transfers.size}`);
}, 10 * 60 * 1000);

// ---------- middleware ----------
function admin(req, res, next) {
  const token = (req.headers.authorization || '').replace(/^Bearer /, '');
  if (!safeEqual(token, ADMIN_PASSWORD)) return res.status(401).json({ error: 'unauthorized' });
  next();
}

function phone(req, res, next) {
  const token = (req.headers.authorization || '').replace(/^Bearer /, '');
  const tokenHash = hash(token);
  const device = [...devices.values()].find(d => d.tokenHash === tokenHash && d.approved && !d.revoked);
  if (!device) return res.status(401).json({ error: 'device_not_approved_or_revoked' });
  req.device = device;
  next();
}

function createCommand(deviceId, type, extra = {}) {
  const id = crypto.randomBytes(12).toString('hex');
  const command = { id, deviceId, type, ...extra, status: 'pending', createdAt: Date.now() };
  commands.set(id, command);
  markDirty();
  return command;
}

// ---------- routes ----------
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => {
  let writable = false;
  try { fs.accessSync(dataDir, fs.constants.W_OK); writable = true; } catch (_) {}
  res.json({ ok: true, storage: { dataDir, uploadsDir, writable }, memory: process.memoryUsage() });
});

app.post('/api/admin/login', (req, res) => {
  try {
    if (!safeEqual(req.body?.password || '', ADMIN_PASSWORD)) return res.status(401).json({ error: 'unauthorized' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'server_error' });
  }
});

app.get('/api/admin/devices', admin, (_req, res) => {
  try {
    res.json([...devices.values()].map(({ tokenHash, ...device }) => device));
  } catch (e) {
    res.status(500).json({ error: 'server_error' });
  }
});

app.post('/api/admin/devices/:id/approve', admin, (req, res) => {
  try {
    const device = devices.get(req.params.id);
    if (!device || device.revoked) return res.status(404).json({ error: 'not_found' });
    device.approved = true;
    device.approvedAt = Date.now();
    markDirty();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'server_error' });
  }
});

app.post('/api/admin/devices/:id/revoke', admin, (req, res) => {
  try {
    const device = devices.get(req.params.id);
    if (!device) return res.status(404).json({ error: 'not_found' });
    device.revoked = true;
    device.tokenHash = '';
    markDirty();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'server_error' });
  }
});

app.post('/api/admin/devices/:id/scan', admin, (req, res) => {
  try {
    const device = devices.get(req.params.id);
    if (!device || !device.approved || device.revoked) {
      return res.status(404).json({ error: 'device_not_available' });
    }
    const command = createCommand(req.params.id, 'list');
    res.json({ commandId: command.id });
  } catch (e) {
    console.error('scan error:', e.message);
    res.status(500).json({ error: 'server_error' });
  }
});

app.get('/api/admin/devices/:id/files', admin, (req, res) => {
  try {
    const device = devices.get(req.params.id);
    if (!device) return res.status(404).json({ error: 'not_found' });
    res.json({ files: device.files || [], updatedAt: device.filesUpdatedAt || null, folderStats: device.folderStats || {} });
  } catch (e) {
    res.status(500).json({ error: 'server_error' });
  }
});

app.post('/api/admin/devices/:id/transfers', admin, (req, res) => {
  try {
    const device = devices.get(req.params.id);
    if (!device || !device.approved || device.revoked) {
      return res.status(404).json({ error: 'device_not_available' });
    }
    const requestedPath = req.body?.path;
    const knownFile = (device.files || []).find(file => file.path === requestedPath);
    if (!knownFile) return res.status(400).json({ error: 'file_not_in_latest_device_listing' });

    const command = createCommand(req.params.id, 'transfer', { path: knownFile.path });
    transfers.set(command.id, {
      id: command.id,
      deviceId: req.params.id,
      name: path.basename(knownFile.path),
      path: knownFile.path,
      status: 'queued',
      createdAt: command.createdAt,
      studentName: `${device.firstName || ''} ${device.lastName || ''}`.trim()
    });
    markDirty();
    res.json({ transferId: command.id, status: 'queued' });
  } catch (e) {
    res.status(500).json({ error: 'server_error' });
  }
});

app.post('/api/admin/devices/:id/transfers/batch', admin, (req, res) => {
  try {
    const device = devices.get(req.params.id);
    if (!device) return res.status(404).json({ error: 'device_not_found' });
    const paths = Array.isArray(req.body.paths) ? [...new Set(req.body.paths.map(String))] : [];
    if (!paths.length || paths.length > 100) return res.status(400).json({ error: 'invalid_batch_size' });
    const created = [];
    for (const requestedPath of paths) {
      const knownFile = (device.files || []).find(file => file.path === requestedPath);
      if (!knownFile) continue;
      const command = createCommand(req.params.id, 'transfer', { path: knownFile.path });
      transfers.set(command.id, {
        id: command.id, deviceId: req.params.id, path: knownFile.path,
        name: knownFile.name || path.basename(knownFile.path),
        size: Number(knownFile.size || 0), status: 'queued', createdAt: Date.now()
      });
      created.push(command.id);
    }
    if (!created.length) return res.status(400).json({ error: 'no_valid_files' });
    markDirty();
    res.json({ transferIds: created, count: created.length, status: 'queued' });
  } catch (e) {
    console.error('batch transfer error:', e.message);
    res.status(500).json({ error: 'server_error' });
  }
});

app.post('/api/admin/transfers/:id/cancel', admin, (req, res) => {
  try {
    const transfer = transfers.get(req.params.id);
    const command = commands.get(req.params.id);
    if (!transfer || !command || !['queued', 'delivered'].includes(transfer.status)) {
      return res.status(409).json({ error: 'transfer_not_cancellable' });
    }
    transfer.status = 'cancelled';
    transfer.cancelledAt = Date.now();
    command.status = 'cancelled';
    markDirty();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'server_error' });
  }
});

app.get('/api/admin/transfers', admin, (_req, res) => {
  try {
    res.json([...transfers.values()]);
  } catch (e) {
    res.status(500).json({ error: 'server_error' });
  }
});

app.get('/api/admin/transfers/:id/download', admin, (req, res) => {
  try {
    const transfer = transfers.get(req.params.id);
    if (!transfer || transfer.status !== 'complete' || !transfer.savedPath || !fs.existsSync(transfer.savedPath)) {
      return res.status(404).json({ error: 'not_ready' });
    }
    res.download(transfer.savedPath, transfer.name);
  } catch (e) {
    res.status(500).json({ error: 'server_error' });
  }
});

// ثبت‌نام دستگاه
app.post('/api/phone/enroll', (req, res) => {
  try {
    const { deviceId, firstName, lastName, major } = req.body || {};
    if (![deviceId, firstName, lastName, major].every(v => typeof v === 'string' && v.trim().length > 0 && v.length < 160)) {
      return res.status(400).json({ error: 'invalid_profile' });
    }
    if (devices.has(deviceId)) return res.status(409).json({ error: 'device_already_registered' });

    const token = crypto.randomBytes(32).toString('hex');
    const safeFolder = `${firstName.trim()}_${lastName.trim()}_${deviceId}`
      .replace(/[^a-zA-Z0-9._\-\u0600-\u06FF]/g, '_')
      .slice(0, 120);
    const userDir = path.join(uploadsDir, safeFolder);
    fs.mkdirSync(userDir, { recursive: true });

    devices.set(deviceId, {
      deviceId,
      firstName: firstName.trim(),
      lastName: lastName.trim(),
      major: major.trim(),
      tokenHash: hash(token),
      approved: true,
      revoked: false,
      pairedAt: Date.now(),
      lastSeen: Date.now(),
      files: [],
      uploadFolder: safeFolder
    });
    markDirty();
    res.json({ deviceId, token, approvalRequired: false });
  } catch (e) {
    console.error('enroll error:', e.message);
    res.status(500).json({ error: 'server_error' });
  }
});

app.get('/api/phone/commands', phone, (req, res) => {
  try {
    req.device.lastSeen = Date.now();
    const pending = [...commands.values()].filter(c => c.deviceId === req.device.deviceId && c.status === 'pending');
    for (const command of pending) command.status = 'delivered';
    if (pending.length) markDirty();
    res.json(pending);
  } catch (e) {
    res.status(500).json({ error: 'server_error' });
  }
});

app.post('/api/phone/commands/:id/result', phone, (req, res) => {
  try {
    const command = commands.get(req.params.id);
    if (!command || command.deviceId !== req.device.deviceId || command.type !== 'list' || command.status === 'cancelled') {
      return res.status(404).json({ error: 'not_found' });
    }
    if (!Array.isArray(req.body.files)) {
      return res.status(400).json({ error: 'invalid_file_list' });
    }
    req.device.files = req.body.files.slice(0, 20000);
    req.device.folderStats = (req.body.folderStats && typeof req.body.folderStats === 'object')
      ? req.body.folderStats : {};
    req.device.filesUpdatedAt = Date.now();
    command.status = 'complete';
    markDirty();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'server_error' });
  }
});

app.post('/api/phone/transfers/:id/file', phone, upload.single('file'), (req, res) => {
  try {
    const command = commands.get(req.params.id);
    const transfer = transfers.get(req.params.id);
    if (!command || !transfer || command.deviceId !== req.device.deviceId ||
        command.status === 'cancelled' || transfer.status === 'cancelled' || !req.file) {
      if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
      return res.status(403).json({ error: 'invalid_or_cancelled_transfer' });
    }

    const folderName = req.device.uploadFolder || req.device.deviceId;
    const userDir = path.join(uploadsDir, folderName);

    let relativePath = '';
    try {
      const originalPath = String(command.path || transfer.path || req.file.originalname || '');
      relativePath = originalPath
        .replace(/^\/storage\/emulated\/\d+\//, '')
        .replace(/^\/sdcard\//, '')
        .replace(/^\/mnt\/sdcard\//, '');
    } catch (_) {}

    if (!relativePath) relativePath = path.basename(req.file.originalname || 'file.bin');

    const parts = relativePath.split(/[\\/]/).filter(Boolean).map(part =>
      part.replace(/[^a-zA-Z0-9._\-\u0600-\u06FF ]/g, '_').slice(0, 80)
    );
    if (parts.length === 0) parts.push('file.bin');

    const destination = path.join(userDir, ...parts);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.renameSync(req.file.path, destination);

    transfer.savedPath = destination;
    transfer.relativePath = parts.join('/');
    transfer.status = 'complete';
    transfer.completedAt = Date.now();
    command.status = 'complete';
    markDirty();
    res.json({ ok: true });
  } catch (e) {
    console.error('transfer file error:', e.message);
    if (req.file?.path && fs.existsSync(req.file.path)) {
      try { fs.unlinkSync(req.file.path); } catch (_) {}
    }
    res.status(500).json({ error: 'upload_failed' });
  }
});

app.post('/api/phone/revoke', phone, (req, res) => {
  try {
    req.device.revoked = true;
    req.device.tokenHash = '';
    markDirty();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'server_error' });
  }
});

app.post('/api/phone/upload', phone, upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'no_file' });

    const safeName = path.basename(req.file.originalname)
      .replace(/[^a-zA-Z0-9._\-\u0600-\u06FF]/g, '_')
      .slice(0, 180) || 'upload.bin';

    const folderName = req.device.uploadFolder || req.device.deviceId;
    const userDir = path.join(uploadsDir, folderName);
    fs.mkdirSync(userDir, { recursive: true });

    const destination = path.join(userDir, `${Date.now()}-${safeName}`);
    fs.renameSync(req.file.path, destination);

    const transferId = crypto.randomBytes(12).toString('hex');
    transfers.set(transferId, {
      id: transferId,
      deviceId: req.device.deviceId,
      name: safeName,
      status: 'complete',
      createdAt: Date.now(),
      completedAt: Date.now(),
      savedPath: destination,
      uploadedByStudent: true,
      studentName: `${req.device.firstName} ${req.device.lastName}`
    });

    req.device.lastSeen = Date.now();
    req.device.lastUploadAt = Date.now();
    req.device.lastUploadName = safeName;
    markDirty();
    res.json({ ok: true, transferId, name: safeName });
  } catch (e) {
    console.error('upload error:', e.message);
    if (req.file?.path && fs.existsSync(req.file.path)) {
      try { fs.unlinkSync(req.file.path); } catch (_) {}
    }
    res.status(500).json({ error: 'upload_failed' });
  }
});

// جلوگیری از کرش کل پروسه
process.on('uncaughtException', (err) => {
  console.error('uncaughtException:', err.message);
});
process.on('unhandledRejection', (err) => {
  console.error('unhandledRejection:', err);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Alzahra server listening on ${PORT}`);
});
