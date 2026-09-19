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
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.wear.compose.material3.Text
import games.codemonkey.shmupxwatch.catalog.CatalogClient
import games.codemonkey.shmupxwatch.catalog.LibraryItem
import games.codemonkey.shmupxwatch.ui.GameIcon
import games.codemonkey.shmupxwatch.ui.HintLine
import games.codemonkey.shmupxwatch.ui.MicGlyph
import games.codemonkey.shmupxwatch.ui.TagChip
import games.codemonkey.shmupxwatch.ui.theme.DesignPalette
import games.codemonkey.shmupxwatch.ui.theme.DesignType

/**
 * The library: five rows, the middle one selected.
 *
 * This is a carousel rather than a scrolling list, which is the design's call
 * and the right one for a crown. The neighbours are drawn smaller and dimmer so
 * the eye lands on the middle without having to read anything — the same trick
 * `ScalingLazyColumn` plays, done explicitly here because the selection is a
 * value the app owns (voice matching and LAUNCH both need to know what is
 * selected) rather than a side effect of where a scroll happened to stop.
 *
 * Touch still works: tapping a neighbour selects it, tapping the middle opens
 * it. The neighbours are under 48 dp and deliberately so — a mis-tap moves the
 * selection by one, which is visible and instantly undone. The only row that
 * *commits* to anything is the middle one, and that one is given the height.
 */
@Composable
fun LibraryScreen(
    items: List<LibraryItem>,
    selected: Int,
    kindLabel: String,
    totalCount: Int,
    client: CatalogClient,
    onSelect: (Int) -> Unit,
    onOpen: (Int) -> Unit,
    onVoice: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier = modifier
            .fillMaxSize()
            .padding(top = 17.dp, bottom = 15.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(
            text = "LIBRARY · $totalCount",
            style = DesignType.ScreenTitle,
            color = DesignPalette.LabelDim,
            maxLines = 1,
        )
        Text(
            text = kindLabel,
            style = DesignType.Caption,
            color = DesignPalette.accentEdge(0.95f),
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )

        Column(
            modifier = Modifier
                .weight(1f)
                .fillMaxWidth(),
            verticalArrangement = Arrangement.spacedBy(3.5.dp, Alignment.CenterVertically),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            if (items.isEmpty()) {
                Text(
                    text = "NO GAMES",
                    style = DesignType.Caption,
                    color = DesignPalette.LabelFaint,
                )
            } else {
                // The design's r0..r4 around `sel`, wrapping, so a list of
                // three still fills five slots instead of leaving holes.
                listOf(-2, -1, 0, 1, 2).forEach { offset ->
                    val index = wrap(selected + offset, items.size)
                    when (offset) {
                        0 -> SelectedRow(
                            item = items[index],
                            client = client,
                            onClick = { onOpen(index) },
                        )

                        -1, 1 -> NearRow(
                            item = items[index],
                            client = client,
                            onClick = { onSelect(index) },
                        )

                        else -> FarRow(
                            item = items[index],
                            onClick = { onSelect(index) },
                        )
                    }
                }
            }
        }

        // One short line, because this sits near the bottom of a circle where
        // only about 130 dp of width is left. The design's two-part hint
        // ("SAY PLAY …  |  CROWN TO SCROLL") ran off both edges on the device;
        // the crown half now lives on the INPUT MAP screen instead.
        Row(
            horizontalArrangement = Arrangement.spacedBy(4.dp),
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier
                .clip(RoundedCornerShape(percent = 50))
                .clickable(onClick = onVoice)
                .padding(horizontal = 8.dp, vertical = 3.dp),
        ) {
            MicGlyph(size = 11.dp, color = DesignPalette.accentEdge(0.85f))
            HintLine("SAY \"PLAY…\"", color = DesignPalette.accentEdge(0.85f))
        }
    }
}

private fun wrap(index: Int, size: Int): Int = ((index % size) + size) % size

/** The design's r2: 76 units tall, accent-bordered, the only row that opens. */
@Composable
private fun SelectedRow(
    item: LibraryItem,
    client: CatalogClient,
    onClick: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 6.dp)
            // Design 76 units = 38 dp; lifted to 46 so the one committing
            // control on the screen is within reach of the 48 dp minimum.
            .height(46.dp)
            .clip(RoundedCornerShape(percent = 50))
            .background(
                Brush.verticalGradient(
                    listOf(DesignPalette.SelectedTop, DesignPalette.SelectedBottom),
                ),
            )
            .border(BorderStroke(2.dp, DesignPalette.Accent), RoundedCornerShape(percent = 50))
            .clickable(onClick = onClick)
            .padding(horizontal = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(7.dp),
    ) {
        GameIcon(
            iconUrl = item.iconUrl,
            initials = item.initials,
            size = 28.dp,
            client = client,
            color = DesignPalette.Accent,
            contentPadding = 2.dp,
            modifier = Modifier
                .size(28.dp)
                .clip(RoundedCornerShape(6.dp))
                .background(DesignPalette.Black.copy(alpha = 0.55f))
                .border(
                    BorderStroke(1.dp, DesignPalette.accentEdge(0.55f)),
                    RoundedCornerShape(6.dp),
                ),
        )
        Column(
            modifier = Modifier.weight(1f),
            verticalArrangement = Arrangement.spacedBy(1.dp),
        ) {
            Text(
                text = item.title,
                style = DesignType.ItemTitle,
                color = DesignPalette.Chalk,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                text = item.sub,
                style = DesignType.Caption,
                color = DesignPalette.LabelHint,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        TagChip(item.tag)
    }
}

/** The design's r1/r3: 52 units, two-thirds opacity, icon and title only. */
@Composable
private fun NearRow(
    item: LibraryItem,
    client: CatalogClient,
    onClick: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 20.dp)
            .height(28.dp)
            .alpha(0.66f)
            .clip(RoundedCornerShape(percent = 50))
            .background(DesignPalette.panel(0.70f))
            .border(BorderStroke(1.dp, DesignPalette.Edge28), RoundedCornerShape(percent = 50))
            .clickable(onClick = onClick)
            .padding(horizontal = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(5.dp),
    ) {
        GameIcon(
            iconUrl = item.iconUrl,
            initials = item.initials,
            size = 16.dp,
            client = client,
            color = DesignPalette.LabelDim,
            modifier = Modifier
                .size(16.dp)
                .clip(RoundedCornerShape(4.dp))
                .border(BorderStroke(1.dp, DesignPalette.Edge35), RoundedCornerShape(4.dp)),
        )
        Text(
            text = item.title,
            style = DesignType.RowTitle,
            color = DesignPalette.Label,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
    }
}

/** The design's r0/r4: 42 units, barely there — context, not a target. */
@Composable
private fun FarRow(item: LibraryItem, onClick: () -> Unit) {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 40.dp)
            .height(22.dp)
            .alpha(0.38f)
            .clip(RoundedCornerShape(percent = 50))
            .background(DesignPalette.panel(0.60f))
            .border(BorderStroke(1.dp, DesignPalette.Edge18), RoundedCornerShape(percent = 50))
            .clickable(onClick = onClick)
            .padding(horizontal = 7.dp),
        contentAlignment = Alignment.CenterStart,
    ) {
        Text(
            text = item.title,
            style = DesignType.Caption,
            color = DesignPalette.Label,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}
