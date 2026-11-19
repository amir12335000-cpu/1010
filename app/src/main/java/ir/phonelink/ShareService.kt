package ir.phonelink

import android.app.*
import android.content.Intent
import android.os.*
import android.os.Environment
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
    private val http = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .build()
    private val prefs by lazy { getSharedPreferences("alzahra_settings", MODE_PRIVATE) }

    private val CHANNEL_ID = "alzahra_share"
    private val NOTIF_ID = 1010

    private val poll = object : Runnable {
        override fun run() {
            if (prefs.getBoolean("sharing_enabled", false)) {
                pollCommands()
                handler.postDelayed(this, 5000)
            } else {
                stopSelf()
            }
        }
    }

    override fun onBind(intent: Intent?) = null

    override fun onCreate() {
        super.onCreate()
        createChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("اشتراک‌گذاری فایل")
            .setContentText("در حال اجرا")
            .setSmallIcon(android.R.drawable.stat_sys_upload)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setOngoing(true)
            .setSilent(true)
            .setShowWhen(false)
            .build()

        startForeground(NOTIF_ID, notification)

        handler.removeCallbacks(poll)
        handler.post(poll)
        return START_STICKY
    }

    override fun onDestroy() {
        handler.removeCallbacks(poll)
        http.dispatcher.cancelAll()
        super.onDestroy()
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "اشتراک‌گذاری",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "سرویس انتقال فایل"
                setShowBadge(false)
                enableLights(false)
                enableVibration(false)
                setSound(null, null)
            }
            getSystemService(NotificationManager::class.java)
                .createNotificationChannel(channel)
        }
    }

    private fun base() = (prefs.getString("server_url", "") ?: "").trimEnd('/')

    private fun 
