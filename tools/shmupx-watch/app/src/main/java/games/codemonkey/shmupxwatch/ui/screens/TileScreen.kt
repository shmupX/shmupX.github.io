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
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
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
import androidx.wear.compose.material3.Text
import games.codemonkey.shmupxwatch.bridge.ConnectionState
import games.codemonkey.shmupxwatch.ui.HintLine
import games.codemonkey.shmupxwatch.ui.MicGlyph
import games.codemonkey.shmupxwatch.ui.PillButton
import games.codemonkey.shmupxwatch.ui.RoundGlyphButton
import games.codemonkey.shmupxwatch.ui.Separator
import games.codemonkey.shmupxwatch.ui.StatusDot
import games.codemonkey.shmupxwatch.ui.theme.DesignPalette
import games.codemonkey.shmupxwatch.ui.theme.DesignType

/**
 * The home screen: who we are paired with, and the one thing you probably came
 * here to do.
 *
 * The big dial is the design's argument, and it is a good one — the most common
 * action on a launcher is "carry on with the thing I was playing", so that gets
 * a 90 dp target in the middle of the screen and everything else gets a pill at
 * the bottom. The dial is the only control here that is deliberately much
 * larger than it needs to be.
 */
@Composable
fun TileScreen(
    connection: ConnectionState,
    hostLabel: String,
    lastTitle: String?,
    lastSub: String,
    onResume: () -> Unit,
    onLibrary: () -> Unit,
    onVoice: () -> Unit,
    onShelf: () -> Unit,
    onShowInputMap: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier = modifier
            .fillMaxSize()
            // Design: 46/52/44 units → 23/26/22 dp.
            .padding(start = 18.dp, end = 18.dp, top = 14.dp, bottom = 30.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        // The status line doubles as the way into the input map. The design
        // reached every screen from a nav rail beside the watch, which does not
        // exist on a wrist — and "what is this thing paired to, and what can I
        // do with it" is one question, so it is one target.
        Row(
            horizontalArrangement = Arrangement.spacedBy(4.dp),
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier
                .clip(RoundedCornerShape(percent = 50))
                .clickable(onClick = onShowInputMap)
                .padding(horizontal = 6.dp, vertical = 4.dp),
        ) {
            StatusDot(
                color = when (connection) {
                    ConnectionState.CONNECTED -> DesignPalette.Phosphor
                    ConnectionState.DEMO -> DesignPalette.Accent
                    else -> DesignPalette.Danger
                },
                size = 6.dp,
                // Breathing means "live". A dead link should not look alive.
                animate = connection == ConnectionState.CONNECTED || connection == ConnectionState.DEMO,
            )
            Text(
                text = hostLabel,
                style = DesignType.Caption,
                color = DesignPalette.LabelDim,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Separator()
            Text(
                text = when (connection) {
                    ConnectionState.CONNECTED -> "LIVE"
                    ConnectionState.CONNECTING -> "…"
                    ConnectionState.DEMO -> "DEMO"
                    ConnectionState.DISCONNECTED -> "OFFLINE"
                },
                style = DesignType.Caption,
                color = DesignPalette.LabelDim,
                maxLines = 1,
            )
        }

        Spacer(Modifier.height(5.dp))
        Text(
            text = "SHMUPX",
            style = DesignType.Wordmark,
            color = DesignPalette.Bright,
        )
        Text(
            text = "WATCH",
            style = DesignType.Caption,
            color = DesignPalette.LabelDim,
        )

        Spacer(Modifier.weight(1f))

        // The design's 186-unit dial is 93 dp. Cut to 76: the header, the dial
        // and a 48 dp control row have to share 227 dp of height on the
        // smallest round panel this targets, and the row is the part that
        // cannot shrink — 48 dp is the minimum touch target.
        ContinueDial(
            title = lastTitle,
            sub = lastSub,
            onClick = onResume,
            modifier = Modifier.size(76.dp),
        )

        Spacer(Modifier.weight(1f))

        Row(
            horizontalArrangement = Arrangement.spacedBy(4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            PillButton(label = "LIBRARY", onClick = onLibrary)
            RoundGlyphButton(
                onClick = onVoice,
                borderColor = DesignPalette.accentEdge(0.55f),
                background = DesignPalette.accentPanel(0.75f),
            ) {
                MicGlyph(size = 18.dp, color = DesignPalette.Accent)
            }
            PillButton(label = "SHELF", onClick = onShelf)
        }
    }
}

/**
 * CONTINUE. Shows the last thing played, or invites a first one.
 *
 * Kept tappable either way: with nothing to resume it goes to the library
 * rather than being a dead circle, because a disabled control in the middle of
 * the home screen reads as a broken app.
 */
@Composable
private fun ContinueDial(
    title: String?,
    sub: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Box(
        modifier = modifier
            .clip(CircleShape)
            .background(
                Brush.radialGradient(
                    colors = listOf(DesignPalette.DialTop, DesignPalette.DialBottom),
                    center = Offset.Unspecified,
                ),
            )
            .border(BorderStroke(2.dp, DesignPalette.Edge50), CircleShape)
            .clickable(onClick = onClick)
            .padding(7.dp),
        contentAlignment = Alignment.Center,
    ) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            Text(
                text = if (title != null) "CONTINUE" else "START",
                style = DesignType.Caption,
                color = DesignPalette.accentEdge(0.85f),
                maxLines = 1,
            )
            Text(
                text = title ?: "PICK A GAME",
                style = DesignType.ItemTitle,
                color = DesignPalette.Bright,
                textAlign = TextAlign.Center,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.widthIn(max = 62.dp),
            )
            if (sub.isNotBlank()) {
                Text(
                    text = sub,
                    style = DesignType.Caption,
                    color = DesignPalette.LabelDim,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}

/** The design's foot hint, hoisted so the nav can place it consistently. */
@Composable
fun TileHint(modifier: Modifier = Modifier) {
    HintLine("CROWN FOR LIBRARY", modifier = modifier)
}
