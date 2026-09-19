package games.codemonkey.shmupxwatch.ui

import android.graphics.BitmapFactory
import android.util.Base64
import androidx.compose.foundation.Canvas
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.FilterQuality
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntSize
import games.codemonkey.shmupxwatch.bridge.PreviewFrame
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * Draws a base64 PNG from the preview tool at an integer scale with filtering
 * off. Both details matter for pixel art: a fractional scale smears the grid,
 * and the default bilinear sampling turns a 16x16 sprite into porridge.
 */
@Composable
fun SpriteCanvas(
    frame: PreviewFrame?,
    modifier: Modifier = Modifier,
    tint: Color? = null,
    maxScale: Int = 12,
) {
    // Keyed on revision so a same-sized redraw from the daemon still decodes.
    val bitmap: ImageBitmap? = remember(frame?.objectId, frame?.revision) {
        frame?.pngBase64?.let(::decodeSprite)
    }

    Canvas(modifier = modifier) {
        val image = bitmap ?: return@Canvas
        drawSprite(image, tint, maxScale)
    }
}

private fun DrawScope.drawSprite(image: ImageBitmap, tint: Color?, maxScale: Int) {
    if (image.width <= 0 || image.height <= 0) return

    val rawScale = min(size.width / image.width, size.height / image.height)
    val scale = max(1f, min(floor(rawScale), maxScale.toFloat()))

    val drawWidth = image.width * scale
    val drawHeight = image.height * scale

    drawImage(
        image = image,
        srcOffset = IntOffset.Zero,
        srcSize = IntSize(image.width, image.height),
        dstOffset = IntOffset(
            x = ((size.width - drawWidth) / 2f).roundToInt(),
            y = ((size.height - drawHeight) / 2f).roundToInt(),
        ),
        dstSize = IntSize(drawWidth.roundToInt(), drawHeight.roundToInt()),
        // The whole point. Without this you get a blurry mess.
        filterQuality = FilterQuality.None,
        colorFilter = tint?.let { androidx.compose.ui.graphics.ColorFilter.tint(it) },
    )
}

/**
 * Accepts either a bare base64 string or a full `data:image/png;base64,...`
 * URI, because tool authors are inconsistent about which one they return.
 */
fun decodeSprite(base64: String): ImageBitmap? = runCatching {
    val payload = base64.substringAfterLast(',').trim()
    val bytes = Base64.decode(payload, Base64.DEFAULT)
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size)?.asImageBitmap()
}.getOrNull()
