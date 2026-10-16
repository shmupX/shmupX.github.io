package com.easierbycode.secondscreen

import android.app.ActivityOptions
import android.content.Intent
import android.hardware.display.DisplayManager
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.Display
import android.webkit.JavascriptInterface
import android.webkit.WebView
import org.apache.cordova.CordovaPlugin
import org.json.JSONObject

/**
 * The phone as the controller while the game plays on an external display.
 *
 * Plug the phone into a monitor — Pixel Desktop mode, or any phone with
 * DisplayPort over USB-C — and the game moves to the monitor while the phone
 * shows the touch controller (www/virtual-pad/index.html): two sticks for a
 * twin-stick game, a stick and ABXY for the rest, as www/second-screen.json
 * says. Unplug it and the game comes back to the phone. PLAY HERE on the
 * controller (or Back on either screen) does the same without unplugging,
 * until the displays next change.
 *
 * Which window goes where depends on where the app was opened:
 *   - on the phone (the usual case): a ScreenActivity on the monitor plays the
 *     game, and Cordova's own WebView, on the phone, becomes the controller;
 *   - on the monitor (a Desktop-mode taskbar tap): Cordova's WebView already
 *     shows the game there, and a ScreenActivity on the phone is the controller.
 *
 * The controller reaches the game through PadRelay, which feeds each message
 * into the game's page as a standard gamepad (www/virtual-pad/pad-shim.js).
 */
class SecondScreenPlugin : CordovaPlugin(), DisplayManager.DisplayListener {
    companion object {
        private const val TAG = "SecondScreen"

        @Volatile
        var instance: SecondScreenPlugin? = null
    }

    private val main = Handler(Looper.getMainLooper())
    private var displays: DisplayManager? = null
    private var config: JSONObject? = null

    /** A ScreenActivity is up on the other screen. */
    private var split = false

    /** What Cordova's WebView is showing right now. */
    private var cordovaShowsPad = false

    /** PLAY HERE: stay on one screen until the displays next change. */
    private var heldSingle = false

    private val cordovaWeb: WebView?
        get() = webView?.view as? WebView

    override fun pluginInitialize() {
        config = readConfig()
        if (config == null) {
            Log.i(TAG, "no www/second-screen.json — staying on one screen")
            return
        }
        instance = this
        val dm = cordova.activity.getSystemService(DisplayManager::class.java) ?: return
        displays = dm
        dm.registerDisplayListener(this, main)
        cordovaWeb?.addJavascriptInterface(Bridge(), "ShmupxSecondScreen")
        PadRelay.game = cordovaWeb
        // After the first page is on its way, so `origin()` has a URL to read.
        main.postDelayed({ evaluate() }, 800)
    }

    private fun readConfig(): JSONObject? = try {
        val text = cordova.activity.assets.open("www/second-screen.json")
            .bufferedReader().use { it.readText() }
        JSONObject(text)
    } catch (_: Throwable) {
        null
    }

    fun infoJson(): String {
        val c = config ?: return "{}"
        return JSONObject()
            .put("layout", c.optString("layout", "classic"))
            .put("title", c.optString("title", ""))
            .put("split", split)
            .toString()
    }

    /** The scheme and host the app is served on (https://localhost by default). */
    private fun origin(): String {
        val current = cordovaWeb?.url
        val uri = if (current.isNullOrEmpty()) null else Uri.parse(current)
        val scheme = uri?.scheme?.takeIf { it == "https" || it == "http" } ?: "https"
        val host = uri?.host ?: "localhost"
        return "$scheme://$host"
    }

    private fun gameUrl(): String =
        origin() + "/" + (config?.optString("entry", "index.html") ?: "index.html")

    private fun padUrl(): String {
        val layout = Uri.encode(config?.optString("layout", "classic") ?: "classic")
        val title = Uri.encode(config?.optString("title", "") ?: "")
        return origin() + "/virtual-pad/index.html?layout=$layout&title=$title"
    }

    /** A display a window can go to, other than the phone's own panel. */
    private fun externalDisplay(): Display? {
        val dm = displays ?: return null
        return dm.displays.firstOrNull { d ->
            d.displayId != Display.DEFAULT_DISPLAY &&
                d.isValid &&
                d.state != Display.STATE_OFF &&
                (d.flags and Display.FLAG_PRIVATE) == 0
        }
    }

    private fun ownDisplayId(): Int {
        val act = cordova.activity
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            act.display?.displayId ?: Display.DEFAULT_DISPLAY
        } else {
            @Suppress("DEPRECATION")
            act.windowManager.defaultDisplay.displayId
        }
    }

    private fun evaluate() {
        if (config == null) return
        val ext = externalDisplay()
        if (ext == null) {
            heldSingle = false
            if (split) unsplit()
            return
        }
        if (!split && !heldSingle) splitTo(ext)
    }

    private fun splitTo(ext: Display) {
        val own = ownDisplayId()
        val cordovaOnPhone = own == Display.DEFAULT_DISPLAY
        val role = if (cordovaOnPhone) ScreenActivity.ROLE_GAME else ScreenActivity.ROLE_PAD
        val target = if (cordovaOnPhone) ext.displayId else Display.DEFAULT_DISPLAY
        val url = if (cordovaOnPhone) gameUrl() else padUrl()
        val act = cordova.activity
        val intent = Intent(act, ScreenActivity::class.java)
            .putExtra(ScreenActivity.EXTRA_URL, url)
            .putExtra(ScreenActivity.EXTRA_ROLE, role)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_MULTIPLE_TASK)
        val opts = ActivityOptions.makeBasic().setLaunchDisplayId(target)
        try {
            act.startActivity(intent, opts.toBundle())
        } catch (e: Throwable) {
            // A display that will not take our window (a private or secure
            // one): stay on one screen rather than fail.
            Log.w(TAG, "could not open a window on display $target", e)
            return
        }
        split = true
        if (cordovaOnPhone) {
            // The game moves out; this WebView becomes the controller. The
            // relay targets the new window once it is up (ScreenActivity
            // claims PadRelay.game in onCreate).
            cordovaShowsPad = true
            // Nothing may land in the controller page meant for the game.
            PadRelay.game = null
            cordovaWeb?.loadUrl(padUrl())
        } else {
            cordovaShowsPad = false
            PadRelay.game = cordovaWeb
        }
    }

    private fun unsplit() {
        split = false
        ScreenActivity.current?.let { if (!it.isFinishing) it.finish() }
        if (cordovaShowsPad) {
            cordovaShowsPad = false
            cordovaWeb?.loadUrl(gameUrl())
        }
        PadRelay.game = cordovaWeb
    }

    /** PLAY HERE / Back: the game comes back to the phone, until the displays change. */
    fun playHere() {
        heldSingle = true
        if (split) unsplit()
    }

    /** The other window went away on its own (the system, a swipe in Recents). */
    fun onScreenGone(screen: ScreenActivity) {
        main.post {
            if (!split) return@post
            heldSingle = true
            unsplit()
        }
    }

    override fun onDisplayAdded(displayId: Int) = evaluate()
    override fun onDisplayRemoved(displayId: Int) = evaluate()
    override fun onDisplayChanged(displayId: Int) = evaluate()

    override fun onMessage(id: String?, data: Any?): Any? {
        // A page the game is in finished loading: give it the shim up front,
        // so a game that looks for pads at boot finds the controller's.
        if (id != "onPageFinished") return null
        val web = cordovaWeb ?: return null
        if (cordovaShowsPad) {
            // Back from the controller must not walk the history back into the
            // game page while the game is also up on the monitor.
            web.clearHistory()
        } else {
            PadRelay.injectShim(cordova.activity.applicationContext, web)
        }
        return null
    }

    override fun onDestroy() {
        displays?.unregisterDisplayListener(this)
        ScreenActivity.current?.finish()
        if (instance === this) instance = null
        super.onDestroy()
    }

    /** window.ShmupxSecondScreen in Cordova's WebView (the controller, when it shows it). */
    private inner class Bridge {
        @JavascriptInterface
        fun postPad(json: String) = PadRelay.push(cordova.activity.applicationContext, json)

        @JavascriptInterface
        fun info(): String = infoJson()

        @JavascriptInterface
        fun swap() {
            main.post { playHere() }
        }
    }
}
