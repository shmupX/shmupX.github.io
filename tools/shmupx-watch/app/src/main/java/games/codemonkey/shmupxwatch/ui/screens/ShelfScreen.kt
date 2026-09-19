package games.codemonkey.shmupxwatch.ui.screens

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.wear.compose.material3.Text
import games.codemonkey.shmupxwatch.catalog.ShelfItem
import games.codemonkey.shmupxwatch.catalog.ShelfKind
import games.codemonkey.shmupxwatch.ui.HintLine
import games.codemonkey.shmupxwatch.ui.theme.DesignPalette
import games.codemonkey.shmupxwatch.ui.theme.DesignType

/**
 * The Dezaemon shelf: 262 Saturn saves, scrubbed with the crown.
 *
 * A coverflow rather than a list, because at 262 entries a list is a scroll bar
 * with nothing to hold on to. The A–Z band down the left is the only real
 * navigation aid — it tells you where in the alphabet the crown has got to
 * without your having to read a title.
 *
 * Covers are not fetched. Each is a ~50 KB base64 data URL in a separate
 * database node; pulling them while a finger is on the crown would be 262
 * requests for pictures nobody looked at. The plate shows the title set in
 * Orbitron instead, which is what the design draws for an uncovered save
 * anyway.
 */
@Composable
fun ShelfScreen(
    kind: ShelfKind,
    items: List<ShelfItem>,
    index: Int,
    onOpen: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val current = items.getOrNull(index)

    Column(
        modifier = modifier
            .fillMaxSize()
            .padding(top = 16.dp, bottom = 13.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(
            text = kind.label,
            style = DesignType.ScreenTitle,
            color = DesignPalette.LabelDim,
            maxLines = 1,
        )
        Text(
            text = if (items.isEmpty()) {
                // The other two shelves live in the launcher page's IndexedDB
                // and cannot be read from here at all, which is a different
                // thing from their being empty, and worth saying.
                if (kind == ShelfKind.DEZAEMON) "EMPTY" else "ON THE DESKTOP ONLY"
            } else {
                "${(index + 1).toString().padStart(3, '0')} / ${items.size} · .SAV"
            },
            style = DesignType.Caption,
            color = DesignPalette.accentEdge(0.95f),
            maxLines = 1,
        )

        Box(modifier = Modifier.weight(1f).fillMaxWidth()) {
            if (items.isNotEmpty()) {
                AlphabetBand(
                    current = bandLetter(current?.title),
                    modifier = Modifier
                        .align(Alignment.CenterStart)
                        .padding(start = 7.dp),
                )
            }

            Row(
                modifier = Modifier
                    .align(Alignment.Center)
                    .padding(horizontal = 20.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(5.dp),
            ) {
                NeighbourPlate(visible = index > 0)
                CoverPlate(item = current, onClick = onOpen)
                NeighbourPlate(visible = index < items.lastIndex)
            }
        }

        Text(
            text = current?.genre.orEmpty(),
            style = DesignType.Hint,
            color = DesignPalette.LabelDim,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            textAlign = TextAlign.Center,
            modifier = Modifier.widthIn(max = 125.dp),
        )
        HintLine("CROWN SCRUBS A–Z", modifier = Modifier.padding(top = 4.dp))
    }
}

/**
 * `# A B C D E F …`, with a caret on whichever band the crown is in.
 *
 * The design shows a fixed `★ A B C D E F`. Two departures: the shelf really
 * runs the whole alphabet, so the band follows the current letter rather than
 * pretending the collection stops at F — a marker that never moves past E is
 * worse than none — and the design's leading ★, a favourites band, is not
 * implemented, so it is not drawn. `#` takes its place and is real: it is where
 * the titles beginning with punctuation and digits actually live.
 */
@Composable
private fun AlphabetBand(current: Char, modifier: Modifier = Modifier) {
    val letter = current
    val letters = remember(letter) { bandFor(letter) }

    Column(
        modifier = modifier,
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(1.dp),
    ) {
        letters.forEach { candidate ->
            val active = candidate == letter
            Text(
                text = if (active) "▸$candidate" else "$candidate",
                style = DesignType.Caption,
                color = if (active) DesignPalette.Accent else DesignPalette.LabelFaint,
                maxLines = 1,
            )
        }
    }
}

/**
 * The band a title falls in.
 *
 * Non-letters fold to '#', the way the launcher page's own A–Z buckets do.
 * Plenty of these titles start with punctuation or a digit — "-DEVIL
 * DIMENSION- KAKUKAI 2", "A-28" — and without the fold the marker simply never
 * appears for them, which reads as the band being broken.
 */
private fun bandLetter(title: String?): Char {
    val first = title?.trim()?.firstOrNull()?.uppercaseChar() ?: return '#'
    return if (first in 'A'..'Z') first else '#'
}

/** Seven bands centred on the current one, over '#' followed by A–Z. */
private fun bandFor(letter: Char?): List<Char> {
    val bands = listOf('#') + ('A'..'Z')
    val centre = letter?.let { bands.indexOf(it) }?.takeIf { it >= 0 } ?: 0
    val start = (centre - 3).coerceIn(0, (bands.size - 7).coerceAtLeast(0))
    return bands.drop(start).take(7)
}

/** The dimmed shoulder of the next or previous cover. */
@Composable
private fun NeighbourPlate(visible: Boolean) {
    Box(
        modifier = Modifier
            .size(width = 23.dp, height = 31.dp)
            .alpha(if (visible) 0.45f else 0f)
            .clip(RoundedCornerShape(3.dp))
            .background(DesignPalette.panelDeep(0.70f))
            .border(BorderStroke(1.dp, DesignPalette.Edge20), RoundedCornerShape(3.dp)),
    )
}

/** The selected cover: a scanlined plate with the title set into it. */
@Composable
private fun CoverPlate(item: ShelfItem?, onClick: () -> Unit) {
    Column(
        modifier = Modifier
            .width(86.dp)
            .clip(RoundedCornerShape(6.dp))
            .background(
                Brush.verticalGradient(
                    listOf(DesignPalette.SelectedTop, DesignPalette.CoverBottom),
                ),
            )
            .border(BorderStroke(2.dp, DesignPalette.Accent), RoundedCornerShape(6.dp))
            .clickable(enabled = item != null, onClick = onClick)
            .padding(5.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .height(48.dp)
                .clip(RoundedCornerShape(3.dp))
                .background(
                    Brush.radialGradient(
                        colors = listOf(DesignPalette.CoverTop, DesignPalette.CoverBottom),
                        center = Offset.Unspecified,
                    ),
                )
                .border(BorderStroke(1.dp, DesignPalette.Edge40), RoundedCornerShape(3.dp))
                .padding(3.dp),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                // A shelf title can be "ALICE FANTASIA ~AUTUMN~". At the
                // design's 11 sp in a 66 dp plate that broke mid-word into
                // "-DEVIL / DIMENS / ION-"; the plate is wider here and the
                // type a step smaller so words survive the wrap.
                text = item?.title ?: "—",
                style = DesignType.RowTitle.copy(fontSize = 9.sp, letterSpacing = 0.sp),
                color = DesignPalette.Bright,
                textAlign = TextAlign.Center,
                maxLines = 4,
                overflow = TextOverflow.Ellipsis,
            )
        }
        Text(
            // 49 of the 262 saves never matched the games database and have no
            // developer at all. An em dash says so; an empty line looks broken.
            text = item?.developer?.takeIf { it.isNotBlank() } ?: "—",
            style = DesignType.Caption,
            color = DesignPalette.LabelDim,
            textAlign = TextAlign.Center,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}
