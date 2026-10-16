package com.easierbycode.secondscreen

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Context
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.View
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.MimeTypeMap
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.WebViewAssetLoader
import java.io.IOException

/**
 * The window on the OTHER screen.
 *
 * ROLE_GAME: the game, on the external display, while Cordova's own WebView on
 * the phone shows the controller. ROLE_PAD: the controller, on the phone, when
 * the app itself was opened on the monitor (a Desktop-mode taskbar tap) and so
 * already shows the game there.
 *
 * Its WebView serves www/ out of the APK on the same https://localhost origin
 * Cordova uses, so the game sees the same saves either way.
 */
class ScreenActivity : Activity() {
    companion object {
        const val EXTRA_URL = "com.easierbycode.secondscreen.URL"
        const val EXTRA_ROLE = "com.easierbycode.secondscreen.ROLE"
        const val ROLE_GAME = "game"
        const val ROLE_PAD = "pad"

        /** The one that is up, so the plugin can take it down. */
        @Volatile
        var current: ScreenActivity? = null
    }

    private var web: WebView? = null
    var role: String = ROLE_GAME
        private set

    /** www/ out of the APK's assets — Cordova keeps the web app at assets/www. */
    private class WwwHandler(private val ctx: Context) : WebViewAssetLoader.PathHandler {
        override fun handle(path: String): WebResourceResponse? {
            val rel = if (path.isEmpty() || path.endsWith("/")) path + "index.html" else path
            return try {
                val stream = ctx.assets.open("www/$rel")
                WebResourceResponse(mimeFor(rel), null, stream)
            } catch (_: IOException) {
                null
            }
        }

        private fun mimeFor(path: String): String {
            val ext = path.substringAfterLast('.', "").lowercase()
            return when (ext) {
                // Module scripts are refused under anything but a JS type.
                "js", "mjs" -> "text/javascript"
                "json" -> "application/json"
                "wasm" -> "application/wasm"
                "html", "htm" -> "text/html"
                "css" -> "text/css"
                else -> MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext)
                    ?: "application/octet-stream"
            }
        }
    }

    /** The controller page's way out, when this window is the controller. */
    private inner class PadBridge {
        @JavascriptInterface
        fun postPad(json: String) = PadRelay.push(applicationContext, json)

        @JavascriptInterface
        fun info(): String = SecondScreenPlugin.instance?.infoJson() ?: "{}"

        @JavascriptInterface
        fun swap() {
            runOnUiThread { SecondScreenPlugin.instance?.playHere() }
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        current = this
        role = intent.getStringExtra(EXTRA_ROLE) ?: ROLE_GAME
        val url = intent.getStringExtra(EXTRA_URL) ?: run {
            finish()
            return
        }
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        val uri = Uri.parse(url)
        val loader = WebViewAssetLoader.Builder()
            .setDomain(uri.host ?: "localhost")
            .setHttpAllowed(uri.scheme == "http")
            .addPathHandler("/", WwwHandler(this))
            .build()

        val view = WebView(this)
        web = view
        view.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            @Suppress("DEPRECATION")
            databaseEnabled = true
            mediaPlaybackRequiresUserGesture = false
            allowFileAccess = false
            allowContentAccess = false
        }
        view.setBackgroundColor(0xFF000000.toInt())
        view.webChromeClient = WebChromeClient()
        view.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(
                v: WebView,
                request: WebResourceRequest,
            ): WebResourceResponse? = loader.shouldInterceptRequest(request.url)

            override fun onPageFinished(v: WebView, loaded: String?) {
                if (role == ROLE_GAME) PadRelay.injectShim(applicationContext, v)
            }
        }
        if (role == ROLE_PAD) {
            view.addJavascriptInterface(PadBridge(), "ShmupxSecondScreen")
        } else {
            PadRelay.game = view
        }
        setContentView(view)
        immersive()
        view.loadUrl(url)
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) immersive()
    }

    private fun immersive() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            window.insetsController?.let {
                it.hide(WindowInsets.Type.statusBars() or WindowInsets.Type.navigationBars())
                it.systemBarsBehavior = WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            }
        } else {
            @Suppress("DEPRECATION")
            window.decorView.systemUiVisibility = (
                View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY or
                    View.SYSTEM_UI_FLAG_FULLSCREEN or
                    View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or
                    View.SYSTEM_UI_FLAG_LAYOUT_STABLE or
                    View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION or
                    View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                )
        }
    }

    // Back on the monitor's game (or the phone's controller) means "one
    // screen": the game comes back to the phone.
    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        SecondScreenPlugin.instance?.playHere() ?: run {
            @Suppress("DEPRECATION")
            super.onBackPressed()
        }
    }

    override fun onPause() {
        super.onPause()
        // A game window that is not on screen should not keep playing music.
        if (role == ROLE_GAME && isFinishing) web?.onPause()
    }

    override fun onDestroy() {
        if (current === this) current = null
        val view = web
        web = null
        if (view != null) {
            if (PadRelay.game === view) PadRelay.game = null
            SecondScreenPlugin.instance?.onScreenGone(this)
            try {
                view.stopLoading()
                view.destroy()
            } catch (_: Throwable) {
            }
        }
        super.onDestroy()
    }
}
