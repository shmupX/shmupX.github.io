package games.codemonkey.shmupxwatch.bridge

/**
 * The pairing code that scopes everything the watch and the desktop say to each
 * other, under `/builders/<code>/…`.
 *
 * Ported from `static/export-queue.js` so all three ends agree. The rules are
 * not decoration:
 *
 * - **Eight characters from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`.** No I, O, 0 or
 *   1 — the code is read off a screen and typed or dictated, and those four are
 *   the pairs people get wrong.
 * - **The stored form is unhyphenated.** The desktop writes `ABCDEFGH`; the
 *   hyphen in `ABCD-EFGH` exists only so a human can read it back. Interpolating
 *   the displayed form into a database path yields `/builders/ABCD-EFGH/…`,
 *   which is a perfectly valid node that the desktop is not watching — the two
 *   ends never meet and nothing reports an error, because there is no error.
 *   `local.properties.example` shipped exactly that mistake as its sample value.
 */
object BuilderCode {

    /** The code alphabet, minus the four characters that are misread. */
    private const val ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

    const val LENGTH = 8

    /**
     * The form that goes in a database path: upper-cased, with every separator
     * a person might have typed or dictated removed.
     */
    fun normalize(raw: String?): String =
        raw.orEmpty().uppercase().filter { it.isLetterOrDigit() }

    /** Is this a code the desktop could actually have generated? */
    fun isValid(raw: String?): Boolean {
        val code = normalize(raw)
        return code.length == LENGTH && code.all { it in ALPHABET }
    }

    /**
     * The form to show a person: `ABCD-EFGH`. Display only — never build a path
     * from this.
     */
    fun format(raw: String?): String {
        val code = normalize(raw)
        return if (code.length == LENGTH) "${code.take(4)}-${code.drop(4)}" else code
    }

    /**
     * A dictated code, reduced to candidate characters.
     *
     * Only the mechanical part is done here — case and the spaces a recogniser
     * puts between spelled-out letters. Deliberately no phonetic repair: a
     * recogniser that heard "oh" could have meant O (not in the alphabet), Q,
     * or nothing, and a wrong guess produces a valid-looking code for a node
     * nobody is watching, which is indistinguishable from a desktop that is
     * merely offline. Let [isValid] reject it and ask again.
     */
    fun fromSpeech(heard: String): String = normalize(heard)
}
