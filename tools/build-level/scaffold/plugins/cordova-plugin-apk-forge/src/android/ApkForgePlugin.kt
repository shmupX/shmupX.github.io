package com.easierbycode.apkforge

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.util.Base64
import android.util.Log
import org.apache.cordova.CallbackContext
import org.apache.cordova.CordovaPlugin
import org.apache.cordova.PluginResult
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.util.concurrent.atomic.AtomicReference
import kotlin.concurrent.thread

class ApkForgePlugin : CordovaPlugin() {

    private val activeBuild = AtomicReference<Thread?>(null)

    override fun execute(action: String, args: JSONArray, cb: CallbackContext): Boolean {
        return when (action) {
            "checkInstallPermission" -> { checkInstallPermission(cb); true }
            "requestInstallPermission" -> { requestInstallPermission(cb); true }
            "prepareWorkdir" -> { prepareWorkdir(args, cb); true }
            "writeStagedFile" -> { writeStagedFile(args, cb); true }
            "build" -> { build(args, cb); true }
            "install" -> { install(args, cb); true }
            "cancel" -> { cancel(cb); true }
            else -> false
        }
    }

    private fun checkInstallPermission(cb: CallbackContext) {
        val ctx = cordova.activity ?: return cb.error("no activity")
        val allowed = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            ctx.packageManager.canRequestPackageInstalls()
        } else true
        cb.success(if (allowed) 1 else 0)
    }

    private fun requestInstallPermission(cb: CallbackContext) {
        val act = cordova.activity ?: return cb.error("no activity")
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return cb.success(1)
        if (act.packageManager.canRequestPackageInstalls()) return cb.success(1)
        val intent = Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
            Uri.parse("package:" + act.packageName))
        try {
            act.startActivity(intent)
            cb.success(0)
        } catch (e: Exception) {
            cb.error("Could not open install-permission settings: " + (e.message ?: ""))
        }
    }

    private fun prepareWorkdir(args: JSONArray, cb: CallbackContext) {
        try {
            val opts = args.optJSONObject(0) ?: JSONObject()
            val name = opts.optString("workDir", "build-" + System.currentTimeMillis())
            val root = File(cordova.activity.cacheDir, "apkforge")
            val work = File(root, name + "/www")
            work.mkdirs()
            cb.success(work.absolutePath)
        } catch (e: Exception) {
            cb.error("prepareWorkdir failed: " + (e.message ?: ""))
        }
    }

    private fun writeStagedFile(args: JSONArray, cb: CallbackContext) {
        try {
            val opts = args.getJSONObject(0)
            val workDir = File(opts.getString("workDir"))
            val rel = opts.getString("relPath").trimStart('/')
            if (rel.contains("..")) return cb.error("relPath must not contain ..")
            val dest = File(workDir, rel)
            dest.parentFile?.mkdirs()
            val b64 = opts.getString("base64")
            val bytes = Base64.decode(b64, Base64.DEFAULT)
            FileOutputStream(dest).use { it.write(bytes) }
            cb.success(dest.absolutePath)
        } catch (e: Exception) {
            cb.error("writeStagedFile failed: " + (e.message ?: ""))
        }
    }

    private fun build(args: JSONArray, cb: CallbackContext) {
        if (activeBuild.get() != null) return cb.error("a build is already in progress")
        val opts = args.optJSONObject(0) ?: return cb.error("missing build opts")
        val ctx = cordova.context ?: return cb.error("no context")

        val keep = PluginResult(PluginResult.Status.NO_RESULT)
        keep.keepCallback = true
        cb.sendPluginResult(keep)

        val t = thread(start = false, name = "apkforge-build") {
            try {
                val builder = ApkBuilder(ctx) { phase, percent, message ->
                    val ev = JSONObject()
                    ev.put("phase", phase)
                    ev.put("percent", percent)
                    if (message != null) ev.put("message", message)
                    val r = PluginResult(PluginResult.Status.OK, ev)
                    r.keepCallback = true
                    cb.sendPluginResult(r)
                }
                val result = builder.run(opts)
                val done = JSONObject()
                done.put("phase", "done")
                done.put("percent", 100)
                done.put("path", result.path)
                done.put("uri", result.contentUri)
                done.put("size", result.sizeBytes)
                val r = PluginResult(PluginResult.Status.OK, done)
                r.keepCallback = false
                cb.sendPluginResult(r)
            } catch (e: Throwable) {
                Log.e(TAG, "build failed", e)
                val err = JSONObject()
                err.put("phase", "error")
                err.put("message", e.message ?: e.javaClass.simpleName)
                val r = PluginResult(PluginResult.Status.ERROR, err)
                r.keepCallback = false
                cb.sendPluginResult(r)
            } finally {
                activeBuild.set(null)
            }
        }
        activeBuild.set(t)
        t.start()
    }

    private fun install(args: JSONArray, cb: CallbackContext) {
        try {
            val opts = args.getJSONObject(0)
            val uri = opts.getString("uri")
            Installer.installApk(cordova.activity, Uri.parse(uri))
            cb.success("launched")
        } catch (e: Exception) {
            cb.error("install failed: " + (e.message ?: ""))
        }
    }

    private fun cancel(cb: CallbackContext) {
        val t = activeBuild.getAndSet(null)
        if (t != null && t.isAlive) t.interrupt()
        cb.success("cancelled")
    }

    companion object {
        private const val TAG = "ApkForge"
    }
}
