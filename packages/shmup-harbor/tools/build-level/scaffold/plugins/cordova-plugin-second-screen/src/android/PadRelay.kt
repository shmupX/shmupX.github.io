package com.easierbycode.secondscreen

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.webkit.WebView
import org.json.JSONObject

/**
 * Carries the touch controller's state from the controller page's WebView to
 * the game's.
 *
 * The controller page (www/virtual-pad/index.html) calls
 * ShmupxSecondScreen.postPad(json) on every change and every 250 ms; each
 * message is handed to window.__cmgVirtualPadPush in the game's page, which
 * www/virtual-pad/pad-shim.js defines: it makes the state one more standard
 * gamepad in navigator.getGamepads(). The shim is injected the first time a
 * page is found without it (a fresh page, a reload), so the game's own files
 * need no change.
 */
object PadRelay {
    /** The WebView the game is in: Cordova's own, or ScreenActivity's on the monitor. */
    @Volatile
    var game: WebView? = null

    private val main = Handler(Looper.getMainLooper())
    @Volatile
    private var shimSource: String? = null

    /** Messages are a few dozen bytes; anything much bigger is not one. */
    private const val MAX_MESSAGE = 512

    private fun shim(ctx: Context): String {
        shimSource?.let { return it }
        val src = try {
            ctx.assets.open("www/virtual-pad/pad-shim.js").bufferedReader().use { it.readText() }
        } catch (_: Throwable) {
            ""
        }
        shimSource = src
        return src
    }

    /** Make sure the game's current page has the shim. */
    fun injectShim(ctx: Context, view: WebView) {
        val src = shim(ctx)
        if (src.isEmpty()) return
        main.post {
            try {
                view.evaluateJavascript(src, null)
            } catch (_: Throwable) {
                // The WebView is being torn down.
            }
        }
    }

    fun push(ctx: Context, json: String) {
        if (json.length > MAX_MESSAGE) return
        val target = game ?: return
        val quoted = JSONObject.quote(json)
        val call = "(function(m){if(window.__cmgVirtualPadPush){window.__cmgVirtualPadPush(m);return 1}return 0})($quoted)"
        main.post {
            try {
                target.evaluateJavascript(call) { result ->
                    // The page is new and has no shim yet: inject it, then
                    // deliver this message again.
                    if (result == "0") {
                        injectShim(ctx, target)
                        main.post {
                            try {
                                target.evaluateJavascript(call, null)
                            } catch (_: Throwable) {
                            }
                        }
                    }
                }
            } catch (_: Throwable) {
            }
        }
    }
}
