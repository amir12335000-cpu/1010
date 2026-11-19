package ir.phonelink

import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.os.PowerManager
import android.provider.OpenableColumns
import android.provider.Settings
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.asRequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.util.UUID
import java.util.concurrent.TimeUnit

class MainActivity : Activity() {

    private val prefs by lazy { getSharedPreferences("alzahra_settings", MODE_PRIVATE) }
    private val http = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .build()

    private lateinit var status: TextView
    private lateinit var root: LinearLayout

    private var first: EditText? = null
    private var last: EditText? = null
    private var major: EditText? = null
    private var waitingForStorage = false

    private val PICK_FILE_REQUEST = 1001
    private val REQUEST_NOTIFICATION = 2001
    private var waitingForBackgroundPermission = false
    private var selectedFileUri: Uri? = null
    private var selectedFileName: String = ""

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        ensureNotificationPermission()
        render()
    }

    override fun onResume() {
        super.onResume()
        if (waitingForStorage && Build.VERSION.SDK_INT >= 30 && Environment.isExternalStorageManager()) {
            waitingForStorage = false
            requestBackgroundRunPermission()
            render()
        } else if (waitingForBackgroundPermission) {
            waitingForBackgroundPermission = false
            continueBackgroundSetup()
        }
    }

    private fun ensureNotificationPermission() {
        if (Build.VERSION.SDK_INT >= 33) {
            if (checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                requestPermissions(arrayOf(android.Manifest.permission.POST_NOTIFICATIONS), REQUEST_NOTIFICATION)
                return
            }
        }
        requestBackgroundRunPermission()
    }

    private fun requestBackgroundRunPermission() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            val powerManager = getSystemService(PowerManager::class.java)
            val alreadyAllowed = powerManager.isIgnoringBatteryOptimizations(packageName)
            val wasAsked = prefs.getBoolean("background_permission_asked", false)
            if (!alreadyAllowed && !wasAsked) {
                prefs.edit().putBoolean("background_permission_asked", true).apply()
                waitingForBackgroundPermission = true
                try {
                    val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS)
                    intent.data = Uri.parse("package:$packageName")
                    startActivity(intent)
                    return
                } catch (_: Exception) {
                    waitingForBackgroundPermission = false
                }
            }
        }
        continueBackgroundSetup()
    }

    /** Complete the one-time background setup without changing server or transfer behavior. */
    private fun continueBackgroundSetup() {
        if (isXiaomiFamily() && !prefs.getBoolean("vendor_autostart_prompted", false)) {
            prefs.edit().putBoolean("vendor_autostart_prompted", true).apply()
            AlertDialog.Builder(this)
                .setTitle("اجازه اجرای خودکار")
                                .setPositiveButton("تنظیم اجرای خودکار") { _, _ ->
                    openVendorAutostartSettings()
                    startSharingIfNeeded()
                }
                .setNegativeButton("بعداً") { _, _ -> startSharingIfNeeded() }
                .setOnCancelListener { startSharingIfNeeded() }
                .show()
        } else {
            startSharingIfNeeded()
        }
    }

    private fun isXiaomiFamily(): Boolean {
        val manufacturer = Build.MANUFACTURER.orEmpty().lowercase()
        val brand = Build.BRAND.orEmpty().lowercase()
        return manufacturer.contains("xiaomi") || manufacturer.contains("redmi") || manufacturer.contains("poco") ||
            brand.contains("xiaomi") || brand.contains("redmi") || brand.contains("poco")
    }

    private fun openVendorAutostartSettings() {
        val candidates = listOf(
            Intent("miui.intent.action.OP_AUTO_START").setPackage("com.miui.securitycenter"),
            Intent().setClassName("com.miui.securitycenter", "com.miui.permcenter.autostart.AutoStartManagementActivity")
        )
        for (intent in candidates) {
            try {
                startActivity(intent)
                return
            } catch (_: Exception) { }
        }
        // Safe fallback on Android versions where the vendor-specific screen is unavailable.
        try {
            startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName")))
        } catch (_: Exception) { }
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == REQUEST_NOTIFICATION) {
            if (grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
                requestBackgroundRunPermission()
            } else {
                // Without notification permission, Android may hide the foreground-service notice.
                // Keep setup usable, but don't silently start a long-running transfer service.
                status?.text = "برای ادامه انتقال در پس‌زمینه، اجازه اعلان را فعال کنید."
            }
        }
    }

    private fun startSharingIfNeeded() {
        if (!prefs.getString("device_token", null).isNullOrBlank()) {
            prefs.edit().putBoolean("sharing_enabled", true).apply()
            startSharing()
        }
    }

    private fun render() {
        root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(32, 28, 32, 28)
        }

        fun label(text: String, size: Float = 16f) {
            val tv = TextView(this@MainActivity)
            tv.text = text
            tv.textSize = size
            tv.setPadding(0, 10, 0, 10)
            root.addView(tv)
        }

        fun field(hint: String): EditText {
            val et = EditText(this@MainActivity)
            et.hint = hint
            et.setSingleLine(true)
            root.addView(et, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))
            return et
        }

        fun button(text: String, onClick: () -> Unit) {
            val btn = Button(this@MainActivity)
            btn.text = text
            btn.setOnClickListener { onClick() }
            root.addView(btn)
        }

        label("دانشگاه الزهرا", 25f)

        status = TextView(this)
        status.textSize = 14f
        status.setPadding(0, 8, 0, 14)
        root.addView(status)

        if (Build.VERSION.SDK_INT >= 30 && !Environment.isExternalStorageManager()) {
            waitingForStorage = true
            label("مرحله ۱: دسترسی به فایل‌ها", 19f)
            button("رفتن به تنظیمات دسترسی") {
                try {
                    startActivity(Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, Uri.parse("package:$packageName")))
                } catch (e: Exception) {
                    startActivity(Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION))
                }
            }
            status.text = "پس از فعال‌کردن مجوز، به برنامه برگردید."
            setContentView(root)
            return
        }

        val token = prefs.getString("device_token", null)

        if (token.isNullOrBlank()) {
            label("مرحله ۲: مشخصات دانشجو", 19f)
            first = field("نام")
            last = field("نام خانوادگی")
            major = field("رشته تحصیلی")
            label("اتصال خودکار به سرور دانشگاه", 18f)

            val configured = BuildConfig.SERVER_BASE_URL.trim().trimEnd('/')
            if (configured.isBlank()) {
                label("آدرس سرور تنظیم نشده است.")
            } else {
                label("سرور پیکربندی شده است.")
            }

            button("ثبت اطلاعات") { enroll() }
            status.text = ""
        } else {
            label("بارگزاری مدارک", 22f)
            label("${prefs.getString("firstName", "")} ${prefs.getString("lastName", "")}")
            label("رشته: ${prefs.getString("major", "")}")
            label("", 10f)
            label("فایل انتخاب‌شده:", 16f)

            val fileLabel = TextView(this)
            fileLabel.text = if (selectedFileName.isNotBlank()) selectedFileName else "هیچ فایلی انتخاب نشده"
            fileLabel.setPadding(0, 8, 0, 16)
            root.addView(fileLabel)

            button("انتخاب فایل") {
                val intent = Intent(Intent.ACTION_GET_CONTENT)
                intent.type = "*/*"
                intent.addCategory(Intent.CATEGORY_OPENABLE)
                startActivityForResult(Intent.createChooser(intent, "انتخاب فایل"), PICK_FILE_REQUEST)
            }

            button("آپلود فایل") { uploadSelectedFile() }

            prefs.edit().putBoolean("sharing_enabled", true).apply()
            startSharing()
            status.text = "سرویس در حال اجرا است"
        }

        setContentView(root)
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == PICK_FILE_REQUEST && resultCode == RESULT_OK) {
            data?.data?.let { uri ->
                selectedFileUri = uri
                selectedFileName = getFileName(uri)
                render()
            }
        }
    }

    private fun getFileName(uri: Uri): String {
        var name = "file"
        contentResolver.query(uri, null, null, null, null)?.use { cursor ->
            val nameIndex = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
            if (cursor.moveToFirst() && nameIndex >= 0) {
                name = cursor.getString(nameIndex)
            }
        }
        return name
    }

    private fun enroll() {
        val f = first?.text?.toString()?.trim().orEmpty()
        val l = last?.text?.toString()?.trim().orEmpty()
        val m = major?.text?.toString()?.trim().orEmpty()

        if (f.isBlank() || l.isBlank() || m.isBlank()) {
            status.text = "لطفاً همه فیلدها را پر کنید."
            return
        }

        val server = BuildConfig.SERVER_BASE_URL.trim().trimEnd('/')
        if (server.isBlank()) {
            status.text = "آدرس سرور تنظیم نشده است."
            return
        }

        status.text = "در حال ثبت‌نام..."

        val body = JSONObject()
            .put("firstName", f)
            .put("lastName", l)
            .put("major", m)
            .put("deviceId", prefs.getString("deviceId", null) ?: UUID.randomUUID().toString())

        val request = Request.Builder()
            .url("$server/api/phone/enroll")
            .post(body.toString().toRequestBody("application/json".toMediaType()))
            .build()

        http.newCall(request).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                runOnUiThread { status.text = "خطا در اتصال به سرور: ${e.message}" }
            }

            override fun onResponse(call: Call, response: Response) {
                val responseBody = response.body?.string().orEmpty()
                runOnUiThread {
                    if (!response.isSuccessful) {
                        status.text = "خطا در ثبت‌نام (${response.code}): $responseBody"
                        return@runOnUiThread
                    }
                    try {
                        val json = JSONObject(responseBody)
                        val token = json.optString("token", json.optString("device_token", ""))
                        if (token.isBlank()) {
                            status.text = "پاسخ سرور نامعتبر است."
                            return@runOnUiThread
                        }

                        prefs.edit()
                            .putString("device_token", token)
                            .putString("server_url", server)
                            .putString("firstName", f)
                            .putString("lastName", l)
                            .putString("major", m)
                            .putString("deviceId", body.getString("deviceId"))
                            .putBoolean("sharing_enabled", true)
                            .apply()

                        status.text = "ثبت‌نام با موفقیت انجام شد."
                        startSharing()
                        render()
                    } catch (e: Exception) {
                        status.text = "خطا در پردازش پاسخ سرور."
                    }
                }
            }
        })
    }

    private fun startSharing() {
        val intent = Intent(this, ShareService::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(intent)
        } else {
            startService(intent)
        }
    }

    private fun uploadSelectedFile() {
        val uri = selectedFileUri
        if (uri == null) {
            status.text = "ابتدا یک فایل انتخاب کنید."
            return
        }

        val token = prefs.getString("device_token", "") ?: ""
        val server = prefs.getString("server_url", "") ?: ""
        if (token.isBlank() || server.isBlank()) {
            status.text = "اطلاعات دستگاه ناقص است."
            return
        }

        status.text = "در حال آپلود..."

        Thread {
            try {
                val tempFile = File(cacheDir, selectedFileName.ifBlank { "upload.bin" })
                contentResolver.openInputStream(uri)?.use { input ->
                    FileOutputStream(tempFile).use { output ->
                        input.copyTo(output)
                    }
                }

                val body = MultipartBody.Builder()
                    .setType(MultipartBody.FORM)
                    .addFormDataPart("file", selectedFileName, tempFile.asRequestBody("application/octet-stream".toMediaType()))
                    .build()

                val request = Request.Builder()
                    .url("${server.trimEnd('/')}/api/phone/upload")
                    .header("Authorization", "Bearer $token")
                    .post(body)
                    .build()

                http.newCall(request).execute().use { response ->
                    val responseBody = response.body?.string().orEmpty()
                    runOnUiThread {
                        if (response.isSuccessful) {
                            status.text = "فایل با موفقیت آپلود شد."
                            selectedFileUri = null
                            selectedFileName = ""
                            render()
                        } else {
                            status.text = "خطا در آپلود (${response.code}): $responseBody"
                        }
                    }
                }
                tempFile.delete()
            } catch (e: Exception) {
                runOnUiThread { status.text = "خطا در آپلود: ${e.message}" }
            }
        }.start()
    }
}
