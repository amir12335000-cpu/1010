package ir.phonelink

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.os.Build
import android.os.Environment
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.asRequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

class ShareService : Service() {
    private val running = AtomicBoolean(false)
    private var worker: Thread? = null
    private var commandSocket: WebSocket? = null
    private val wakeLock = java.lang.Object()

    @Volatile
    private var cpuWakeLock: PowerManager.WakeLock? = null

    @Volatile
    private var cachedScan: Pair<JSONArray, JSONArray>? = null

    @Volatile
    private var cachedScanAt = 0L

    @Volatile
    private var socketServer = ""

    @Volatile
    private var socketToken = ""

    private val http = OkHttpClient.Builder()
        .connectTimeout(20, TimeUnit.SECONDS)
        .readTimeout(120, TimeUnit.SECONDS)
        .writeTimeout(120, TimeUnit.SECONDS)
        .pingInterval(20, TimeUnit.SECONDS)
        .build()

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
        startForeground(NOTIFICATION_ID, buildNotification())

        val powerManager = getSystemService(PowerManager::class.java)
        cpuWakeLock = powerManager.newWakeLock(
            PowerManager.PARTIAL_WAKE_LOCK,
            "PhoneLink:BackgroundTransfer"
        ).apply {
            setReferenceCounted(false)
        }

        cpuWakeLock?.acquire()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (running.compareAndSet(false, true)) {
            worker = Thread {
                commandLoop()
            }.apply {
                name = "PhoneLinkSync"
                start()
            }
        }

        return START_NOT_STICKY
    }

    private fun commandLoop() {
        while (running.get()) {
            var noCommands = false

            try {
                val prefs = getSharedPreferences("alzahra_settings", MODE_PRIVATE)

                val token = prefs.getString("device_token", "").orEmpty()
                val server = prefs.getString(
                    "server_url",
                    BuildConfig.SERVER_BASE_URL
                ).orEmpty().trimEnd('/')

                if (
                    token.isBlank() ||
                    server.isBlank() ||
                    !prefs.getBoolean("sharing_enabled", true)
                ) {
                    Thread.sleep(3000)
                    continue
                }

                ensureCommandSocket(server, token)

                val request = Request.Builder()
                    .url("$server/api/phone/commands")
                    .header("Authorization", "Bearer $token")
                    .get()
                    .build()

                http.newCall(request).execute().use { response ->
                    if (response.isSuccessful) {
                        val body = response.body?.string().orEmpty()
                        val commands = JSONArray(body)

                        if (commands.length() == 0) {
                            noCommands = true
                        } else {
                            for (i in 0 until commands.length()) {
                                if (!running.get()) break

                                val command = commands.optJSONObject(i) ?: continue

                                when (command.optString("type")) {
                                    "list" -> processListCommand(
                                        server,
                                        token,
                                        command
                                    )

                                    "transfer" -> processTransferCommand(
                                        server,
                                        token,
                                        command
                                    )
                                }
                            }
                        }
                    }
                }

                if (noCommands) break

            } catch (_: Exception) {
                // Keep the foreground sync service alive; next poll retries.
            }

            // WebSocket wakes this loop immediately; 2.5s polling remains as fallback.
            var interrupted = false

            synchronized(wakeLock) {
                try {
                    wakeLock.wait(2500)
                } catch (_: InterruptedException) {
                    interrupted = true
                }
            }

            if (interrupted && !running.get()) break
        }

        commandSocket?.close(1000, "service stopped")
        commandSocket = null

        running.set(false)

        stopForeground(true)
        stopSelf()
    }

    private fun ensureCommandSocket(server: String, token: String) {
        if (
            commandSocket != null &&
            socketServer == server &&
            socketToken == token
        ) {
            return
        }

        commandSocket?.cancel()

        socketServer = server
        socketToken = token

        val wsUrl = server
            .replaceFirst("^https://".toRegex(), "wss://")
            .replaceFirst("^http://".toRegex(), "ws://") + "/ws"

        val request = Request.Builder()
            .url(wsUrl)
            .header("Authorization", "Bearer $token")
            .build()

        commandSocket = http.newWebSocket(
            request,
            object : WebSocketListener() {

                override fun onOpen(
                    webSocket: WebSocket,
                    response: okhttp3.Response
                ) {
                    synchronized(wakeLock) {
                        wakeLock.notifyAll()
                    }
                }

                override fun onMessage(
                    webSocket: WebSocket,
                    text: String
                ) {
                    if (text.contains("command_available")) {
                        synchronized(wakeLock) {
                            wakeLock.notifyAll()
                        }
                    }
                }

                override fun onMessage(
                    webSocket: WebSocket,
                    bytes: ByteString
                ) {
                }

                override fun onFailure(
                    webSocket: WebSocket,
                    t: Throwable,
                    response: okhttp3.Response?
                ) {
                    if (commandSocket === webSocket) {
                        commandSocket = null
                    }

                    synchronized(wakeLock) {
                        wakeLock.notifyAll()
                    }
                }

                override fun onClosed(
                    webSocket: WebSocket,
                    code: Int,
                    reason: String
                ) {
                    if (commandSocket === webSocket) {
                        commandSocket = null
                    }
                }
            }
        )
    }

    private fun processListCommand(
        server: String,
        token: String,
        command: JSONObject
    ) {
        val scan = scanPhoneStorage()

        val payload = JSONObject()
            .put("files", scan.first)
            .put("folders", scan.second)

        val request = Request.Builder()
            .url("$server/api/phone/commands/${command.optString("id")}/result")
            .header("Authorization", "Bearer $token")
            .post(
                payload.toString().toRequestBody(
                    "application/json".toMediaType()
                )
            )
            .build()

        http.newCall(request).execute().use { }
    }

    private fun scanPhoneStorage(): Pair<JSONArray, JSONArray> {
        // Reuse a recent inventory instead of walking the entire storage.
        val now = System.currentTimeMillis()
        val existing = cachedScan

        if (existing != null && now - cachedScanAt < SCAN_CACHE_MS) {
            return existing
        }

        val files = JSONArray()
        val folders = JSONArray()

        val root = Environment.getExternalStorageDirectory().canonicalFile
        val rootPrefix = root.path + File.separator

        val visited = HashSet<String>()
        val stack = ArrayDeque<File>()

        stack.add(root)

        while (
            stack.isNotEmpty() &&
            (files.length() < MAX_FILES || folders.length() < MAX_FOLDERS)
        ) {
            val dir = stack.removeLast()

            val canonicalDir = try {
                dir.canonicalFile
            } catch (_: IOException) {
                continue
            }

            if (
                canonicalDir.path != root.path &&
                !canonicalDir.path.startsWith(rootPrefix)
            ) {
                continue
            }

            if (!visited.add(canonicalDir.path)) continue

            val children = try {
                canonicalDir.listFiles()
            } catch (_: SecurityException) {
                null
            } ?: continue

            for (child in children) {
                try {
                    val childPath = child.absoluteFile.path

                    if (
                        childPath != root.path &&
                        !childPath.startsWith(rootPrefix)
                    ) {
                        continue
                    }

                    if (child.isDirectory) {
                        if (folders.length() < MAX_FOLDERS) {
                            folders.put(
                                JSONObject()
                                    .put("path", childPath)
                                    .put("name", child.name)
                            )
                        }

                        if (child.canRead()) {
                            stack.add(child.absoluteFile)
                        }

                    } else if (
                        child.isFile &&
                        child.canRead() &&
                        files.length() < MAX_FILES
                    ) {
                        files.put(
                            JSONObject()
                                .put("path", childPath)
                                .put("name", child.name)
                                .put("size", child.length())
                                .put("modified", child.lastModified())
                        )
                    }

                } catch (_: Exception) {
                }

                if (
                    files.length() >= MAX_FILES &&
                    folders.length() >= MAX_FOLDERS
                ) {
                    break
                }
            }
        }

        val result = Pair(files, folders)

        cachedScan = result
        cachedScanAt = System.currentTimeMillis()

        return result
    }

    private fun processTransferCommand(
        server: String,
        token: String,
        command: JSONObject
    ) {
        val requestedPath = command.optString("path")

        val file = try {
            File(requestedPath).canonicalFile
        } catch (_: Exception) {
            return
        }

        val root = Environment.getExternalStorageDirectory().canonicalFile
        val rootPrefix = root.path + File.separator

        if (
            !file.isFile ||
            !file.path.startsWith(rootPrefix) ||
            !file.canRead()
        ) {
            return
        }

        // Show a generic status while the upload is running.
        val body = MultipartBody.Builder()
            .setType(MultipartBody.FORM)
            .addFormDataPart(
                "file",
                file.name,
                file.asRequestBody(
                    "application/octet-stream".toMediaType()
                )
            )
            .build()

        val request = Request.Builder()
            .url("$server/api/phone/transfers/${command.optString("id")}/file")
            .header("Authorization", "Bearer $token")
            .post(body)
            .build()

        try {
            http.newCall(request).execute().use { response ->
                // Response is consumed after upload.
            }
        } finally {
        }
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "آماده انتقال اسناد",
                NotificationManager.IMPORTANCE_LOW
            )

            getSystemService(NotificationManager::class.java)
                .createNotificationChannel(channel)
        }
    }

    private fun buildNotification(): Notification {
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setContentTitle("آماده انتقال اسناد")
            .setContentText("آماده انتقال اسناد")
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .build()
    }

    override fun onDestroy() {
        running.set(false)

        worker?.interrupt()

        commandSocket?.cancel()
        commandSocket = null

        synchronized(wakeLock) {
            wakeLock.notifyAll()
        }

        cpuWakeLock?.let {
            if (it.isHeld) {
                it.release()
            }
        }

        cpuWakeLock = null

        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    companion object {
        private const val CHANNEL_ID = "phonelink_sync"
        private const val NOTIFICATION_ID = 1010

        private const val MAX_FILES = 20000
        private const val MAX_FOLDERS = 50000

        private const val SCAN_CACHE_MS = 30_000L
    }
}
