package games.codemonkey.shmupxwatch.ui.theme

import androidx.compose.ui.text.ExperimentalTextApi
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontVariation
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import games.codemonkey.shmupxwatch.R

/**
 * The design's two faces.
 *
 * `Orbitron` (variable, wght 400–900) carries titles and anything that should
 * read as the machine talking about itself. `Share Tech Mono` carries data:
 * timings, counts, hints, the things that want a fixed advance so a changing
 * number does not shuffle the words beside it. The handoff uses them exactly
 * this way and the split is worth keeping — it is most of why the mock reads as
 * a CRT rather than as a phone app.
 *
 * Both are vendored from the site's own `static/fonts/` (SIL OFL 1.1 — see
 * `licenses/`), not fetched from Google Fonts: a watch is often the thing with
 * no network, and a blocking webfont is a blank screen.
 *
 * Neither face carries the design's symbols — `◉ ≡ ■ ❚ ★ ☆ ◂ ▸ →` are all
 * absent from both cmaps — so those are drawn as vectors in
 * `ui/Glyphs.kt` rather than set as text. Left as text they would silently fall
 * back to the system sans and land at a different weight and size than the
 * phosphor UI around them.
 */

private val OrbitronVariable = R.font.orbitron_variable

/**
 * Orbitron at one weight, through the variable axis rather than a static cut.
 *
 * The opt-in is for `FontVariation`. Setting the `wght` axis explicitly is the
 * point of shipping the variable face: left to weight-matching alone, every
 * weight the design asks for that the font does not name as an instance gets
 * rounded to one that it does, and the 800/900 titles come back as 700.
 */
@OptIn(ExperimentalTextApi::class)
private fun orbitron(weight: FontWeight) = FontFamily(
    Font(
        OrbitronVariable,
        weight = weight,
        variationSettings = FontVariation.Settings(FontVariation.weight(weight.weight)),
    ),
)

object DesignFonts {
    /** Body/label weight — the design's 700. */
    val Orbitron: FontFamily = orbitron(FontWeight.Bold)

    /** Titles — the design's 800. */
    val OrbitronHeavy: FontFamily = orbitron(FontWeight.ExtraBold)

    /** The loudest thing on screen: LAUNCH, SHMUPX — the design's 900. */
    val OrbitronBlack: FontFamily = orbitron(FontWeight.Black)

    /** Everything monospace. */
    val Mono: FontFamily = FontFamily(Font(R.font.share_tech_mono, FontWeight.Normal))
}

/**
 * Named text styles, one per role in the handoff.
 *
 * The scale here was set on a real Pixel Watch 5, not derived. The arithmetic
 * says one design unit is half a dp — the mock is a 456-unit square and the
 * panel is 480 px at density 320, so 240 dp across — which turns the design's
 * 10-unit captions into 5 sp. That is unreadable, so the small end is lifted to
 * 10 sp.
 *
 * Lifting the small end without lifting the large end is the whole trick.
 * Orbitron is a very wide face: at the design's nominal 14 sp, "SUPER MARIO SP"
 * overruns a library row on the device and ellipsises to "SUPER MA…". Titles
 * therefore sit at 12 sp, which is where a 14-character title fits the widest
 * row on a 240 dp circle with its icon and its tag beside it. Verified on
 * hardware; do not raise these without looking at a real row again.
 *
 * Letter-spacing is kept as the design's em values, which survive the size
 * change unchanged — the wide tracking is most of the look.
 */
object DesignType {

    /** SHMUPX on the tile. Design: 15px/900/.3em. */
    val Wordmark = TextStyle(
        fontFamily = DesignFonts.OrbitronBlack,
        fontSize = 13.sp,
        fontWeight = FontWeight.Black,
        letterSpacing = 0.24.em,
    )

    /** A screen's title line. Design: 11px mono/.24em. */
    val ScreenTitle = TextStyle(
        fontFamily = DesignFonts.Mono,
        fontSize = 10.sp,
        letterSpacing = 0.18.em,
    )

    /** The selected row's and the detail screen's title. Design: 14–15px/800. */
    val ItemTitle = TextStyle(
        fontFamily = DesignFonts.OrbitronHeavy,
        fontSize = 12.sp,
        fontWeight = FontWeight.ExtraBold,
        letterSpacing = 0.02.em,
    )

    /** An unselected row's title. Design: 11px/700/.06em. */
    val RowTitle = TextStyle(
        fontFamily = DesignFonts.Orbitron,
        fontSize = 11.sp,
        fontWeight = FontWeight.Bold,
        letterSpacing = 0.02.em,
    )

    /** The subtitle under a title. Design: 10px mono/.1em — lifted to 10 sp. */
    val Sub = TextStyle(
        fontFamily = DesignFonts.Mono,
        fontSize = 10.sp,
        letterSpacing = 0.04.em,
    )

    /** Metadata chips, hints, the status eyebrow. Design: 9–10px mono. */
    val Caption = TextStyle(
        fontFamily = DesignFonts.Mono,
        fontSize = 10.sp,
        letterSpacing = 0.08.em,
    )

    /** The quietest line on a screen — the gesture hint at the foot. */
    val Hint = TextStyle(
        fontFamily = DesignFonts.Mono,
        fontSize = 10.sp,
        letterSpacing = 0.06.em,
    )

    /** CONTINUE / LIBRARY / SHELF / CANCEL — a control's own label. */
    val Button = TextStyle(
        fontFamily = DesignFonts.Mono,
        fontSize = 10.sp,
        letterSpacing = 0.12.em,
    )

    /** LAUNCH. Design: 14px/900/.2em. */
    val Action = TextStyle(
        fontFamily = DesignFonts.OrbitronBlack,
        fontSize = 13.sp,
        fontWeight = FontWeight.Black,
        letterSpacing = 0.14.em,
    )

    /** What the watch heard, on the voice screen. Design: 15px/700. */
    val Heard = TextStyle(
        fontFamily = DesignFonts.Orbitron,
        fontSize = 13.sp,
        fontWeight = FontWeight.Bold,
        letterSpacing = 0.02.em,
    )
}
