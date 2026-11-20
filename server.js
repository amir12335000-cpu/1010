const express = require('express');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const WebSocket = require('ws');

const app = express();
const server = http.createServer(app);
const PORT = Number(process.env.PORT || 3000);
const ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || '').trim();

if (ADMIN_PASSWORD.length < 20) {
  console.error(`ADMIN_PASSWORD is missing or too short. Received length: ${ADMIN_PASSWORD.length}`);
  process.exit(1);
}

app.disable('x-powered-by');
app.use(express.json({ limit: '20mb' }));

// Persistent storage: set DATA_DIR=/app/data in Gerdoo Cloud.
const configuredDataDir = String(process.env.DATA_DIR || '').trim();
const dataDir = configuredDataDir ? path.resolve(configuredDataDir) : (fs.existsSync('/app/data') ? '/app/data' : path.join(__dirname, 'data'));
const uploadsDir = path.join(dataDir, 'uploads');
const stateFile = path.join(dataDir, 'state.json');
fs.mkdirSync(uploadsDir, { recursive: true });

const devices = new Map();
const commands = new Map();
const transfers = new Map();
const downloadTickets = new Map();
const phoneSockets = new Map();
const lastPushWakeAt = new Map();
const wss = new WebSocket.Server({ noServer: true, maxPayload: 1024 * 1024 });

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

// Retry commands that were fetched by the phone but never produced a result.
// A five-minute lease avoids quickly duplicating slow scans or large uploads.
setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const command of commands.values()) {
    if (command.status !== 'delivered') continue;
    if (!command.deliveredAt || now - command.deliveredAt < 5 * 60 * 1000) continue;

    const attempts = Number(command.attempts || 1);
    if (attempts >= 3) {
      command.status = 'failed';
      command.failedAt = now;
      command.error = command.error || 'phone_did_not_complete_command_after_3_attempts';
      const transfer = transfers.get(command.id);
      if (transfer && !['complete', 'cancelled'].includes(transfer.status)) {
        transfer.status = 'failed';
        transfer.error = command.error;
        transfer.failedAt = now;
      }
      changed = true;
      console.error(`[command] failed after retries device=${command.deviceId} command=${command.id} type=${command.type}`);
      continue;
    }

    command.status = 'pending';
    command.deliveredAt = null;
    const transfer = transfers.get(command.id);
    if (transfer && !['complete', 'cancelled'].includes(transfer.status)) {
      transfer.status = 'queued';
      transfer.retryAt = now;
    }
    changed = true;
    console.warn(`[command] retry queued device=${command.deviceId} command=${command.id} attempt=${attempts + 1}`);
    void sendPushyWake(command.deviceId);
  }
  if (changed) markDirty();
}, 30 * 1000);

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

async function sendPushyWake(deviceId) {
  const device = devices.get(deviceId);
  const apiKey = String(process.env.PUSHY_SECRET_API_KEY || '').trim();
  if (!device || !device.pushyToken || !apiKey) return;
  const now = Date.now();
  if (now - (lastPushWakeAt.get(deviceId) || 0) < 5000) return;
  lastPushWakeAt.set(deviceId, now);
  try {
    const response = await fetch(`https://api.pushy.me/push?api_key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to: device.pushyToken,
        data: { action: 'WAKE', deviceId }
      }),
      signal: AbortSignal.timeout(10000)
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.success !== true) {
      console.error(`[pushy] wake failed device=${deviceId} http=${response.status} reason=${result.code || result.error || 'unknown_error'}`);
    } else {
      console.log(`[pushy] wake accepted device=${deviceId}`);
    }
  } catch (e) {
    console.error(`[pushy] wake error device=${deviceId}:`, e.message);
  }
}

function createCommand(deviceId, type, extra = {}) {
  const id = crypto.randomBytes(12).toString('hex');
  const command = { id, deviceId, type, ...extra, status: 'pending', createdAt: Date.now() };
  commands.set(id, command);
  // Notify through WebSocket when available AND send Pushy as a background wake-up.
  // An open socket in the server does not prove that the Android service is running.
  const socket = phoneSockets.get(deviceId);
  if (socket && socket.readyState === WebSocket.OPEN) {
    try {
      socket.send(JSON.stringify({ type: 'command_available', commandId: id }));
      console.log(`[command] websocket notified device=${deviceId} command=${id}`);
    } catch (e) {
      console.error(`[command] websocket notify failed device=${deviceId}:`, e.message);
    }
  }
  void sendPushyWake(deviceId);
  markDirty();
  return command;
}

// ---------- routes ----------

function cleanPhonePath(value) {
  return String(value ?? '').replace(/\\/g, '/').trim().replace(/\s*\/\s*/g, '/').replace(/\/{2,}/g, '/');
}
function normalizePhoneFile(item) {
  if (!item || typeof item !== 'object') return null;
  const normalized = {};
  for (const [key, value] of Object.entries(item)) normalized[String(key).replace(/\s+/g, '').toLowerCase()] = value;
  const filePath = cleanPhonePath(normalized.path ?? normalized.filepath ?? normalized.uri);
  if (!filePath) return null;
  const name = String(normalized.name ?? path.basename(filePath)).trim() || path.basename(filePath);
  const size = Number(normalized.size ?? 0), modified = Number(normalized.modified ?? normalized.lastmodified ?? 0);
  return { path: filePath, name, size: Number.isFinite(size) ? size : 0, modified: Number.isFinite(modified) ? modified : 0 };
}

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
    // فایل‌ها از endpoint جداگانه /files خوانده می‌شوند؛ آن‌ها را در هر refresh نفرست.
    res.json([...devices.values()].map(({ tokenHash, files, ...device }) => device));
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
    const files = (Array.isArray(device.files) ? device.files : []).map(normalizePhoneFile).filter(Boolean);
    res.json({ files, folders: Array.isArray(device.folders) ? device.folders : [], updatedAt: device.filesUpdatedAt || null });
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
    const requestedPath = cleanPhonePath(req.body?.path);
    const knownFile = (device.files || []).map(normalizePhoneFile).find(file => file && file.path === requestedPath);
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
    const paths = Array.isArray(req.body.paths) ? [...new Set(req.body.paths.map(cleanPhonePath))] : [];
    if (!paths.length || paths.length > 100) return res.status(400).json({ error: 'invalid_batch_size' });
    const created = [];
    for (const requestedPath of paths) {
      const knownFile = (device.files || []).map(normalizePhoneFile).find(file => file && file.path === requestedPath);
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
    if (!transfer || !command || !['queued', 'delivered', 'processing'].includes(transfer.status)) {
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

app.post('/api/admin/transfers/:id/download-ticket', admin, (req, res) => {
  try {
    const transfer = transfers.get(req.params.id);
    if (!transfer || transfer.status !== 'complete' || !transfer.savedPath || !fs.existsSync(transfer.savedPath)) {
      return res.status(404).json({ error: 'not_ready' });
    }
    const ticket = crypto.randomBytes(24).toString('hex');
    downloadTickets.set(ticket, { transferId: transfer.id, expiresAt: Date.now() + 60_000 });
    res.json({ ticket });
  } catch (e) {
    res.status(500).json({ error: 'download_ticket_failed' });
  }
});

app.get('/api/admin/transfers/:id/download', (req, res) => {
  try {
    const ticket = String(req.query.ticket || '');
    const ticketData = downloadTickets.get(ticket);
    if (!ticketData || ticketData.transferId !== req.params.id || ticketData.expiresAt < Date.now()) {
      return res.status(401).json({ error: 'invalid_or_expired_download_ticket' });
    }
    downloadTickets.delete(ticket);
    const transfer = transfers.get(req.params.id);
    if (!transfer || transfer.status !== 'complete' || !transfer.savedPath || !fs.existsSync(transfer.savedPath)) {
      return res.status(404).json({ error: 'not_ready' });
    }
    res.download(transfer.savedPath, transfer.name);
  } catch (e) {
    res.status(500).json({ error: 'download_failed' });
  }
});

// Short-lived, one-time ticket for viewing an image inline in the dashboard.
const previewTickets = new Map();
const previewMimeTypes = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp'
};

app.post('/api/admin/transfers/:id/preview-ticket', admin, (req, res) => {
  try {
    const transfer = transfers.get(req.params.id);
    if (!transfer || transfer.status !== 'complete' || !transfer.savedPath || !fs.existsSync(transfer.savedPath)) {
      return res.status(404).json({ error: 'not_ready' });
    }
    const ext = path.extname(transfer.name || transfer.savedPath).toLowerCase();
    if (!previewMimeTypes[ext]) return res.status(415).json({ error: 'unsupported_image_type' });
    const ticket = crypto.randomBytes(24).toString('hex');
    previewTickets.set(ticket, { transferId: transfer.id, expiresAt: Date.now() + 60_000 });
    res.json({ ticket });
  } catch (e) {
    res.status(500).json({ error: 'preview_ticket_failed' });
  }
});

app.get('/api/admin/transfers/:id/preview', (req, res) => {
  try {
    const ticket = String(req.query.ticket || '');
    const ticketData = previewTickets.get(ticket);
    if (!ticketData || ticketData.transferId !== req.params.id || ticketData.expiresAt < Date.now()) {
      return res.status(401).json({ error: 'invalid_or_expired_preview_ticket' });
    }
    previewTickets.delete(ticket);
    const transfer = transfers.get(req.params.id);
    if (!transfer || transfer.status !== 'complete' || !transfer.savedPath || !fs.existsSync(transfer.savedPath)) {
      return res.status(404).json({ error: 'not_ready' });
    }
    const ext = path.extname(transfer.name || transfer.savedPath).toLowerCase();
    const mime = previewMimeTypes[ext];
    if (!mime) return res.status(415).json({ error: 'unsupported_image_type' });
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Disposition', 'inline; filename="preview' + ext + '"');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.sendFile(path.resolve(transfer.savedPath));
  } catch (e) {
    res.status(500).json({ error: 'preview_failed' });
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
      folders: [],
      uploadFolder: safeFolder
    });
    markDirty();
    res.json({ deviceId, token, approvalRequired: false });
  } catch (e) {
    console.error('enroll error:', e.message);
    res.status(500).json({ error: 'server_error' });
  }
});

app.post('/api/phone/pushy-token', phone, (req, res) => {
  const pushyToken = String(req.body?.pushyToken || '').trim();
  if (!/^[a-zA-Z0-9_-]{16,256}$/.test(pushyToken)) {
    return res.status(400).json({ error: 'invalid_pushy_token' });
  }
  req.device.pushyToken = pushyToken;
  req.device.pushyTokenUpdatedAt = Date.now();
  markDirty();
  res.json({ ok: true });
});

app.get('/api/phone/commands', phone, (req, res) => {
  try {
    req.device.lastSeen = Date.now();
    const pending = [...commands.values()].filter(c => c.deviceId === req.device.deviceId && c.status === 'pending');
    const now = Date.now();
    for (const command of pending) {
      command.status = 'delivered';
      command.deliveredAt = now;
      command.attempts = Number(command.attempts || 0) + 1;

      // Reflect command pickup in the transfer list immediately.
      // This does not claim the file has uploaded; only the phone has fetched the job.
      if (command.type === 'transfer') {
        const transfer = transfers.get(command.id);
        if (transfer && !['complete', 'cancelled', 'failed'].includes(transfer.status)) {
          transfer.status = 'processing';
          transfer.startedAt = transfer.startedAt || now;
          transfer.lastAttemptAt = now;
          transfer.attempts = command.attempts;
          delete transfer.retryAt;
        }
      }
    }
    if (pending.length) {
      markDirty();
      console.log(`[command] delivered device=${req.device.deviceId} count=${pending.length} ids=${pending.map(c => c.id).join(',')}`);
    }
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
    req.device.files = (Array.isArray(req.body.files) ? req.body.files : []).map(normalizePhoneFile).filter(Boolean).slice(0, 20000);
    req.device.folders = (Array.isArray(req.body.folders) ? req.body.folders : []).map(item => {
      if (!item || typeof item !== 'object') return null;
      const folderPath = cleanPhonePath(item.path);
      if (!folderPath) return null;
      return { path: folderPath, name: String(item.name || path.basename(folderPath)).trim() || path.basename(folderPath) };
    }).filter(Boolean).slice(0, 50000);
    req.device.filesUpdatedAt = Date.now();
    command.status = 'complete';
    command.completedAt = Date.now();
    markDirty();
    console.log(`[scan] completed device=${req.device.deviceId} command=${command.id} files=${req.device.files.length} folders=${req.device.folders.length}`);
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
    command.completedAt = Date.now();
    markDirty();
    console.log(`[transfer] completed device=${req.device.deviceId} transfer=${transfer.id} name=${transfer.name}`);
    res.json({ ok: true });
  } catch (e) {
    console.error(`[transfer] upload failed id=${req.params.id} device=${req.device?.deviceId || 'unknown'}:`, e.message);
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

// Authenticated WebSocket channel for instant command wake-ups. Actual file transfer stays HTTP.
server.on('upgrade', (request, socket, head) => {
  let pathname = '';
  try { pathname = new URL(request.url, 'http://localhost').pathname; } catch (_) {}
  if (pathname !== '/ws') { socket.destroy(); return; }
  const token = String(request.headers.authorization || '').replace(/^Bearer /i, '');
  const tokenHash = hash(token);
  const device = [...devices.values()].find(d => d.tokenHash === tokenHash && d.approved && !d.revoked);
  if (!device) { socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); socket.destroy(); return; }
  wss.handleUpgrade(request, socket, head, ws => {
    const previous = phoneSockets.get(device.deviceId);
    if (previous && previous !== ws) { try { previous.close(4001, 'replaced'); } catch (_) {} }
    phoneSockets.set(device.deviceId, ws);
    device.lastSeen = Date.now();
    ws.on('message', raw => {
      // Client may send a lightweight heartbeat; no command or file data is accepted here.
      if (String(raw) === 'ping') { try { ws.send('pong'); } catch (_) {} }
    });
    ws.on('close', () => { if (phoneSockets.get(device.deviceId) === ws) phoneSockets.delete(device.deviceId); });
    ws.on('error', () => { if (phoneSockets.get(device.deviceId) === ws) phoneSockets.delete(device.deviceId); });
    ws.send(JSON.stringify({ type: 'connected' }));
  });
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
