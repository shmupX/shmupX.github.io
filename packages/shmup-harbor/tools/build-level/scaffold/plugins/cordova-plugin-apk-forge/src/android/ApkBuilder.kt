package com.easierbycode.apkforge

import android.content.ContentValues
import android.content.Context
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import androidx.core.content.FileProvider
import org.json.JSONObject
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream

typealias ProgressFn = (phase: String, percent: Int, message: String?) -> Unit

class ApkBuilder(private val ctx: Context, private val progress: ProgressFn) {

    data class Result(val path: String, val contentUri: String?, val sizeBytes: Long)

    fun run(opts: JSONObject): Result {
        val workDir = File(opts.getString("workDir"))
        val www = if (workDir.name == "www") workDir else File(workDir, "www")
        require(www.isDirectory) { "workDir/www does not exist: " + www.absolutePath }

        val packageId = opts.getString("packageId")
        val displayName = opts.getString("displayName")
        val slug = opts.getString("slug")
        val outFilename = opts.optString("outFilename", "$slug.apk")

        progress("init", 2, "Preparing workspace")
        val outRoot = File(ctx.cacheDir, "apkforge/out").apply { mkdirs() }
        val workApk = File(outRoot, "$slug-work.apk")
        if (workApk.exists()) workApk.delete()

        progress("copy-shell", 5, "Copying shell APK")
        copyShellTo(workApk)

        progress("zip-rewrite", 15, "Replacing assets/www and stripping META-INF")
        val zip = ZipRewriter(workApk)
        zip.removePrefix("assets/www/")
        zip.removePrefix("META-INF/")
        zip.addFile("assets/www/.keep", ByteArray(0))
        addDirToZip(zip, www, "assets/www/")
        zip.finish()

        progress("icons", 45, "Re-coloring launcher icons")
        IconRecolor.recolorAll(workApk, slug, opts.optString("iconBase64", ""))

        progress("manifest", 60, "Patching manifest package id and label")
        AxmlPatcher.patchManifest(workApk, packageId)
        ArscPatcher.patchAppLabel(workApk, displayName)

        progress("sign", 75, "Signing APK (v1+v2)")
        val unsigned = workApk
        val signed = File(outRoot, "$slug-signed.apk")
        if (signed.exists()) signed.delete()
        Signer.sign(ctx, unsigned, signed)

        progress("publish", 92, "Saving to Downloads")
        val (publicPath, contentUri) = publishToDownloads(signed, outFilename)

        progress("finalize", 99, "Done")
        return Result(publicPath ?: signed.absolutePath, contentUri, signed.length())
    }

    private fun copyShellTo(dest: File) {
        ctx.assets.open("apkforge/shell-template.apk").use { ins ->
            FileOutputStream(dest).use { out -> ins.copyTo(out) }
        }
    }

    private fun addDirToZip(zip: ZipRewriter, dir: File, prefix: String) {
        if (!dir.exists()) return
        val stack = ArrayDeque<Pair<File, String>>()
        stack.addLast(dir to prefix)
        while (stack.isNotEmpty()) {
            val (cur, pfx) = stack.removeLast()
            val children = cur.listFiles() ?: continue
            for (child in children) {
                val rel = pfx + child.name
                if (child.isDirectory) {
                    stack.addLast(child to "$rel/")
                } else {
                    val bytes = FileInputStream(child).use { it.readBytes() }
                    zip.addFile(rel, bytes)
                }
            }
        }
    }

    private fun publishToDownloads(signed: File, outFilename: String): Pair<String?, String?> {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            publishViaMediaStore(signed, outFilename)
        } else {
            publishViaLegacyFile(signed, outFilename)
        }
    }

    private fun publishViaMediaStore(signed: File, outFilename: String): Pair<String?, String?> {
        val resolver = ctx.contentResolver
        val collection = MediaStore.Downloads.EXTERNAL_CONTENT_URI
        val values = ContentValues().apply {
            put(MediaStore.Downloads.DISPLAY_NAME, outFilename)
            put(MediaStore.Downloads.MIME_TYPE, "application/vnd.android.package-archive")
            put(MediaStore.Downloads.RELATIVE_PATH,
                Environment.DIRECTORY_DOWNLOADS + "/EvilInvadersForge")
            put(MediaStore.Downloads.IS_PENDING, 1)
        }
        val uri = resolver.insert(collection, values)
            ?: return null to null
        try {
            resolver.openOutputStream(uri).use { out ->
                FileInputStream(signed).use { it.copyTo(out!!) }
            }
            values.clear()
            values.put(MediaStore.Downloads.IS_PENDING, 0)
            resolver.update(uri, values, null, null)
        } catch (e: Exception) {
            resolver.delete(uri, null, null)
            throw e
        }
        return null to uri.toString()
    }

    private fun publishViaLegacyFile(signed: File, outFilename: String): Pair<String?, String?> {
        val downloads = Environment.getExternalStoragePublicDirectory(
            Environment.DIRECTORY_DOWNLOADS)
        val target = File(downloads, "EvilInvadersForge").apply { mkdirs() }
        val finalFile = File(target, outFilename)
        FileInputStream(signed).use { ins ->
            FileOutputStream(finalFile).use { out -> ins.copyTo(out) }
        }
        val authority = ctx.packageName + ".apkforge.fileprovider"
        val uri = FileProvider.getUriForFile(ctx, authority, finalFile)
        return finalFile.absolutePath to uri.toString()
    }
}
