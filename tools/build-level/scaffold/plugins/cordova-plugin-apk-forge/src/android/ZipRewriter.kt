package com.easierbycode.apkforge

import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.util.zip.CRC32
import java.util.zip.ZipEntry
import java.util.zip.ZipFile
import java.util.zip.ZipOutputStream

/**
 * Rewrites a zip in place via copy-with-filter: reads the existing entries,
 * applies removePrefix/addFile mutations, and writes a fresh zip with no
 * META-INF unless we add one. Honors the zip method (STORED vs DEFLATED) of
 * existing entries and lets callers specify the method for added entries —
 * critical for resources.arsc on API 30+ which must remain STORED.
 */
class ZipRewriter(private val target: File) {

    private data class AddEntry(val bytes: ByteArray, val method: Int)

    private val removed = mutableSetOf<String>()
    private val removedPrefixes = mutableListOf<String>()
    private val added = LinkedHashMap<String, AddEntry>()

    fun removeEntry(name: String) { removed.add(name) }
    fun removePrefix(prefix: String) { removedPrefixes.add(prefix) }

    fun addFile(name: String, bytes: ByteArray, method: Int = ZipEntry.DEFLATED) {
        added[name] = AddEntry(bytes, method)
    }

    fun finish() {
        val tmp = File(target.parentFile, target.name + ".tmp")
        if (tmp.exists()) tmp.delete()
        ZipFile(target).use { src ->
            FileOutputStream(tmp).use { fos ->
                ZipOutputStream(fos).use { zout ->
                    val entries = src.entries()
                    while (entries.hasMoreElements()) {
                        val e = entries.nextElement()
                        if (shouldDrop(e.name)) continue
                        if (added.containsKey(e.name)) continue
                        val buf = src.getInputStream(e).use { it.readBytes() }
                        val out = ZipEntry(e.name).apply {
                            method = e.method
                            time = e.time
                            comment = e.comment
                            extra = e.extra
                            if (method == ZipEntry.STORED) {
                                size = buf.size.toLong()
                                compressedSize = buf.size.toLong()
                                crc = e.crc
                            }
                        }
                        zout.putNextEntry(out)
                        zout.write(buf)
                        zout.closeEntry()
                    }
                    for ((name, entry) in added) {
                        val out = ZipEntry(name).apply { method = entry.method }
                        if (entry.method == ZipEntry.STORED) {
                            val crc32 = CRC32()
                            crc32.update(entry.bytes)
                            out.size = entry.bytes.size.toLong()
                            out.compressedSize = entry.bytes.size.toLong()
                            out.crc = crc32.value
                        }
                        zout.putNextEntry(out)
                        zout.write(entry.bytes)
                        zout.closeEntry()
                    }
                }
            }
        }
        if (!target.delete()) throw IllegalStateException("Could not delete original: $target")
        if (!tmp.renameTo(target)) {
            FileInputStream(tmp).use { ins ->
                FileOutputStream(target).use { out -> ins.copyTo(out) }
            }
            tmp.delete()
        }
    }

    private fun shouldDrop(name: String): Boolean {
        if (removed.contains(name)) return true
        for (p in removedPrefixes) if (name.startsWith(p)) return true
        return false
    }

    companion object {
        /**
         * Replace an existing entry, inheriting its compression method so that
         * STORED entries (resources.arsc on API 30+, native libs) stay STORED.
         */
        fun replaceEntry(file: File, name: String, bytes: ByteArray) {
            val origMethod = ZipFile(file).use { z ->
                z.getEntry(name)?.method ?: ZipEntry.DEFLATED
            }
            val rw = ZipRewriter(file)
            rw.removeEntry(name)
            rw.addFile(name, bytes, origMethod)
            rw.finish()
        }

        fun readEntry(file: File, name: String): ByteArray? {
            ZipFile(file).use { z ->
                val e = z.getEntry(name) ?: return null
                return z.getInputStream(e).use { it.readBytes() }
            }
        }
    }
}
