package games.codemonkey.shmupxwatch.ui

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.unit.dp
import games.codemonkey.shmupxwatch.ambient.AmbientState
import games.codemonkey.shmupxwatch.ambient.LocalAmbientState
import games.codemonkey.shmupxwatch.ui.theme.DesignPalette
import kotlin.math.cos
import kotlin.math.sin

/**
 * The CRT the launcher lives inside.
 *
 * Everything here is behind or in front of every screen and belongs to none of
 * them: the phosphor glow, the slowly turning radar mesh, the scanlines, the
 * vignette that rounds the panel off, and the sheet that dims the lot in
 * ambient. The design draws all five on the round face regardless of which of
 * the eight screens is showing, so they are hoisted out rather than repeated
 * eight times.
 *
 * In ambient every animation stops and most of the chrome is dropped. That is
 * not a stylistic call: an animation in ambient is a wake-up a minute, and the
 * guidance is to keep the screen overwhelmingly black. What survives is the
 * vignette, because it costs nothing — it is dark.
 */
@Composable
fun WatchFace(
    modifier: Modifier = Modifier,
    scanlines: Boolean = true,
    content: @Composable BoxScope.() -> Unit,
) {
    val ambient = LocalAmbientState.current
    val isAmbient = ambient.isAmbient

    // One 90-second rotation, exactly as the design's `sxMesh` keyframe. Held
    // at zero in ambient so nothing invalidates while the screen is dim.
    val transition = rememberInfiniteTransition(label = "face")
    val meshAngle by if (isAmbient) {
        androidx.compose.runtime.remember { androidx.compose.runtime.mutableFloatStateOf(0f) }
    } else {
        transition.animateFloat(
            initialValue = 0f,
            targetValue = 360f,
            animationSpec = infiniteRepeatable(
                animation = tween(90_000, easing = LinearEasing),
                repeatMode = RepeatMode.Restart,
            ),
            label = "mesh",
        )
    }

    Box(modifier = modifier.fillMaxSize()) {
        Canvas(Modifier.fillMaxSize()) {
            if (isAmbient) {
                drawRect(DesignPalette.Black)
            } else {
                drawGlow()
                rotate(degrees = meshAngle) { drawMesh() }
            }
        }

        content()

        Canvas(Modifier.fillMaxSize()) {
            if (!isAmbient && scanlines) drawScanlines()
            drawVignette()
            // The design's alwaysOn preview: the real thing is the system
            // dimming the panel, and this is what the app adds on top of it.
            if (isAmbient) drawRect(DesignPalette.AmbientDim)
        }
    }
}

/**
 * Two stacked radial gradients: a warm centre over a cooler surround that goes
 * to black well before the bezel, which is what stops the round panel looking
 * like a square one with corners cut off.
 */
private fun DrawScope.drawGlow() {
    drawRect(DesignPalette.Void)

    val centre = Offset(size.width / 2f, size.height * 0.52f)
    drawCircle(
        brush = Brush.radialGradient(
            colors = listOf(DesignPalette.GlowInner, Color.Transparent),
            center = centre,
            radius = size.minDimension * 0.62f,
        ),
        radius = size.minDimension * 0.62f,
        center = centre,
    )
    drawCircle(
        brush = Brush.radialGradient(
            0.0f to DesignPalette.GlowOuter,
            0.82f to DesignPalette.Black,
            1.0f to DesignPalette.Black,
            center = Offset(size.width / 2f, size.height / 2f),
            radius = size.minDimension * 0.7f,
        ),
        radius = size.minDimension * 0.7f,
        center = Offset(size.width / 2f, size.height / 2f),
    )
}

/**
 * The radar sweep: spokes every 16°, each 2° wide, turning once every 90
 * seconds. The design writes it as a `repeating-conic-gradient`, which Compose
 * has no equivalent for — drawn as the wedges it actually is.
 */
private fun DrawScope.drawMesh() {
    val centre = Offset(size.width / 2f, size.height / 2f)
    // Past the corners, so a rotating square of spokes never shows its edge.
    val reach = size.maxDimension
    var degrees = 0f
    while (degrees < 360f) {
        val radians = Math.toRadians(degrees.toDouble())
        drawLine(
            color = DesignPalette.Mesh,
            start = centre,
            end = Offset(
                x = centre.x + (cos(radians) * reach).toFloat(),
                y = centre.y + (sin(radians) * reach).toFloat(),
            ),
            // 2° of arc at the rim, which is what the gradient's 0°–2° stop is.
            strokeWidth = reach * 0.035f,
        )
        degrees += 16f
    }
}

/** One lit line in every three device pixels, as the design's overlay does. */
private fun DrawScope.drawScanlines() {
    val step = 3.dp.toPx().coerceAtLeast(3f)
    val thickness = step / 3f
    var y = 0f
    while (y < size.height) {
        drawRect(
            color = DesignPalette.Scanline,
            topLeft = Offset(0f, y),
            size = Size(size.width, thickness),
        )
        y += step
    }
}

/**
 * The inner shadow that makes the panel read as glass under a bezel, plus the
 * hairline of phosphor at the very edge. Drawn as a radial gradient from
 * transparent to black over the outer fifth.
 */
private fun DrawScope.drawVignette() {
    val radius = size.minDimension / 2f
    drawCircle(
        brush = Brush.radialGradient(
            0.72f to Color.Transparent,
            1.0f to DesignPalette.Vignette,
            center = Offset(size.width / 2f, size.height / 2f),
            radius = radius,
        ),
        radius = radius,
        center = Offset(size.width / 2f, size.height / 2f),
    )
    drawCircle(
        color = DesignPalette.edge(0.10f),
        radius = radius - 1f,
        center = Offset(size.width / 2f, size.height / 2f),
        style = androidx.compose.ui.graphics.drawscope.Stroke(width = 1f),
    )
}

/** True when the screen should be drawing its low-power self. */
val AmbientState.dim: Boolean get() = this is AmbientState.Ambient
