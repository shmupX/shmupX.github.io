package games.codemonkey.shmupxwatch.ui

import android.graphics.BitmapFactory
import android.util.LruCache
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.wear.compose.material3.Text
import games.codemonkey.shmupxwatch.catalog.CatalogClient
import games.codemonkey.shmupxwatch.ui.theme.DesignType

/**
 * Game icons, fetched over HTTP and decoded small.
 *
 * No image library. Coil would be the obvious reach, but this app deliberately
 * carries no Play Services and no Firebase SDK for APK size, and the same
 * argument applies here for what is a GET and a `BitmapFactory` call.
 *
 * Downsampling is not an optimisation, it is the whole point:
 * `shmup-party-icon.png` is a 92 KB PNG that the design draws at 48 px. Decoded
 * at native size, eight of those is several megabytes of bitmap on a device
 * with a small heap.
 */
object IconCache {

    /**
     * A few hundred kilobytes of decoded icons. Keyed by url AND target size,
     * because the same icon is drawn at 26 dp in a list row and at 74 dp on the
     * detail screen, and the small decode would look soft blown up.
     */
    private val cache = object : LruCache<String, ImageBitmap>(32) {}

    /**
     * Keys whose bytes arrived and could not be decoded, so a genuinely broken
     * image is not re-fetched on every scroll. A failed *fetch* is deliberately
     * not recorded here — see the call site.
     */
    private val failed = mutableSetOf<String>()

    fun cached(key: String): ImageBitmap? = cache.get(key)

    fun hasFailed(key: String): Boolean = synchronized(failed) { key in failed }

    fun put(key: String, bitmap: ImageBitmap) {
        cache.put(key, bitmap)
    }

    fun markFailed(key: String) {
        synchronized(failed) { failed += key }
    }

    /**
     * Decode at no more than [targetPx], halving until it fits.
     *
     * `inSampleSize` only honours powers of two, so this is the standard
     * two-pass decode: measure with `inJustDecodeBounds`, pick the shift, then
     * decode for real.
     */
    fun decodeScaled(bytes: ByteArray, targetPx: Int): ImageBitmap? = runCatching {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)

        var sample = 1
        var width = bounds.outWidth
        var height = bounds.outHeight
        while (width / 2 >= targetPx && height / 2 >= targetPx) {
            width /= 2
            height /= 2
            sample *= 2
        }

        val options = BitmapFactory.Options().apply { inSampleSize = sample }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options)?.asImageBitmap()
    }.getOrNull()
}

/**
 * A game's icon, or its two-letter monogram while there is not one.
 *
 * The monogram is the resting state, not an error state: four of the catalog's
 * eight rows have no icon at all, and the design draws initials for exactly
 * those. So there is no spinner and no flash — the letters are simply replaced
 * if a picture arrives.
 */
@Composable
fun GameIcon(
    iconUrl: String?,
    initials: String,
    size: Dp,
    client: CatalogClient,
    modifier: Modifier = Modifier,
    color: Color,
    contentPadding: Dp = 0.dp,
) {
    val density = androidx.compose.ui.platform.LocalDensity.current
    val targetPx = remember(size, density) { with(density) { size.roundToPx() } }
    val key = remember(iconUrl, targetPx) { "$iconUrl@$targetPx" }

    var bitmap by remember(key) { mutableStateOf(IconCache.cached(key)) }

    LaunchedEffect(key) {
        if (iconUrl.isNullOrBlank()) return@LaunchedEffect
        if (bitmap != null || IconCache.hasFailed(key)) return@LaunchedEffect
        val bytes = client.fetchBytes(iconUrl)
        if (bytes == null) {
            // NOT marked failed. A null here is any of: no network, a timeout,
            // a 500, or a 404 — and three of those four are temporary. Marking
            // them permanent means one moment out of Wi-Fi leaves the whole
            // library drawing monograms until the app is force-stopped.
            return@LaunchedEffect
        }
        val decoded = IconCache.decodeScaled(bytes, targetPx)
        if (decoded == null) {
            // This one IS permanent: the bytes arrived and were not an image.
            IconCache.markFailed(key)
        } else {
            IconCache.put(key, decoded)
            bitmap = decoded
        }
    }

    Box(modifier = modifier, contentAlignment = Alignment.Center) {
        val image = bitmap
        if (image != null) {
            Image(
                bitmap = image,
                contentDescription = null,
                contentScale = ContentScale.Fit,
                modifier = Modifier
                    .fillMaxSize()
                    .padding(contentPadding),
            )
        } else {
            Text(
                text = initials,
                style = DesignType.Caption,
                color = color,
                textAlign = TextAlign.Center,
                maxLines = 1,
            )
        }
    }
}
