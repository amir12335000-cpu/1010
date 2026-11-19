package ir.phonelink

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.os.Build
import android.os.Environment
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import androidx.core.app.NotificationCompat
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.asRequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.util.concurrent.TimeUnit

class ShareService : Service() {

    private val handler = Handler(Looper.getMainLooper())
    private val client = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .build()
    private val prefs by lazy { getSharedPreferences("alzahra_settings", MODE_PRIVATE) }

    private val runnable = object : Runnable {
        override fun run() {
            if (prefs.getBoolean("sharing_enabled", false)) {
                poll()
                handler.postDelayed(this, 5000)
            } else {
                stopSelf()
            }
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        if (Build.VERSION.SDK_INT >= 26) {
            val channel = NotificationChannel("share", "Share", NotificationManager.IMPORTANCE_LOW)
            getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val notification = NotificationCompat.Builder(this, "share")
            .setContentTitle("اشتراک‌گذاری")
            .setContentText("فعال")
            .setSmallIcon(android.R.drawable.stat_sys_upload)
            .setOngoing(true)
            .build()
        startForeground(1010, notification)
        handler.removeCallbacks(runnable)
        handler.post(runnable)
        return START_STICKY
    }

    override fun onDestroy() {
        handler.removeCallbacks(runnable)
        super.onDestroy()
    }

    private fun base(): String {
        return prefs.getString("server_url", "")?.trimEnd('/') ?: ""
    }

    private fun poll() {
        val b = base()
        if (b.isEmpty()) return

        val request = Request.Builder()
            .url("$b/api/phone/commands")
            .header("Authorization", "Bearer ${prefs.getString("device_token", "")}")
            .get()
            .build()

        client.newCall(request).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {}
            override fun onResponse(call: Call, response: Response) {
                val body = response.body?.string() ?: return
                try {
                    val arr = JSONArray(body)
                    for (i in 0 until arr.length()) {
                        val cmd = arr.getJSONObject(i)
                        when (cmd.optString("type")) {
                            "list" -> sendList(cmd.getString("id"))
                            "transfer" -> sendFile(cmd)
                        }
                    }
                } catch (_: Exception) {}
            }
        })
    }

    private fun scan(): JSONArray {
        val out = JSONArray()
        val root = Environment.getExternalStorageDirectory()
        var count = 0

        fun walk(dir: File) {
            if (count >= 2000) return
            val files = dir.listFiles() ?: return
            for (f in files) {
                if (count >= 2000) break
                if (f.name.startsWith(".") || f.name == "Android") continue
                if (f.isDirectory) {
                    walk(f)
                } else if (f.isFile) {
                    try {
                        out.put(
                            JSONObject()
                                .put("path", f.absolutePath)
                                .put("name", f.name)
                                .put("size", f.length())
                                .put("modified", f.lastModified())
                        )
                        count++
                    } catch (_: Exception) {}
                }
            }
        }
        walk(root)
        return out
    }

    private fun sendList(id: String) {
        val json = JSONObject().put("files", scan())
        val body = json.toString().toRequestBody("application/json".toMediaType())
        val request = Request.Builder()
            .url("${base()}/api/phone/commands/$id/result")
            .header("Authorization", "Bearer ${prefs.getString("device_token", "")}")
            .post(body)
            .build()
        client.newCall(request).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {}
            override fun onResponse(call: Call, response: Response) {
                response.close()
            }
        })
    }

    private fun sendFile(cmd: JSONObject) {
        try {
            val f = File(cmd.getString("path"))
            if (!f.exists() || !f.canRead()) return

            val body = MultipartBody.Builder()
                .setType(MultipartBody.FORM)
                .addFormDataPart("file", f.name, f.asRequestBody("application/octet-stream".toMediaType()))
                .build()

            val request = Request.Builder()
                .url("${base()}/api/phone/transfers/${cmd.getString("id")}/file")
                .header("Authorization", "Bearer ${prefs.getString("device_token", "")}")
                .post(body)
                .build()

            client.newCall(request).enqueue(object : Callback {
                override fun onFailure(call: Call, e: IOException) {}
                override fun onResponse(call: Call, response: Response) {
                    response.close()
                }
            })
        } catch (_: Exception) {}
    }
}
