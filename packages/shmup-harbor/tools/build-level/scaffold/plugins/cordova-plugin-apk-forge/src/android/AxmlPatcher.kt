package com.easierbycode.apkforge

import java.io.File

/**
 * Patches the package id in a binary AndroidManifest.xml inside an APK.
 *
 * Strategy: locate a length-stable placeholder string (UTF-16LE) in the
 * raw bytes and overwrite it in place. The shell APK is built with the
 * placeholder as the widget id in config.xml so AAPT2 emits it directly
 * into both the AXML attribute payload and the AXML string pool. Because
 * the replacement has the exact same UTF-16 byte length, no string-pool
 * offset table needs to be rewritten.
 *
 * Critical: only replace string-pool entries that are exactly the placeholder.
 * The shell manifest also contains FQCN strings that *embed* the placeholder
 * as a prefix — most importantly the activity's android:name
 * ("<placeholder>.MainActivity"), and the FileProvider authority
 * ("<placeholder>.apkforge.fileprovider"). Those strings must keep the
 * placeholder package because the DEX class for the activity is compiled
 * into the placeholder package and Android resolves the activity by class
 * name at launch — rewriting that prefix would point Android at a class
 * that doesn't exist and the forged APK would crash on open with
 * ClassNotFoundException.
 */
object AxmlPatcher {

    const val PKG_PLACEHOLDER = "com.easierbycode.zzzzzzzzzzzzzzzzzzzzzzzzzzzzzz"
    const val PKG_LEN = 47

    fun patchManifest(apk: File, packageId: String) {
        require(packageId.length <= PKG_LEN) {
            "packageId longer than placeholder: $packageId"
        }
        val data = ZipRewriter.readEntry(apk, "AndroidManifest.xml")
            ?: throw IllegalStateException("AndroidManifest.xml missing")
        val padded = packageId.padEnd(PKG_LEN, '_')
        val patched = replaceStandaloneUtf16(data, PKG_PLACEHOLDER, padded)
        ZipRewriter.replaceEntry(apk, "AndroidManifest.xml", patched)
    }

    private fun replaceStandaloneUtf16(data: ByteArray, find: String, replace: String): ByteArray {
        require(find.length == replace.length)
        val findBytes = find.toByteArray(Charsets.UTF_16LE)
        val replaceBytes = replace.toByteArray(Charsets.UTF_16LE)
        val out = data.copyOf()
        var standaloneMatches = 0
        var skippedSubstringMatches = 0
        var i = 0
        while (i <= out.size - findBytes.size) {
            if (matchesAt(out, i, findBytes)) {
                if (isStringPoolBoundary(out, i + findBytes.size)) {
                    System.arraycopy(replaceBytes, 0, out, i, replaceBytes.size)
                    standaloneMatches++
                } else {
                    skippedSubstringMatches++
                }
                i += findBytes.size
            } else {
                i++
            }
        }
        if (standaloneMatches == 0) {
            throw IllegalStateException(
                "AXML placeholder not found as a standalone string — shell APK does " +
                "not match expected format. Expected: '$find' " +
                "(skippedSubstringMatches=$skippedSubstringMatches)"
            )
        }
        return out
    }

    /**
     * AXML string-pool entries are NUL-terminated (UTF-16: 0x00 0x00). A match
     * is the *whole* string only when the bytes immediately following it are
     * the NUL terminator. Otherwise the match is the prefix of a longer string
     * (e.g. "<placeholder>.MainActivity") and must be left intact.
     */
    private fun isStringPoolBoundary(data: ByteArray, end: Int): Boolean {
        if (end + 1 >= data.size) return true
        return data[end] == 0.toByte() && data[end + 1] == 0.toByte()
    }

    private fun matchesAt(data: ByteArray, idx: Int, needle: ByteArray): Boolean {
        for (j in needle.indices) if (data[idx + j] != needle[j]) return false
        return true
    }
}
