package games.codemonkey.shmupxwatch.ui.screens

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.wear.compose.foundation.lazy.ScalingLazyColumn
import androidx.wear.compose.foundation.lazy.rememberScalingLazyListState
import androidx.wear.compose.material3.Text
import games.codemonkey.shmupxwatch.DetailTarget
import games.codemonkey.shmupxwatch.catalog.CatalogClient
import games.codemonkey.shmupxwatch.ui.GameIcon
import games.codemonkey.shmupxwatch.ui.HintLine
import games.codemonkey.shmupxwatch.ui.MetaChip
import games.codemonkey.shmupxwatch.ui.RoundGlyphButton
import games.codemonkey.shmupxwatch.ui.StarGlyph
import games.codemonkey.shmupxwatch.ui.theme.DesignPalette
import games.codemonkey.shmupxwatch.ui.theme.DesignType

/**
 * One game, and the button that starts it.
 *
 * Scrolls, unlike the rest of the launcher. A title can be
 * "ALICE FANTASIA ~AUTUMN~" and carry three metadata chips, and on a 228 dp
 * round panel that does not always fit above a 48 dp action — so this one screen
 * is a `ScalingLazyColumn`, which also means the crown scrolls it for free.
 */
@Composable
fun DetailScreen(
    detail: DetailTarget,
    isFavourite: Boolean,
    client: CatalogClient,
    onLaunch: () -> Unit,
    onToggleFavourite: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val listState = rememberScalingLazyListState()

    ScalingLazyColumn(
        modifier = modifier.fillMaxSize(),
        state = listState,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        item {
            GameIcon(
                iconUrl = detail.iconUrl,
                initials = detail.initials,
                size = 37.dp,
                client = client,
                color = DesignPalette.Accent,
                contentPadding = 4.dp,
                modifier = Modifier
                    .size(37.dp)
                    .clip(RoundedCornerShape(8.dp))
                    .background(
                        Brush.radialGradient(
                            colors = listOf(DesignPalette.CoverTop, DesignPalette.CoverBottom),
                            center = Offset.Unspecified,
                        ),
                    )
                    .border(BorderStroke(1.dp, DesignPalette.Edge45), RoundedCornerShape(8.dp)),
            )
        }

        item {
            Text(
                text = detail.title,
                style = DesignType.ItemTitle,
                color = DesignPalette.Chalk,
                textAlign = TextAlign.Center,
                maxLines = 3,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(horizontal = 14.dp, vertical = 5.dp),
            )
        }

        if (detail.sub.isNotBlank()) {
            item {
                Text(
                    text = detail.sub,
                    style = DesignType.Sub,
                    color = DesignPalette.LabelDim,
                    textAlign = TextAlign.Center,
                    maxLines = 3,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.padding(horizontal = 16.dp),
                )
            }
        }

        if (detail.meta.isNotEmpty()) {
            item {
                // Chips wrap by hand rather than with FlowRow: the Compose
                // flow layouts are still experimental and three short chips
                // only ever need one break.
                Column(
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(3.dp),
                    modifier = Modifier.padding(top = 6.dp),
                ) {
                    detail.meta.chunked(2).forEach { row ->
                        Row(horizontalArrangement = Arrangement.spacedBy(3.dp)) {
                            row.forEach { MetaChip(it) }
                        }
                    }
                }
            }
        }

        item { Spacer(Modifier.height(8.dp)) }

        item {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(5.dp),
            ) {
                RoundGlyphButton(
                    onClick = onToggleFavourite,
                    borderColor = DesignPalette.accentEdge(0.45f),
                    background = DesignPalette.accentPanel(0.70f),
                ) {
                    StarGlyph(size = 18.dp, color = DesignPalette.Accent, filled = isFavourite)
                }

                LaunchButton(onClick = onLaunch)
            }
        }

        item {
            HintLine(
                text = "→ CMG-DESKTOP",
                modifier = Modifier.padding(top = 6.dp),
            )
        }
    }
}

/** The one loud control in the app. Filled accent, 48 dp, unmistakable. */
@Composable
private fun LaunchButton(onClick: () -> Unit) {
    Box(
        modifier = Modifier
            .width(96.dp)
            .height(48.dp)
            .clip(RoundedCornerShape(percent = 50))
            .background(
                Brush.verticalGradient(
                    listOf(DesignPalette.Accent, DesignPalette.AccentDeep),
                ),
            )
            .border(BorderStroke(2.dp, DesignPalette.Accent), RoundedCornerShape(percent = 50))
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = "LAUNCH",
            style = DesignType.Action,
            color = DesignPalette.OnAccent,
            maxLines = 1,
        )
    }
}
