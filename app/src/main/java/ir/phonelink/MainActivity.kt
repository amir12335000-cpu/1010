package ir.phonelink

import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.provider.OpenableColumns
import android.provider.Settings
import android.widget.*
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.asRequestBody
import okhttp3.RequestBody.Companion.toRequestBody
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
