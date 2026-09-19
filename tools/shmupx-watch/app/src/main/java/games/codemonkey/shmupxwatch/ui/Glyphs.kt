package games.codemonkey.shmupxwatch.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Fill
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import kotlin.math.cos
import kotlin.math.min
import kotlin.math.sin

/**
 * The design's symbols, drawn rather than typed.
 *
 * `◉ ≡ ■ ❚❚ ▶ ★ ☆ ◂ ▸ →` are in neither Orbitron nor Share Tech Mono — both
 * cmaps were checked. Set as text they do not vanish, which is worse than if
 * they did: Android silently falls back to the system sans, so the transport
 * controls end up in a different face, at a different optical weight, from
 * every other mark on the screen. At 12–16 px on a wrist that reads as a bug.
 *
 * Drawn as paths they also scale with the control instead of with the font, and
 * they stay crisp at the sizes the design uses them.
 */
@Composable
fun PlayGlyph(size: Dp, color: Color, modifier: Modifier = Modifier) {
    Canvas(modifier.size(size)) { drawPlay(color) }
}

@Composable
fun PauseGlyph(size: Dp, color: Color, modifier: Modifier = Modifier) {
    Canvas(modifier.size(size)) { drawPause(color) }
}

@Composable
fun StopGlyph(size: Dp, color: Color, modifier: Modifier = Modifier) {
    Canvas(modifier.size(size)) { drawStop(color) }
}

@Composable
fun MenuGlyph(size: Dp, color: Color, modifier: Modifier = Modifier) {
    Canvas(modifier.size(size)) { drawMenu(color) }
}

@Composable
fun BackGlyph(size: Dp, color: Color, modifier: Modifier = Modifier) {
    Canvas(modifier.size(size)) { drawChevron(color, pointingLeft = true) }
}

@Composable
fun MicGlyph(size: Dp, color: Color, modifier: Modifier = Modifier) {
    Canvas(modifier.size(size)) { drawTarget(color) }
}

@Composable
fun StarGlyph(size: Dp, color: Color, filled: Boolean, modifier: Modifier = Modifier) {
    Canvas(modifier.size(size)) { drawStar(color, filled) }
}

/* ─── The paths ─────────────────────────────────────────────────────────── */

/** ▶ — a triangle, nudged right so it reads as centred inside a circle. */
private fun DrawScope.drawPlay(color: Color) {
    val s = size.minDimension
    val inset = s * 0.26f
    val path = Path().apply {
        moveTo(inset + s * 0.06f, inset)
        lineTo(s - inset + s * 0.06f, s / 2f)
        lineTo(inset + s * 0.06f, s - inset)
        close()
    }
    drawPath(path, color, style = Fill)
}

/** ❚❚ — two bars with a gap of the same width. */
private fun DrawScope.drawPause(color: Color) {
    val s = size.minDimension
    val barWidth = s * 0.17f
    val gap = s * 0.16f
    val height = s * 0.52f
    val top = (s - height) / 2f
    val left = (s - (barWidth * 2 + gap)) / 2f
    drawRect(color, Offset(left, top), Size(barWidth, height))
    drawRect(color, Offset(left + barWidth + gap, top), Size(barWidth, height))
}

/** ■ */
private fun DrawScope.drawStop(color: Color) {
    val s = size.minDimension
    val side = s * 0.46f
    val offset = (s - side) / 2f
    drawRect(color, Offset(offset, offset), Size(side, side))
}

/** ≡ — three rules. */
private fun DrawScope.drawMenu(color: Color) {
    val s = size.minDimension
    val width = s * 0.58f
    val left = (s - width) / 2f
    val thickness = s * 0.085f
    listOf(0.32f, 0.5f, 0.68f).forEach { fraction ->
        drawRect(
            color = color,
            topLeft = Offset(left, s * fraction - thickness / 2f),
            size = Size(width, thickness),
        )
    }
}

/** ◂ / ▸ — the back chevron and the shelf band marker. */
private fun DrawScope.drawChevron(color: Color, pointingLeft: Boolean) {
    val s = size.minDimension
    val stroke = s * 0.12f
    val tipX = if (pointingLeft) s * 0.38f else s * 0.62f
    val backX = if (pointingLeft) s * 0.60f else s * 0.40f
    val path = Path().apply {
        moveTo(backX, s * 0.30f)
        lineTo(tipX, s * 0.50f)
        lineTo(backX, s * 0.70f)
    }
    drawPath(path, color, style = Stroke(width = stroke))
}

/**
 * ◉ — the listening target: a filled disc inside a ring, the mark the design
 * uses for the voice button and the mic itself.
 */
private fun DrawScope.drawTarget(color: Color) {
    val s = size.minDimension
    val centre = Offset(s / 2f, s / 2f)
    drawCircle(color, radius = s * 0.42f, center = centre, style = Stroke(width = s * 0.09f))
    drawCircle(color, radius = s * 0.20f, center = centre)
}

/** ★ / ☆ — a five-pointed star, filled or outlined. */
private fun DrawScope.drawStar(color: Color, filled: Boolean) {
    val s = size.minDimension
    val centre = Offset(s / 2f, s / 2f)
    val outer = s * 0.42f
    val inner = outer * 0.45f
    val path = Path()
    // Start at the top point: -90°, then alternate outer/inner every 36°.
    for (index in 0 until 10) {
        val radius = if (index % 2 == 0) outer else inner
        val angle = Math.toRadians((-90 + index * 36).toDouble())
        val x = centre.x + (cos(angle) * radius).toFloat()
        val y = centre.y + (sin(angle) * radius).toFloat()
        if (index == 0) path.moveTo(x, y) else path.lineTo(x, y)
    }
    path.close()
    drawPath(
        path = path,
        color = color,
        style = if (filled) Fill else Stroke(width = min(s * 0.09f, 3f)),
    )
}

/** An arrow, for the "→ CMG-DESKTOP" hand-off lines. */
@Composable
fun ArrowGlyph(size: Dp = 10.dp, color: Color, modifier: Modifier = Modifier) {
    Canvas(modifier.size(size)) {
        val s = this.size.minDimension
        val mid = s / 2f
        val stroke = s * 0.11f
        drawLine(color, Offset(s * 0.18f, mid), Offset(s * 0.78f, mid), strokeWidth = stroke)
        val head = Path().apply {
            moveTo(s * 0.58f, mid - s * 0.18f)
            lineTo(s * 0.84f, mid)
            lineTo(s * 0.58f, mid + s * 0.18f)
        }
        drawPath(head, color, style = Stroke(width = stroke))
    }
}
