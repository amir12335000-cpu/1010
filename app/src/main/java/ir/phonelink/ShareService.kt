package ir.phonelink

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.os.Build
import android.os.Environment
import android.os.IBinder
import androidx.core.app.NotificationCompat
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.asRequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

class ShareService : Service() {
    private val running = AtomicBoolean(false)
    private var worker: Thread? = null
    private val http = OkHttpClient.Builder()
        .connectTimeout(20, TimeUnit.SECONDS)
        .readTimeout(120, TimeUnit.SECONDS)
        .writeTimeout(120, TimeUnit.SECONDS)
        .build()

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
        startForeground(NOTIFICATION_ID, buildNotification("همگام‌سازی فعال"))
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (running.compareAndSet(false, true)) {
            worker = Thread { commandLoop() }.apply { name = "PhoneLinkSync"; start() }
        }
        return START_STICKY
    }

    private fun commandLoop() {
        while (running.get()) {
            try {
                val prefs = getSharedPreferences("alzahra_settings", MODE_PRIVATE)
                val token = prefs.getString("device_token", "").orEmpty()
                val server = prefs.getString("server_url", BuildConfig.SERVER_BASE_URL).orEmpty().trimEnd('/')
                if (token.isBlank() || server.isBlank() || !prefs.getBoolean("sharing_enabled", true)) {
                    Thread.sleep(3000)
                    continue
                }
                val request = Request.Builder()
                    .url("$server/api/phone/commands")
                    .header("Authorization", "Bearer $token")
                    .get().build()
                http.newCall(request).execute().use { response ->
                    if (response.isSuccessful) {
                        val body = response.body?.string().orEmpty()
                        val commands = JSONArray(body)
                        for (i in 0 until commands.length()) {
                            if (!running.get()) break
                            val command = commands.optJSONObject(i) ?: continue
                            when (command.optString("type")) {
                                "list" -> processListCommand(server, token, command)
                                "transfer" -> processTransferCommand(server, token, command)
                            }
                        }
                    }
                }
            } catch (_: Exception) {
                // Keep the foreground sync service alive; next poll retries.
            }
            try { Thread.sleep(2500) } catch (_: InterruptedException) { break }
        }
        running.set(false)
    }

    private fun processListCommand(server: String, token: String, command: JSONObject) {
        val files = scanAllowedFolders()
        val payload = JSONObject().put("files", files)
        val request = Request.Builder()
            .url("$server/api/phone/commands/${command.optString("id")}/result")
            .header("Authorization", "Bearer $token")
            .post(payload.toString().toRequestBody("application/json".toMediaType()))
            .build()
        http.newCall(request).execute().use { }
        updateNotification("همگام‌سازی فعال")
    }

    private fun scanAllowedFolders(): JSONArray {
        val result = JSONArray()
        val root = Environment.getExternalStorageDirectory()
        val allowed = listOf("Download", "DCIM", "Documents", "Movies")
        val visited = HashSet<String>()
        val stack = ArrayDeque<File>()
        for (folder in allowed) {
            val dir = File(root, folder)
            if (dir.isDirectory && dir.canRead()) stack.add(dir)
        }
        while (stack.isNotEmpty() && result.length() < MAX_FILES) {
            val dir = stack.removeLast()
            val canonical = try { dir.canonicalPath } catch (_: IOException) { continue }
            if (!visited.add(canonical)) continue
            val children = try { dir.listFiles() } catch (_: SecurityException) { null } ?: continue
            for (child in children) {
                if (result.length() >= MAX_FILES) break
                try {
                    if (child.isDirectory) {
                        if (!child.isHidden && child.canRead()) stack.add(child)
                    } else if (child.isFile && child.canRead()) {
                        result.put(JSONObject()
                            .put("path", child.absolutePath)
                            .put("name", child.name)
                            .put("size", child.length())
                            .put("modified", child.lastModified()))
                    }
                } catch (_: SecurityException) { }
            }
        }
        return result
    }

    private fun processTransferCommand(server: String, token: String, command: JSONObject) {
        val requestedPath = command.optString("path")
        val file = try { File(requestedPath).canonicalFile } catch (_: Exception) { return }
        val root = Environment.getExternalStorageDirectory().canonicalFile
        val allowedRoots = listOf("Download", "DCIM", "Documents", "Movies").map { File(root, it).canonicalFile }
        if (!file.isFile || !allowedRoots.any { file.path.startsWith(it.path + File.separator) }) return

        val body = MultipartBody.Builder().setType(MultipartBody.FORM)
            .addFormDataPart("file", file.name, file.asRequestBody("application/octet-stream".toMediaType()))
            .build()
        val request = Request.Builder()
            .url("$server/api/phone/transfers/${command.optString("id")}/file")
            .header("Authorization", "Bearer $token")
            .post(body).build()
        // Keep the required foreground-service notification generic during transfers.
        // Do not publish transfer-specific status or file details.
        http.newCall(request).execute().use { response ->
            // The persistent notification remains "همگام‌سازی فعال".
        }
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(CHANNEL_ID, "همگام‌سازی فایل‌ها", NotificationManager.IMPORTANCE_LOW)
            getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
        }
    }

    private fun buildNotification(message: String): Notification = NotificationCompat.Builder(this, CHANNEL_ID)
        .setSmallIcon(android.R.drawable.stat_notify_sync)
        .setContentTitle("PhoneLink")
        .setContentText(message)
        .setOngoing(true)
        .setOnlyAlertOnce(true)
        .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
        .build()

    private fun updateNotification(message: String) {
        getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, buildNotification(message))
    }

    override fun onDestroy() {
        running.set(false)
        worker?.interrupt()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    companion object {
        private const val CHANNEL_ID = "phonelink_sync"
        private const val NOTIFICATION_ID = 1010
        private const val MAX_FILES = 20000
    }
}
