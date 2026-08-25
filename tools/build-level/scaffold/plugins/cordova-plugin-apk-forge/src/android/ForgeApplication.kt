package com.easierbycode.apkforge

import android.app.Application
import android.content.Context
import android.os.Build
import android.os.Environment
import android.util.Log
import java.io.File
import java.io.PrintWriter
import java.io.StringWriter
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Diagnostic Application class. Two responsibilities:
 *
 *   1) Append a "boot ping" line to a launch log on every process start so the
 *      user can confirm — even on a device with no ADB — whether ForgeApplication
 *      is being loaded at all. The log is written to several locations so at
 *      least one is reachable from a stock Files app.
 *
 *   2) Install an UncaughtExceptionHandler in attachBaseContext (runs *before*
 *      ContentProvider.attachInfo, so it captures FileProvider/manifest-merge
 *      style crashes that would otherwise leave no trace) and persist the
 *      stack trace to the same locations.
 *
 * MainActivity (patched by hooks/after_prepare.js) reads these files on every
 * launch and shows them in a Dialog so the user has a visible record without ADB.
 */
class ForgeApplication : Application() {

    private var savedHandler: Thread.UncaughtExceptionHandler? = null

    override fun attachBaseContext(base: Context) {
        super.attachBaseContext(base)
        appendDiagLine(base, "APP_ATTACH pid=${android.os.Process.myPid()} api=${Build.VERSION.SDK_INT}")
        installCrashHandler(base)
        Log.i(TAG, "ForgeApplication attached, crash handler installed")
    }

    override fun onCreate() {
        super.onCreate()
        appendDiagLine(this, "APP_CREATE")
    }

    private fun installCrashHandler(ctx: Context) {
        savedHandler = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, throwable ->
            try { writeCrashLog(ctx, thread, throwable) } catch (_: Throwable) {}
            savedHandler?.uncaughtException(thread, throwable)
        }
    }

    private fun writeCrashLog(ctx: Context, thread: Thread, throwable: Throwable) {
        val sw = StringWriter()
        val ts = SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.US).format(Date())
        sw.write("CRASH at $ts\n")
        sw.write("Thread: ${thread.name}\n")
        sw.write("Process: ${android.os.Process.myPid()}\n\n")
        throwable.printStackTrace(PrintWriter(sw))
        val text = sw.toString()
        Log.e(TAG, text)

        runCatching { File(ctx.cacheDir, CRASH_FILE).writeText(text) }

        runCatching {
            ctx.getExternalFilesDir(null)?.let { File(it, CRASH_FILE).writeText(text) }
        }

        runCatching {
            @Suppress("DEPRECATION")
            val downloads = File(Environment.getExternalStorageDirectory(),
                "Download/EvilInvadersForge")
            downloads.mkdirs()
            File(downloads, CRASH_FILE).writeText(text)
        }
    }

    /**
     * Append a single timestamped line to launch-log.txt in three locations
     * (best-effort; any can fail without affecting the others). Keeps the
     * tail of the file under MAX_LOG_BYTES so it doesn't grow unbounded.
     */
    private fun appendDiagLine(ctx: Context, marker: String) {
        val ts = SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.US).format(Date())
        val line = "[$ts] $marker\n"

        runCatching { appendCapped(File(ctx.cacheDir, LAUNCH_LOG), line) }
        runCatching {
            ctx.getExternalFilesDir(null)?.let { appendCapped(File(it, LAUNCH_LOG), line) }
        }
        runCatching {
            @Suppress("DEPRECATION")
            val downloads = File(Environment.getExternalStorageDirectory(),
                "Download/EvilInvadersForge")
            downloads.mkdirs()
            appendCapped(File(downloads, LAUNCH_LOG), line)
        }
    }

    private fun appendCapped(f: File, text: String) {
        if (f.exists() && f.length() > MAX_LOG_BYTES) {
            // Trim to last half so we keep recent history
            val keep = f.readText().takeLast(MAX_LOG_BYTES.toInt() / 2)
            f.writeText(keep)
        }
        f.appendText(text)
    }

    companion object {
        private const val TAG = "ForgeApplication"
        const val CRASH_FILE = "last-crash.txt"
        const val LAUNCH_LOG = "launch-log.txt"
        private const val MAX_LOG_BYTES = 64L * 1024L
    }
}
