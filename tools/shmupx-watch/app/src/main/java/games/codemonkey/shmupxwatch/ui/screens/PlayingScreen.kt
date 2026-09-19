package games.codemonkey.shmupxwatch.ui.screens

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.wear.compose.material3.Text
import games.codemonkey.shmupxwatch.catalog.CatalogClient
import games.codemonkey.shmupxwatch.ui.GameIcon
import games.codemonkey.shmupxwatch.ui.HintLine
import games.codemonkey.shmupxwatch.ui.MenuGlyph
import games.codemonkey.shmupxwatch.ui.PauseGlyph
import games.codemonkey.shmupxwatch.ui.PlayGlyph
import games.codemonkey.shmupxwatch.ui.RoundGlyphButton
import games.codemonkey.shmupxwatch.ui.StatusDot
import games.codemonkey.shmupxwatch.ui.StopGlyph
import games.codemonkey.shmupxwatch.ui.theme.DesignPalette
import games.codemonkey.shmupxwatch.ui.theme.DesignType

/**
 * The remote control for whatever is running on the desktop.
 *
 * Every value here is the desktop's, not the watch's: the transport state, the
 * volume, the clock. The watch sends a command and waits to be told what
 * happened, so two watches — or a watch and the desktop's own keyboard — never
 * disagree about whether the game is paused.
 */
@Composable
fun PlayingScreen(
    title: String,
    iconUrl: String?,
    initials: String,
    clock: String,
    volume: Int,
    paused: Boolean,
    client: CatalogClient,
    onLibrary: () -> Unit,
    onTogglePause: () -> Unit,
    onStop: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier = modifier
            .fillMaxSize()
            .padding(horizontal = 27.dp, vertical = 23.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Row(
            horizontalArrangement = Arrangement.spacedBy(4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            StatusDot(
                color = DesignPalette.Phosphor,
                size = 5.dp,
                // Stops breathing when the game does.
                animate = !paused,
                periodMillis = 2000,
            )
            Text(
                text = if (paused) "PAUSED" else "NOW PLAYING",
                style = DesignType.Caption,
                color = DesignPalette.PhosphorDim,
                maxLines = 1,
            )
        }

        Spacer(Modifier.height(7.dp))

        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            GameIcon(
                iconUrl = iconUrl,
                initials = initials,
                size = 26.dp,
                client = client,
                color = DesignPalette.Accent,
                contentPadding = 3.dp,
                modifier = Modifier
                    .size(26.dp)
                    .clip(RoundedCornerShape(6.dp))
                    .background(
                        Brush.radialGradient(
                            colors = listOf(DesignPalette.CoverTop, DesignPalette.CoverBottom),
                            center = Offset.Unspecified,
                        ),
                    )
                    .border(BorderStroke(1.dp, DesignPalette.Edge40), RoundedCornerShape(6.dp)),
            )
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = title,
                    style = DesignType.RowTitle,
                    color = DesignPalette.Chalk,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(
                    text = clock,
                    style = DesignType.Caption,
                    color = DesignPalette.LabelHint,
                    maxLines = 1,
                )
            }
        }

        Spacer(Modifier.height(8.dp))

        VolumeMeter(volume = volume)

        Spacer(Modifier.height(11.dp))

        Row(
            horizontalArrangement = Arrangement.spacedBy(5.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            RoundGlyphButton(onClick = onLibrary) {
                MenuGlyph(size = 16.dp, color = DesignPalette.Label)
            }
            RoundGlyphButton(
                onClick = onTogglePause,
                diameter = 56.dp,
                borderColor = DesignPalette.Edge55,
                background = DesignPalette.panel(0.90f),
            ) {
                if (paused) {
                    PlayGlyph(size = 22.dp, color = DesignPalette.Bright)
                } else {
                    PauseGlyph(size = 22.dp, color = DesignPalette.Bright)
                }
            }
            RoundGlyphButton(
                onClick = onStop,
                borderColor = DesignPalette.DangerBorder,
                background = DesignPalette.DangerFill,
            ) {
                StopGlyph(size = 14.dp, color = DesignPalette.Danger)
            }
        }

        Spacer(Modifier.height(5.dp))
        // The design says "COVER SCREEN TO STOP". A Pixel Watch has no
        // proximity sensor and palm-cover is already the system's own
        // sleep gesture, so what this app can honestly offer is: when the
        // screen dims, the game pauses. That is what the hint says.
        HintLine("CROWN = VOLUME · DIM PAUSES")
    }
}

/** The design's ten-segment meter, lit up to [volume]. */
@Composable
private fun VolumeMeter(volume: Int) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(5.dp),
    ) {
        Text(
            text = "VOL",
            style = DesignType.Caption,
            color = DesignPalette.LabelDim,
            maxLines = 1,
        )
        Row(
            modifier = Modifier
                .weight(1f)
                .height(8.dp)
                .clip(RoundedCornerShape(percent = 50))
                .background(DesignPalette.panelDeep(0.80f))
                .border(
                    BorderStroke(1.dp, DesignPalette.Edge28),
                    RoundedCornerShape(percent = 50),
                )
                .padding(horizontal = 2.dp, vertical = 1.5.dp),
            horizontalArrangement = Arrangement.spacedBy(1.dp),
        ) {
            repeat(10) { index ->
                Box(
                    modifier = Modifier
                        .weight(1f)
                        .fillMaxSize()
                        .clip(RoundedCornerShape(1.dp))
                        .background(
                            if (index < volume) {
                                DesignPalette.Phosphor
                            } else {
                                DesignPalette.edge(0.16f)
                            },
                        ),
                )
            }
        }
        Text(
            text = "${volume * 10}",
            style = DesignType.Caption,
            color = DesignPalette.Accent,
            maxLines = 1,
        )
    }
}
