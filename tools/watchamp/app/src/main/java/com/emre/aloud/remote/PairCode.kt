package com.emre.aloud.remote

/**
 * The code that pairs this watch to one desktop launcher. Everything the two
 * say to each other lives under `/builders/<code>/music/…`.
 *
 * Same rules as the launcher's `static/watch-music.js`, and they are not
 * decoration:
 *
 * - **Eight characters from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`.** No I, O, 0 or
 *   1 — the code is read off a screen and typed on a watch, and those four are
 *   the pairs people get wrong.
 * - **The stored form is unhyphenated.** The launcher shows `ABCD-EFGH` and
 *   listens on `ABCDEFGH`. A hyphen left in a database path addresses a real,
 *   valid node that no desktop is watching, and nothing reports an error.
 */
object PairCode {

    private const val ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

    const val LENGTH = 8

    /** The form that goes in a database path. */
    fun normalize(raw: String?): String =
        raw.orEmpty().uppercase().filter { it.isLetterOrDigit() }

    /** Is this a code a launcher could actually have generated? */
    fun isValid(raw: String?): Boolean {
        val code = normalize(raw)
        return code.length == LENGTH && code.all { it in ALPHABET }
    }

    /** `ABCD-EFGH`, for showing to a person. Never build a path from this. */
    fun format(raw: String?): String {
        val code = normalize(raw)
        return if (code.length == LENGTH) "${code.take(4)}-${code.drop(4)}" else code
    }

    /**
     * The code to use, or "" when unpaired.
     *
     * [stored] is what the listener typed on the watch and wins when present —
     * including "", which is an explicit unpair and must not quietly fall back
     * to [buildDefault], the optional code baked in from `local.properties`.
     */
    fun resolve(stored: String?, buildDefault: String): String {
        val candidate = stored ?: buildDefault
        return if (isValid(candidate)) normalize(candidate) else ""
    }
}
