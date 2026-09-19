package games.codemonkey.shmupxwatch.ui.theme

import androidx.compose.ui.graphics.Color

/**
 * The launcher's palette, lifted verbatim from the Claude Design handoff
 * (`shmupX-Watch.dc.html`).
 *
 * This is a second palette, not a replacement for [ShmupxPalette]. That one
 * colours *agent state* — four separable hues so a working agent and a blocked
 * one are told apart in peripheral vision. This one colours the *launcher*,
 * which has a different job: it is one phosphor-green CRT with a single yellow
 * accent reserved for "this is the thing you are about to do". Mixing the two
 * would spend the alarm colour on a list row.
 *
 * Every value here is the design's own. Where the design wrote `rgba(r,g,b,a)`
 * the alpha is kept as an alpha rather than pre-blended against the background,
 * because most of these sit over the animated mesh and the blend has to happen
 * at draw time.
 */
object DesignPalette {

    /** Page and screen base — a green-black, not a neutral one. */
    val Void = Color(0xFF040705)
    val Black = Color(0xFF000000)

    /** Body phosphor. The colour the whole UI reads as. */
    val Phosphor = Color(0xFF9CFF6B)

    /** Brightest text: titles that have to win against the mesh. */
    val Bright = Color(0xFFEAFFD2)

    /** Ordinary label text on a row. */
    val Label = Color(0xFFC6FFA8)

    /** Pure white — used only for the selected row's and detail's title. */
    val Chalk = Color(0xFFFFFFFF)

    /**
     * The accent. Reserved for the current selection and the primary action:
     * the LAUNCH button, the highlighted library row, the listening indicator.
     * If everything is yellow, nothing is.
     */
    val Accent = Color(0xFFF6FF4A)
    val AccentHover = Color(0xFFFFEE5A)

    /** The LAUNCH button's gradient foot, and the ink on top of it. */
    val AccentDeep = Color(0xFFC9D617)
    val OnAccent = Color(0xFF0A1206)

    /** Stop. The one warm hue in the design, and it only appears on ■. */
    val Danger = Color(0xFFFF9A8C)
    val DangerBorder = Color(0x66FF786E) // rgba(255,120,110,.4)
    val DangerFill = Color(0xBF1C0806) // rgba(28,8,6,.75)

    /* ── Text at the design's alphas ─────────────────────────────────────── */

    /** rgba(198,255,168,.9) — captions and monospace metadata. */
    val LabelDim = Color(0xE6C6FFA8)

    /** rgba(198,255,168,.7) — section headings, the quietest readable text. */
    val LabelFaint = Color(0xB3C6FFA8)

    /** rgba(198,255,168,.85) / .88 — hint lines under a control. */
    val LabelHint = Color(0xD9C6FFA8)

    /** rgba(156,255,107,.6) — the NOW PLAYING eyebrow. */
    val PhosphorDim = Color(0x999CFF6B)

    /* ── Strokes ─────────────────────────────────────────────────────────── */

    /** rgba(140,255,110,α) — every non-accent border in the design. */
    fun edge(alpha: Float) = Color(0xFF8CFF6E).copy(alpha = alpha)

    val Edge18 = edge(0.18f)
    val Edge20 = edge(0.20f)
    val Edge22 = edge(0.22f)
    val Edge28 = edge(0.28f)
    val Edge32 = edge(0.32f)
    val Edge35 = edge(0.35f)
    val Edge40 = edge(0.40f)
    val Edge42 = edge(0.42f)
    val Edge45 = edge(0.45f)
    val Edge50 = edge(0.50f)
    val Edge55 = edge(0.55f)

    /** rgba(246,255,74,α) — the accent used as a stroke rather than a fill. */
    fun accentEdge(alpha: Float) = Accent.copy(alpha = alpha)

    /* ── Fills ───────────────────────────────────────────────────────────── */

    /** rgba(8,22,11,α) — the standard row/chip background. */
    fun panel(alpha: Float) = Color(0xFF08160B).copy(alpha = alpha)

    /** rgba(6,18,9,α) — a slightly cooler panel, used for round buttons. */
    fun panelDeep(alpha: Float) = Color(0xFF061209).copy(alpha = alpha)

    /** rgba(28,32,6,α) / rgba(30,32,6,.75) — the accent chip's own fill. */
    fun accentPanel(alpha: Float) = Color(0xFF1C2006).copy(alpha = alpha)

    /* ── Screen chrome ───────────────────────────────────────────────────── */

    /** The face's warm centre: rgba(20,90,40,.42). */
    val GlowInner = Color(0x6B145A28)

    /** The face's cool surround: rgba(8,40,18,.85). */
    val GlowOuter = Color(0xD9082812)

    /** The rotating radar mesh: rgba(80,200,110,.05) at 50% layer opacity. */
    val Mesh = Color(0x0D50C86E)

    /** One scanline: rgba(0,255,120,.045), 1px lit in every 3. */
    val Scanline = Color(0x0B00FF78)

    /** The inner vignette that rounds the panel off: rgba(0,0,0,.85). */
    val Vignette = Color(0xD9000000)

    /** The always-on dim sheet: rgba(0,0,0,.62). */
    val AmbientDim = Color(0x9E000000)

    /** A cartridge/cover plate: radial from rgba(24,96,44,.85) to rgba(2,8,4,.96). */
    val CoverTop = Color(0xD918602C)
    val CoverBottom = Color(0xF5020804)

    /** The selected library row's fill: rgba(24,64,30,.92) → rgba(8,26,13,.96). */
    val SelectedTop = Color(0xEB18401E)
    val SelectedBottom = Color(0xF5081A0D)

    /** The CONTINUE dial: radial rgba(20,86,38,.85) → rgba(4,14,7,.95). */
    val DialTop = Color(0xD9145626)
    val DialBottom = Color(0xF2040E07)
}

/**
 * The ambient counterparts for the launcher.
 *
 * Same rule as [ShmupxAmbientPalette]: dimmer, and drawn as outline rather than
 * fill. The launcher's own answer to ambient is mostly to draw much less of
 * itself — see `AmbientScreen` — so this is a small set.
 */
object DesignAmbientPalette {
    val Phosphor = Color(0xFF2E6B33)
    val Accent = Color(0xFF7A7F25)
    val Bright = Color(0xFF9AA894)
    val Label = Color(0xFF6E7A66)
}
