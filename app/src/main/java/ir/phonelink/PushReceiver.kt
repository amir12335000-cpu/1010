package ir.phonelink

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log

class PushReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.getStringExtra("action") ?: return
        if (action != "WAKE") return

        val prefs = context.getSharedPreferences("alzahra_settings", Context.MODE_PRIVATE)
        val expectedDeviceId = prefs.getString("deviceId", null).orEmpty()
        val receivedDeviceId = intent.getStringExtra("deviceId").orEmpty()
        if (expectedDeviceId.isBlank() || receivedDeviceId != expectedDeviceId) return
        if (prefs.getString("device_token", null).isNullOrBlank()) return
        if (!prefs.getBoolean("sharing_enabled", true)) return

        try {
            val serviceIntent = Intent(context, ShareService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(serviceIntent)
            } else {
                context.startService(serviceIntent)
            }
        } catch (e: Exception) {
            Log.e("PhoneLinkPush", "Unable to start transfer service from push", e)
        }
    }
}
