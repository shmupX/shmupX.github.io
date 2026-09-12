package com.easierbycode.spriteshare

import android.app.Activity
import android.content.ContentUris
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.provider.MediaStore
import android.util.Base64
import android.util.Log
import android.util.TypedValue
import android.view.Gravity
import android.webkit.JavascriptInterface
import android.webkit.ConsoleMessage
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.TextView
import android.widget.Toast
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileOutputStream
import java.io.PrintWriter
import java.io.StringWriter
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlin.math.roundToInt
import kotlin.math.sqrt

/**
 * Activity that receives shared images via ACTION_SEND intent,
 * loads a WebView-based sprite picker UI, and lets the user
 * detect / select / repack sprites into game atlases.
 */
class SpriteShareActivity : Activity() {

    private var webView: WebView? = null
    private var sharedImageFile: File? = null
    private var tempSourceFile: File? = null

    // ── attachBaseContext runs before any other Activity lifecycle hook, before
    //    super.onCreate, before WebView class load. Earliest place we can install
    //    a process-wide crash handler so a force-close anywhere in this Activity
    //    leaves an evilinvaders-spriteshare-crash.txt on disk.
    //
    //    When the user shares an image without first launching the main app, the
    //    MainActivity diagnostics never run, so we install our own here.
    override fun attachBaseContext(newBase: Context) {
        try { diagAppendCtx(newBase, "SHARE_ATTACH") } catch (_: Throwable) {}
        try { installCrashHandler(newBase) } catch (_: Throwable) {}
        super.attachBaseContext(newBase)
        try { diagAppendCtx(newBase, "SHARE_ATTACH_DONE") } catch (_: Throwable) {}
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        appendShareDiag("SHARE_PRE_SUPER")
        super.onCreate(savedInstanceState)
        appendShareDiag("SHARE_POST_SUPER")
        try { Toast.makeText(this, "SpriteShare OK", Toast.LENGTH_SHORT).show() } catch (_: Throwable) {}
        showStatusView("Loading shared image...")
        appendShareDiag("SHARE_STATUS_SHOWN action=${intent?.action ?: "(none)"} type=${intent?.type ?: "(none)"}")

        try {
            // Save the shared image to a temp file — avoids passing multi-MB
            // base64 through evaluateJavascript (crashes WebView) or the
            // @JavascriptInterface bridge (Binder TransactionTooLargeException).
            sharedImageFile = saveSharedImageToFile()
            appendShareDiag("SHARE_IMG_LOADED ok=${sharedImageFile != null}")
            if (sharedImageFile == null) {
                Log.e(TAG, "Failed to read shared image from intent")
                showFatalError("Could not read the shared image.", null)
                return
            }

            val imagePath = "file://${sharedImageFile!!.absolutePath}"
                .replace("\\", "\\\\")
                .replace("'", "\\'")
                .replace("\n", "")

            // Set up the WebView
            val wv = WebView(this)
            webView = wv
            appendShareDiag("SHARE_WEBVIEW_CREATED")

            wv.settings.javaScriptEnabled = true
            wv.settings.domStorageEnabled = true
            @Suppress("DEPRECATION")
            wv.settings.allowFileAccess = true
            @Suppress("DEPRECATION")
            wv.settings.allowFileAccessFromFileURLs = true
            @Suppress("DEPRECATION")
            wv.settings.allowUniversalAccessFromFileURLs = true
            wv.settings.useWideViewPort = true
            wv.settings.loadWithOverviewMode = true
            wv.settings.builtInZoomControls = true
            wv.settings.displayZoomControls = false

            wv.addJavascriptInterface(SpriteShareBridge(), "Android")

            wv.webChromeClient = object : WebChromeClient() {
                override fun onConsoleMessage(consoleMessage: ConsoleMessage?): Boolean {
                    if (consoleMessage != null) {
                        Log.d(
                            TAG,
                            "JS ${consoleMessage.messageLevel()}: ${consoleMessage.message()} " +
                                "@${consoleMessage.sourceId()}:${consoleMessage.lineNumber()}"
                        )
                    }
                    return super.onConsoleMessage(consoleMessage)
                }
            }
            wv.webViewClient = object : WebViewClient() {
                override fun onPageFinished(view: WebView?, url: String?) {
                    super.onPageFinished(view, url)
                    // Pass only the short file path — the WebView loads the
                    // image directly from the filesystem.
                    view?.evaluateJavascript(
                        "if(typeof receiveSharedImage==='function')receiveSharedImage('$imagePath')",
                        null
                    )
                }

                override fun onReceivedError(
                    view: WebView?,
                    request: WebResourceRequest?,
                    error: WebResourceError?
                ) {
                    super.onReceivedError(view, request, error)
                    if (request?.isForMainFrame == true) {
                        val description = error?.description?.toString() ?: "unknown error"
                        Log.e(TAG, "WebView failed to load: $description")
                        showFatalError("Failed to load the Sprite Share UI.", null)
                    }
                }

                override fun onRenderProcessGone(
                    view: WebView?,
                    detail: RenderProcessGoneDetail?
                ): Boolean {
                    Log.e(TAG, "WebView render process gone. didCrash=${detail?.didCrash()}")
                    webView?.destroy()
                    webView = null
                    showFatalError("The Sprite Share WebView crashed while loading the image.", null)
                    return true
                }
            }

            setContentView(wv)
            appendShareDiag("SHARE_PRE_LOADURL")
            wv.loadUrl("file:///android_asset/www/sprite-share/sprite-picker.html")
            appendShareDiag("SHARE_POST_LOADURL")
        } catch (e: Exception) {
            Log.e(TAG, "onCreate failed", e)
            appendShareDiag("SHARE_ONCREATE_EXCEPTION ${e::class.java.simpleName}: ${e.message}")
            showFatalError("Sprite Share failed during startup.", e)
        } catch (t: Throwable) {
            Log.e(TAG, "onCreate failed with fatal error", t)
            appendShareDiag("SHARE_ONCREATE_THROWABLE ${t::class.java.simpleName}: ${t.message}")
            showFatalError("Sprite Share hit a fatal error during startup.", t)
        }
    }

    /**
     * Save the shared image to a temp file and return the File handle.
     */
    private fun saveSharedImageToFile(): File? {
        val imageUri: Uri = getImageUri() ?: return null

        return try {
            val sourceFile = copySharedImageToTempFile(imageUri) ?: return null
            tempSourceFile = sourceFile
            val normalizedFile = File(cacheDir, "shared_sprite_input.png")

            when (saveSharedImageBitmapToFile(sourceFile, normalizedFile)) {
                SaveResult.SUCCESS -> {
                    try { sourceFile.delete() } catch (_: Exception) {}
                    tempSourceFile = null
                    normalizedFile
                }
                SaveResult.DECODE_FAILED -> {
                    sourceFile
                }
                SaveResult.OUT_OF_MEMORY -> {
                    Log.e(TAG, "Shared image was too large to decode safely")
                    null
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to save shared image", e)
            null
        }
    }

    private fun copySharedImageToTempFile(imageUri: Uri): File? {
        val sourceFile = File(cacheDir, "shared_sprite_input_source.img")
        return if (copySharedImageToFile(imageUri, sourceFile)) sourceFile else null
    }

    private fun saveSharedImageBitmapToFile(sourceFile: File, outputFile: File): SaveResult {
        return try {
            val bounds = BitmapFactory.Options().apply {
                inJustDecodeBounds = true
            }
            BitmapFactory.decodeFile(sourceFile.absolutePath, bounds)

            if (bounds.outWidth <= 0 || bounds.outHeight <= 0) {
                return SaveResult.DECODE_FAILED
            }

            val decodeOptions = BitmapFactory.Options().apply {
                inSampleSize = calculateInSampleSize(bounds.outWidth, bounds.outHeight)
                inPreferredConfig = Bitmap.Config.ARGB_8888
            }

            val decoded = BitmapFactory.decodeFile(sourceFile.absolutePath, decodeOptions)
                ?: return SaveResult.DECODE_FAILED

            val scaled = scaleBitmapIfNeeded(decoded)

            FileOutputStream(outputFile).use { out ->
                if (!scaled.compress(Bitmap.CompressFormat.PNG, 100, out)) {
                    if (scaled !== decoded) scaled.recycle()
                    decoded.recycle()
                    return SaveResult.DECODE_FAILED
                }
            }

            if (scaled !== decoded) scaled.recycle()
            decoded.recycle()
            SaveResult.SUCCESS
        } catch (oom: OutOfMemoryError) {
            SaveResult.OUT_OF_MEMORY
        } catch (e: Exception) {
            Log.w(TAG, "Falling back to raw shared image copy", e)
            SaveResult.DECODE_FAILED
        }
    }

    private fun copySharedImageToFile(imageUri: Uri, outputFile: File): Boolean {
        return try {
            contentResolver.openInputStream(imageUri)?.use { input ->
                FileOutputStream(outputFile).use { out ->
                    val chunk = ByteArray(8192)
                    var bytesRead: Int
                    while (input.read(chunk).also { bytesRead = it } != -1) {
                        out.write(chunk, 0, bytesRead)
                    }
                }
            } ?: false
        } catch (e: Exception) {
            Log.e(TAG, "Failed to copy shared image", e)
            false
        }
    }

    private fun calculateInSampleSize(width: Int, height: Int): Int {
        var sampleSize = 1
        while (maxOf(width, height) / sampleSize > MAX_IMAGE_DIMENSION ||
            (width.toLong() / sampleSize) * (height.toLong() / sampleSize) > MAX_IMAGE_PIXELS) {
            sampleSize *= 2
        }
        return sampleSize.coerceAtLeast(1)
    }

    private fun scaleBitmapIfNeeded(bitmap: Bitmap): Bitmap {
        val largest = maxOf(bitmap.width, bitmap.height)
        val totalPixels = bitmap.width.toLong() * bitmap.height.toLong()
        if (largest <= MAX_IMAGE_DIMENSION && totalPixels <= MAX_IMAGE_PIXELS) {
            return bitmap
        }

        val dimensionScale = MAX_IMAGE_DIMENSION.toFloat() / largest.toFloat()
        val pixelScale = sqrt(MAX_IMAGE_PIXELS.toDouble() / totalPixels.toDouble()).toFloat()
        val scale = minOf(1f, dimensionScale, pixelScale)
        val scaledWidth = (bitmap.width * scale).roundToInt().coerceAtLeast(1)
        val scaledHeight = (bitmap.height * scale).roundToInt().coerceAtLeast(1)
        return Bitmap.createScaledBitmap(bitmap, scaledWidth, scaledHeight, false)
    }

    private fun showStatusView(message: String) {
        val root = FrameLayout(this).apply {
            setBackgroundColor(Color.parseColor("#10142A"))
        }
        val textView = TextView(this).apply {
            text = message
            setTextColor(Color.WHITE)
            gravity = Gravity.CENTER
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 18f)
            setPadding(48, 48, 48, 48)
        }
        root.addView(
            textView,
            FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT
            )
        )
        setContentView(root)
    }

    private fun showFatalError(message: String, error: Throwable?) {
        val details = buildString {
            append(message)
            append("\n\n")
            append("Action: ")
            append(intent?.action ?: "(none)")
            append("\nType: ")
            append(intent?.type ?: "(none)")
            append("\nUri: ")
            append(getImageUri()?.toString() ?: "(none)")
            if (error != null) {
                append("\n\n")
                append(error::class.java.simpleName)
                append(": ")
                append(error.message ?: "(no message)")
            }
        }
        showStatusView(details)
    }

    /**
     * Extract the shared image URI from the intent, trying multiple sources.
     */
    private fun getImageUri(): Uri? {
        val shareAction = intent?.action
        if (shareAction != Intent.ACTION_SEND &&
            shareAction != Intent.ACTION_SEND_MULTIPLE &&
            shareAction != Intent.ACTION_VIEW) {
            Log.w(TAG, "Unexpected share intent action: $shareAction")
        }

        // 1. EXTRA_STREAM (standard share path)
        val fromExtra: Uri? = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
        } else {
            @Suppress("DEPRECATION")
            intent.getParcelableExtra(Intent.EXTRA_STREAM) as? Uri
        }
        if (fromExtra != null) return fromExtra

        // 1b. EXTRA_STREAM as a list (some apps send ACTION_SEND_MULTIPLE)
        val fromExtraList: List<Uri>? = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java)
        } else {
            @Suppress("DEPRECATION")
            intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM)
        }
        if (!fromExtraList.isNullOrEmpty()) {
            return fromExtraList.firstOrNull()
        }

        // 2. ClipData (some apps use this instead of EXTRA_STREAM)
        val clip = intent.clipData
        if (clip != null && clip.itemCount > 0) {
            val uri = clip.getItemAt(0).uri
            if (uri != null) return uri
        }

        // 3. Intent data URI
        return intent.data
    }

    /**
     * JavaScript bridge exposed as `Android.*` in the WebView.
     */
    inner class SpriteShareBridge {

        @JavascriptInterface
        fun getAtlasJson(atlasName: String): String {
            val internalFile = File(filesDir, "assets/_${atlasName}.json")
            if (internalFile.exists()) {
                return internalFile.readText()
            }
            return try {
                assets.open("www/assets/$atlasName.json").bufferedReader().readText()
            } catch (e: Exception) {
                try {
                    assets.open("www/assets/${atlasName}.json").bufferedReader().readText()
                } catch (e2: Exception) {
                    "{\"frames\":{},\"meta\":{}}"
                }
            }
        }

        @JavascriptInterface
        fun getAtlasImageBase64(atlasName: String): String {
            val internalFile = File(filesDir, "assets/img/_${atlasName}.png")
            if (internalFile.exists()) {
                val bytes = internalFile.readBytes()
                val base64 = Base64.encodeToString(bytes, Base64.NO_WRAP)
                return "data:image/png;base64,$base64"
            }
            return try {
                val inputStream = assets.open("www/assets/img/$atlasName.png")
                val buffer = ByteArrayOutputStream()
                val chunk = ByteArray(8192)
                var bytesRead: Int
                while (inputStream.read(chunk).also { bytesRead = it } != -1) {
                    buffer.write(chunk, 0, bytesRead)
                }
                inputStream.close()
                val base64 = Base64.encodeToString(buffer.toByteArray(), Base64.NO_WRAP)
                "data:image/png;base64,$base64"
            } catch (e: Exception) {
                ""
            }
        }

        @JavascriptInterface
        fun saveAtlas(atlasName: String, pngBase64: String, jsonString: String): Boolean {
            return try {
                val imgDir = File(filesDir, "assets/img")
                imgDir.mkdirs()
                val jsonDir = File(filesDir, "assets")
                jsonDir.mkdirs()

                val pngData = pngBase64.substringAfter("base64,", pngBase64)
                val pngBytes = Base64.decode(pngData, Base64.DEFAULT)
                FileOutputStream(File(imgDir, "_${atlasName}.png")).use { it.write(pngBytes) }

                FileOutputStream(File(jsonDir, "_${atlasName}.json")).use {
                    it.write(jsonString.toByteArray())
                }

                true
            } catch (e: Exception) {
                Log.e(TAG, "Failed to save atlas", e)
                false
            }
        }

        @JavascriptInterface
        fun hasRepackedAtlas(atlasName: String): Boolean {
            val jsonFile = File(filesDir, "assets/_${atlasName}.json")
            val pngFile = File(filesDir, "assets/img/_${atlasName}.png")
            return jsonFile.exists() && pngFile.exists()
        }

        @JavascriptInterface
        fun closeActivity() {
            runOnUiThread { finish() }
        }
    }

    @Suppress("DEPRECATION")
    override fun onBackPressed() {
        val wv = webView
        if (wv != null && wv.canGoBack()) {
            wv.goBack()
        } else {
            super.onBackPressed()
        }
    }

    override fun onDestroy() {
        webView?.destroy()
        webView = null
        try { sharedImageFile?.delete() } catch (_: Exception) {}
        try { tempSourceFile?.delete() } catch (_: Exception) {}
        super.onDestroy()
    }

    // ── On-device diagnostics ────────────────────────────────────────────
    // Mirrors the MainActivity launch-log / crash-log pattern but with
    // SpriteShare-specific filenames so the two activities don't overwrite
    // each other's logs. Files appear in Files app → Downloads on API 29+.

    private fun appendShareDiag(marker: String) = diagAppendCtx(this, marker)

    private fun diagAppendCtx(ctx: Context, marker: String) {
        try {
            val ts = SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.US).format(Date())
            val line = "[$ts] $marker\n"
            try { File(ctx.cacheDir, "spriteshare-log.txt").appendText(line) } catch (_: Throwable) {}
            try {
                ctx.getExternalFilesDir(null)?.let { File(it, "spriteshare-log.txt").appendText(line) }
            } catch (_: Throwable) {}
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                try { mediaStoreAppend(ctx, SHARE_LOG_DOWNLOAD_NAME, line) } catch (_: Throwable) {}
            } else {
                try {
                    @Suppress("DEPRECATION")
                    val dl = File(Environment.getExternalStorageDirectory(), "Download/EvilInvadersForge")
                    dl.mkdirs()
                    File(dl, "spriteshare-log.txt").appendText(line)
                } catch (_: Throwable) {}
            }
        } catch (_: Throwable) {}
    }

    private fun mediaStoreAppend(ctx: Context, displayName: String, text: String) {
        val resolver = ctx.contentResolver
        val collection = MediaStore.Downloads.EXTERNAL_CONTENT_URI
        val projection = arrayOf(MediaStore.Downloads._ID)
        val selection = MediaStore.Downloads.DISPLAY_NAME + " = ?"
        val args = arrayOf(displayName)

        var existing: Uri? = null
        try {
            resolver.query(collection, projection, selection, args, null)?.use { c ->
                if (c.moveToFirst()) existing = ContentUris.withAppendedId(collection, c.getLong(0))
            }
        } catch (_: Throwable) {}

        val target = existing ?: run {
            val values = ContentValues().apply {
                put(MediaStore.Downloads.DISPLAY_NAME, displayName)
                put(MediaStore.Downloads.MIME_TYPE, "text/plain")
                put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS)
            }
            resolver.insert(collection, values) ?: return
        }
        resolver.openOutputStream(target, "wa")?.use { it.write(text.toByteArray()) }
    }

    private fun mediaStoreOverwrite(ctx: Context, displayName: String, text: String) {
        val resolver = ctx.contentResolver
        val collection = MediaStore.Downloads.EXTERNAL_CONTENT_URI
        val projection = arrayOf(MediaStore.Downloads._ID)
        val selection = MediaStore.Downloads.DISPLAY_NAME + " = ?"
        val args = arrayOf(displayName)

        var existing: Uri? = null
        try {
            resolver.query(collection, projection, selection, args, null)?.use { c ->
                if (c.moveToFirst()) existing = ContentUris.withAppendedId(collection, c.getLong(0))
            }
        } catch (_: Throwable) {}

        val target = existing ?: run {
            val values = ContentValues().apply {
                put(MediaStore.Downloads.DISPLAY_NAME, displayName)
                put(MediaStore.Downloads.MIME_TYPE, "text/plain")
                put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS)
            }
            resolver.insert(collection, values) ?: return
        }
        resolver.openOutputStream(target, "wt")?.use { it.write(text.toByteArray()) }
    }

    // Installs a process-wide UncaughtExceptionHandler so a crash anywhere in
    // SpriteShareActivity (including super.onCreate, WebView class load, etc.)
    // writes a stack trace to disk before the process dies.
    private fun installCrashHandler(ctx: Context) {
        try {
            val previous = Thread.getDefaultUncaughtExceptionHandler()
            Thread.setDefaultUncaughtExceptionHandler { thread, throwable ->
                try {
                    val sw = StringWriter()
                    val ts = SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.US).format(Date())
                    sw.write("CRASH at $ts on thread ${thread.name}\n\n")
                    throwable.printStackTrace(PrintWriter(sw))
                    val text = sw.toString()
                    Log.e(TAG, text)
                    try { File(ctx.cacheDir, "spriteshare-crash.txt").writeText(text) } catch (_: Throwable) {}
                    try {
                        ctx.getExternalFilesDir(null)?.let { File(it, "spriteshare-crash.txt").writeText(text) }
                    } catch (_: Throwable) {}
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                        try { mediaStoreOverwrite(ctx, SHARE_CRASH_DOWNLOAD_NAME, text) } catch (_: Throwable) {}
                    } else {
                        try {
                            @Suppress("DEPRECATION")
                            val dl = File(Environment.getExternalStorageDirectory(), "Download/EvilInvadersForge")
                            dl.mkdirs()
                            File(dl, "spriteshare-crash.txt").writeText(text)
                        } catch (_: Throwable) {}
                    }
                } catch (_: Throwable) {}
                previous?.uncaughtException(thread, throwable)
            }
        } catch (_: Throwable) {}
    }

    companion object {
        private const val TAG = "SpriteShare"
        private const val MAX_IMAGE_DIMENSION = 1536
        private const val MAX_IMAGE_PIXELS = 1_250_000L
        private const val SHARE_LOG_DOWNLOAD_NAME = "evilinvaders-spriteshare-log.txt"
        private const val SHARE_CRASH_DOWNLOAD_NAME = "evilinvaders-spriteshare-crash.txt"
    }

    private enum class SaveResult {
        SUCCESS,
        DECODE_FAILED,
        OUT_OF_MEMORY
    }
}
