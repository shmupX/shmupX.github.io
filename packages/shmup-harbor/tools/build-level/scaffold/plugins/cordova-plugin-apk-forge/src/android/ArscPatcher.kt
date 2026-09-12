package com.easierbycode.apkforge

import java.io.File

/**
 * Patches the @string/app_name value in resources.arsc by overwriting the
 * length-stable placeholder string in place. Modern AAPT2 emits resources.arsc
 * string pools as UTF-8 by default; the placeholder length is chosen so it
 * comfortably fits any reasonable display name. Replacement is right-padded
 * with U+00A0 (non-breaking space) so trailing whitespace isn't stripped by
 * launchers.
 */
object ArscPatcher {

    const val LABEL_PLACEHOLDER = "APKForgeLabelPlaceholder__________________________"
    const val LABEL_LEN = 50
    private const val PAD = ' '

    fun patchAppLabel(apk: File, displayName: String) {
        require(displayName.length <= LABEL_LEN) {
            "displayName longer than placeholder: $displayName"
        }
        val arsc = ZipRewriter.readEntry(apk, "resources.arsc")
            ?: throw IllegalStateException("resources.arsc missing")
        val padded = displayName.padEnd(LABEL_LEN, PAD)
        val patched = replaceFirstMatching(arsc, LABEL_PLACEHOLDER, padded)
        ZipRewriter.replaceEntry(apk, "resources.arsc", patched)
    }

    private fun replaceFirstMatching(data: ByteArray, find: String, replace: String): ByteArray {
        require(find.length == replace.length)
        val attempts = listOf(
            find.toByteArray(Charsets.UTF_8) to replace.toByteArray(Charsets.UTF_8),
            find.toByteArray(Charsets.UTF_16LE) to replace.toByteArray(Charsets.UTF_16LE)
        )
        for ((findBytes, replaceBytes) in attempts) {
            if (findBytes.size != replaceBytes.size) continue
            val out = data.copyOf()
            var matches = 0
            var i = 0
            while (i <= out.size - findBytes.size) {
                if (matchesAt(out, i, findBytes)) {
                    System.arraycopy(replaceBytes, 0, out, i, replaceBytes.size)
                    matches++
                    i += findBytes.size
                } else {
                    i++
                }
            }
            if (matches > 0) return out
        }
        throw IllegalStateException(
            "ARSC placeholder not found — shell APK does not match expected format. " +
            "Expected: '$find'"
        )
    }

    private fun matchesAt(data: ByteArray, idx: Int, needle: ByteArray): Boolean {
        for (j in needle.indices) if (data[idx + j] != needle[j]) return false
        return true
    }
}
