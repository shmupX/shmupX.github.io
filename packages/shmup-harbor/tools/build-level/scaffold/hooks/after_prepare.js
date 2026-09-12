#!/usr/bin/env node

/**
 * Cordova after_prepare hook
 *
 * Patches MainActivity.kt (cordova-android 13+) to enable Android immersive
 * sticky mode and to install lightweight on-device diagnostics so we can
 * triage launch crashes on a device with no ADB.
 *
 * The patched activity:
 *  - Hides both status bar and navigation bar on launch.
 *  - Re-hides them whenever the window regains focus (e.g. after a swipe
 *    gesture momentarily reveals the bars).
 *  - Uses the modern WindowInsetsController API (API 30+) with a legacy
 *    fallback for older devices.
 *  - Writes a timestamped launch-log.txt entry at the very start of
 *    onCreate(), then again before/after loadUrl(launchUrl). The log is
 *    written to the public Download/EvilInvadersForge/ folder so the user
 *    can read it from a stock Files app even if the app crashes mid-boot.
 *  - Installs an UncaughtExceptionHandler that persists stack traces to the
 *    same folder as last-crash.txt.
 *  - Shows a diagnostic AlertDialog (and a Toast) on every launch so the
 *    user has visible proof that MainActivity reached the patched code.
 *
 * Diagnostics deliberately live in MainActivity itself, NOT in a custom
 * Application class — registering android:name on <application> caused the
 * game APK to fail to start at all on real devices (process died before any
 * of our code could run).
 *
 * Note: SpriteShareActivity (for receiving shared images) is installed by
 * the cordova-plugin-sprite-share plugin via plugin.xml, not by this hook.
 */

const fs   = require("fs");
const path = require("path");

/** Recursively search for a file by name under `dir`. */
function findFile(dir, filename) {
    let entries;
    try { entries = fs.readdirSync(dir); } catch (_) { return null; }

    for (const entry of entries) {
        const full = path.join(dir, entry);
        let stat;
        try { stat = fs.statSync(full); } catch (_) { continue; }

        if (stat.isDirectory()) {
            const found = findFile(full, filename);
            if (found) return found;
        } else if (entry === filename) {
            return full;
        }
    }
    return null;
}

function patchIOSWebViewInspectable(context) {
    const platformRoot = path.join(
        context.opts.projectRoot, "platforms", "ios"
    );
    if (!fs.existsSync(platformRoot)) return;

    // Find CDVViewController.m or the main AppDelegate/ViewController to
    // enable WKWebView.isInspectable (iOS 16.4+).
    // cordova-ios 7.x reads the InspectableWebview preference from config.xml
    // automatically, but we also patch the Swift/ObjC source as a fallback
    // to ensure it works on debug builds.

    const appDelegatePath = findFile(
        path.join(platformRoot, "App"), "AppDelegate.swift"
    );

    if (!appDelegatePath) {
        console.log("after_prepare hook: AppDelegate.swift not found – skipping iOS inspectable patch");
        return;
    }

    let src = fs.readFileSync(appDelegatePath, "utf8");

    // Guard against patching twice
    if (src.includes("isInspectable")) return;

    // Add WKWebView isInspectable = true after the webView is configured.
    // In cordova-ios 7.x, the CDVWebViewEngine creates the WKWebView.
    // We inject code in didFinishLaunchingWithOptions to set inspectable after
    // the web view is created by calling into the viewController.
    const inspectablePatch = `
        // Enable remote debugging (iOS 16.4+)
        if #available(iOS 16.4, *) {
            if let vc = self.window?.rootViewController,
               let webView = vc.view?.subviews.compactMap({ $0 as? WKWebView }).first {
                webView.isInspectable = true
            }
        }`;

    // Try to insert after "return true" in didFinishLaunchingWithOptions
    if (src.includes("return true")) {
        src = src.replace(
            /(\s*return true\s*\n\s*\})/,
            inspectablePatch + "\n$1"
        );

        // Add WKWebView import if missing
        if (!src.includes("import WebKit")) {
            src = src.replace(
                /(import UIKit)/,
                "$1\nimport WebKit"
            );
        }

        fs.writeFileSync(appDelegatePath, src, "utf8");
        console.log("after_prepare hook: patched AppDelegate.swift with WKWebView.isInspectable = true");
    } else {
        console.log("after_prepare hook: could not locate insertion point in AppDelegate.swift");
    }
}

/**
 * Remove any stale Java SpriteShareActivity.java left behind in the Android
 * platform directory by earlier versions of this hook. The real Kotlin
 * SpriteShareActivity is copied in by the cordova-plugin-sprite-share plugin;
 * if a leftover .java file of the same class is still present, the Kotlin and
 * Java compilers will both emit com.easierbycode.spriteshare.SpriteShareActivity
 * and Gradle will fail with a duplicate-class error — or, worse, the stub .java
 * (which just forwards to the main game without showing the sprite picker) can
 * end up in the APK and shadow the real picker activity.
 */
function removeStaleSpriteShareJavaStub(context) {
    const platformRoot = path.join(
        context.opts.projectRoot, "platforms", "android"
    );
    if (!fs.existsSync(platformRoot)) return;

    const stalePath = path.join(
        platformRoot, "app", "src", "main", "java",
        "com", "easierbycode", "spriteshare", "SpriteShareActivity.java"
    );
    if (fs.existsSync(stalePath)) {
        try {
            fs.unlinkSync(stalePath);
            console.log("after_prepare hook: removed stale SpriteShareActivity.java stub at " + stalePath);
        } catch (e) {
            console.warn("after_prepare hook: failed to remove stale SpriteShareActivity.java", e);
        }
    }
}

/**
 * Strip any android:name="...ForgeApplication" left on <application> by
 * older builds. Registering a custom Application class via the manifest
 * caused the game APK to fail to launch at all on real devices, so we now
 * intentionally leave <application> with no android:name and run all
 * diagnostics from MainActivity instead. Idempotent.
 */
function removeStaleForgeApplicationRef(platformRoot) {
    const manifestPath = path.join(
        platformRoot, "app", "src", "main", "AndroidManifest.xml"
    );
    if (!fs.existsSync(manifestPath)) return;

    const xml = fs.readFileSync(manifestPath, "utf8");
    const stripped = xml.replace(
        /\s*android:name\s*=\s*"com\.easierbycode\.apkforge\.ForgeApplication"/g,
        ""
    );
    if (stripped !== xml) {
        fs.writeFileSync(manifestPath, stripped, "utf8");
        console.log("after_prepare hook: stripped stale ForgeApplication android:name from <application>");
    }
}

module.exports = function (context) {
    // ── iOS: enable WKWebView remote inspection ─────────────────────
    patchIOSWebViewInspectable(context);

    // ── Android: remove any stale Java SpriteShareActivity stub ─────
    // (the real Kotlin activity is installed by cordova-plugin-sprite-share)
    removeStaleSpriteShareJavaStub(context);

    // ── Android: immersive sticky mode ──────────────────────────────
    const platformRoot = path.join(
        context.opts.projectRoot, "platforms", "android"
    );
    if (!fs.existsSync(platformRoot)) return;

    // ── Android: scrub stale ForgeApplication manifest reference ────
    removeStaleForgeApplicationRef(platformRoot);

    const mainActivity = findFile(
        path.join(platformRoot, "app", "src"), "MainActivity.kt"
    );
    if (!mainActivity) {
        console.warn(
            "after_prepare hook: MainActivity.kt not found – skipping immersive-mode patch"
        );
        return;
    }

    let src = fs.readFileSync(mainActivity, "utf8");

    // Guard against patching twice
    if (src.includes("enterImmersiveMode")) return;

    // ---- Add required imports --------------------------------------------------
    const importsToAdd = [
        "import android.content.ContentUris",
        "import android.content.ContentValues",
        "import android.content.Context",
        "import android.net.Uri",
        "import android.os.Build",
        "import android.provider.MediaStore",
        "import android.view.View",
        "import android.view.WindowInsets",
        "import android.view.WindowInsetsController",
        "import android.app.AlertDialog",
        "import android.widget.TextView",
        "import android.widget.ScrollView",
        "import android.widget.Toast",
        "import android.text.method.ScrollingMovementMethod",
        "import android.os.Environment",
        "import android.util.Log",
        "import java.io.File",
        "import java.io.PrintWriter",
        "import java.io.StringWriter",
        "import java.text.SimpleDateFormat",
        "import java.util.Date",
        "import java.util.Locale"
    ].join("\n");

    // Insert right after the existing CordovaActivity import line
    src = src.replace(
        /(import\s+org\.apache\.cordova\.\*)/,
        "$1\n" + importsToAdd
    );

    // ---- Add enterImmersiveMode() + onWindowFocusChanged() + showDiagnostics() ----
    const methodBlock = `
    private val DIAG_DOWNLOAD_NAME = "evilinvaders-launch-log.txt"
    private val DIAG_CRASH_DOWNLOAD_NAME = "evilinvaders-last-crash.txt"

    private fun diagAppendCtx(ctx: Context, marker: String) {
        try {
            val ts = SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.US).format(Date())
            val line = "[\$ts] \$marker\\n"

            // 1. App cache (always works, hidden from user but used by showDiagnostics)
            try { File(ctx.cacheDir, "launch-log.txt").appendText(line) } catch (_: Throwable) {}

            // 2. App external files dir (always works; user-visible only with adb /
            // third-party file manager because Android 11+ Files app blocks it)
            try {
                ctx.getExternalFilesDir(null)?.let { File(it, "launch-log.txt").appendText(line) }
            } catch (_: Throwable) {}

            // 3. Public Downloads via MediaStore on API 29+ (the only place a user can
            // actually find it from a stock Files app on Android 11+). On 28 and below
            // we fall back to the legacy direct-file path.
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                try { mediaStoreAppend(ctx, DIAG_DOWNLOAD_NAME, line) } catch (_: Throwable) {}
            } else {
                try {
                    @Suppress("DEPRECATION")
                    val dl = File(Environment.getExternalStorageDirectory(), "Download/EvilInvadersForge")
                    dl.mkdirs()
                    File(dl, "launch-log.txt").appendText(line)
                } catch (_: Throwable) {}
            }
        } catch (_: Throwable) {}
    }

    private fun appendActivityDiagLine(marker: String) = diagAppendCtx(this, marker)

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
        // "wt" truncates and writes
        resolver.openOutputStream(target, "wt")?.use { it.write(text.toByteArray()) }
    }

    private fun installCrashHandler() {
        try {
            val previous = Thread.getDefaultUncaughtExceptionHandler()
            Thread.setDefaultUncaughtExceptionHandler { thread, throwable ->
                try {
                    val sw = StringWriter()
                    val ts = SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.US).format(Date())
                    sw.write("CRASH at \$ts on thread \${thread.name}\\n\\n")
                    throwable.printStackTrace(PrintWriter(sw))
                    val text = sw.toString()
                    Log.e("MainActivityCrash", text)
                    try { File(cacheDir, "last-crash.txt").writeText(text) } catch (_: Throwable) {}
                    try { getExternalFilesDir(null)?.let { File(it, "last-crash.txt").writeText(text) } } catch (_: Throwable) {}
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                        try { mediaStoreOverwrite(this, DIAG_CRASH_DOWNLOAD_NAME, text) } catch (_: Throwable) {}
                    } else {
                        try {
                            @Suppress("DEPRECATION")
                            val dl = File(Environment.getExternalStorageDirectory(), "Download/EvilInvadersForge")
                            dl.mkdirs()
                            File(dl, "last-crash.txt").writeText(text)
                        } catch (_: Throwable) {}
                    }
                } catch (_: Throwable) {}
                previous?.uncaughtException(thread, throwable)
            }
        } catch (_: Throwable) {}
    }

    private fun showDiagnostics() {
        try {
            // Always-visible Toast: confirms MainActivity reached this point.
            Toast.makeText(this, "MainActivity OK (forge diag)", Toast.LENGTH_LONG).show()

            val crash = File(cacheDir, "last-crash.txt")
            val log = File(cacheDir, "launch-log.txt")
            val hasCrash = crash.exists()
            val hasLog = log.exists()
            if (!hasCrash && !hasLog) return

            val sb = StringBuilder()
            if (hasCrash) {
                sb.append("=== LAST CRASH ===\\n").append(crash.readText()).append("\\n\\n")
            }
            if (hasLog) {
                sb.append("=== LAUNCH LOG (most recent) ===\\n").append(log.readText())
            }
            val text = sb.toString()

            // Post to UI thread with a small delay so the dialog has a chance to
            // render even if loadUrl() triggers a fast follow-on crash.
            window.decorView.postDelayed({
                try {
                    val tv = TextView(this).apply {
                        this.text = text
                        textSize = 10f
                        setPadding(24, 24, 24, 24)
                        setTextIsSelectable(true)
                        movementMethod = ScrollingMovementMethod()
                    }
                    val sv = ScrollView(this).apply { addView(tv) }
                    AlertDialog.Builder(this)
                        .setTitle(if (hasCrash) "Previous launch crashed" else "Forge diagnostics")
                        .setView(sv)
                        .setPositiveButton("Continue") { d, _ -> d.dismiss() }
                        .setNegativeButton("Clear logs") { d, _ ->
                            try { crash.delete() } catch (_: Throwable) {}
                            try { log.delete() } catch (_: Throwable) {}
                            d.dismiss()
                        }
                        .setCancelable(false)
                        .show()
                } catch (_: Throwable) {}
            }, 300L)
        } catch (_: Throwable) {}
    }

    private fun enterImmersiveMode() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            window.insetsController?.let { controller ->
                controller.hide(WindowInsets.Type.systemBars())
                controller.systemBarsBehavior =
                    WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            }
        } else {
            @Suppress("DEPRECATION")
            window.decorView.systemUiVisibility = (
                View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                    or View.SYSTEM_UI_FLAG_FULLSCREEN
                    or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                    or View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                    or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                    or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
            )
        }
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) {
            enterImmersiveMode()
        }
    }

    override fun attachBaseContext(newBase: Context) {
        // Earliest hook in the Activity lifecycle. Runs before super.onCreate,
        // before Cordova bootstrap, before plugin instantiation. If MAIN_ATTACH
        // never appears in evilinvaders-launch-log.txt (Files app -> Downloads),
        // the crash is happening before MainActivity even gets constructed —
        // probably a manifest / dex-load problem. If MAIN_ATTACH appears but
        // ACTIVITY_PRE_SUPER does not, super.attachBaseContext is the killer.
        // If ACTIVITY_PRE_SUPER appears but POST_SUPER does not, super.onCreate
        // (i.e. CordovaActivity bootstrap) is the killer.
        try { diagAppendCtx(newBase, "MAIN_ATTACH") } catch (_: Throwable) {}
        super.attachBaseContext(newBase)
        try { diagAppendCtx(newBase, "MAIN_ATTACH_DONE") } catch (_: Throwable) {}
    }`;

    // Wrap super.onCreate with PRE/POST markers and Toast so the user has
    // immediate visible confirmation that MainActivity reached this point even
    // if loadUrl triggers a fast follow-on crash. Then surround loadUrl with
    // PRE_LOAD/POST_LOAD markers.
    src = src.replace(
        /(super\.onCreate\([^)]*\))/,
        'appendActivityDiagLine("ACTIVITY_PRE_SUPER")\n        $1\n        appendActivityDiagLine("ACTIVITY_POST_SUPER")\n        try { Toast.makeText(this, "MainActivity OK (forge diag)", Toast.LENGTH_LONG).show() } catch (_: Throwable) {}\n        installCrashHandler()'
    );
    src = src.replace(
        /(loadUrl\(launchUrl\))/,
        'appendActivityDiagLine("ACTIVITY_PRE_LOAD")\n        $1\n        appendActivityDiagLine("ACTIVITY_POST_LOAD")\n        enterImmersiveMode()\n        showDiagnostics()'
    );

    // Insert methods before the final closing brace of the class
    const lastBrace = src.lastIndexOf("}");
    src = src.substring(0, lastBrace) + methodBlock + "\n}\n";

    fs.writeFileSync(mainActivity, src, "utf8");
    console.log("after_prepare hook: patched MainActivity.kt with immersive sticky mode");
};
