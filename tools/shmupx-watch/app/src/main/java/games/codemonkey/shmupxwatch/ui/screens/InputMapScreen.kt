package games.codemonkey.shmupxwatch.ui.screens

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.wear.compose.foundation.lazy.ScalingLazyColumn
import androidx.wear.compose.foundation.lazy.items
import androidx.wear.compose.foundation.lazy.rememberScalingLazyListState
import androidx.wear.compose.material3.Text
import games.codemonkey.shmupxwatch.ui.PillButton
import games.codemonkey.shmupxwatch.ui.theme.DesignPalette
import games.codemonkey.shmupxwatch.ui.theme.DesignType

/** One row of the input map. */
data class InputBinding(val key: String, val action: String, val detail: String)

/**
 * What this app can actually be driven with, on the watch it is aimed at.
 *
 * The handoff's input map lists five gestures. Three of them do not exist on a
 * Pixel Watch, and a help screen that lies is worse than no help screen, so this
 * is the corrected list. What changed and why:
 *
 * - **SIDE BUTTON → hold to talk.** Wear OS guarantees only the power button;
 *   multifunction stems (`KEYCODE_STEM_1..3`) are optional and a Pixel Watch's
 *   side button is already taken by the system — press for recents, hold for
 *   the assistant. So talking is a target on the screen instead.
 * - **WRIST FLICK → next row.** Flick-to-scroll was removed in Wear OS 3 and
 *   Pixel Watch never shipped it. The gesture that came back is a wrist *turn*,
 *   and Google's guidance is explicit that it means dismiss and must not be
 *   remapped — so it is left as back, which it already is.
 * - **COVER SCREEN → stop.** Pixel Watch 4 and 5 have no proximity sensor at
 *   all, and palm-cover is the system's own sleep gesture. The honest version of
 *   the same idea is what this app does: when the screen goes ambient, the game
 *   pauses.
 *
 * **DOUBLE PINCH is real** — `Modifier.oneHandedGesture` — but it needs Wear OS 7
 * and `compose-material3` 1.7, and this app is pinned to 1.6.2 stable. It is the
 * one row worth adding back once that ships; the guidelines require a visible
 * button beside every gesture anyway, so every action it would perform already
 * has one here.
 */
val INPUT_MAP = listOf(
    InputBinding("01", "ROTATING CROWN", "scroll · scrub A–Z · volume"),
    InputBinding("02", "TAP THE MIC", "talk to the launcher"),
    InputBinding("03", "TAP A ROW", "select · open · launch"),
    InputBinding("04", "SWIPE →", "back"),
    InputBinding("05", "SCREEN DIMS", "pauses the running game"),
)

@Composable
fun InputMapScreen(
    onDone: () -> Unit,
    onOpenAgents: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val listState = rememberScalingLazyListState()

    ScalingLazyColumn(
        modifier = modifier.fillMaxSize(),
        state = listState,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        item {
            Text(
                text = "INPUT MAP",
                style = DesignType.ScreenTitle,
                color = DesignPalette.LabelDim,
                maxLines = 1,
            )
        }

        items(INPUT_MAP) { binding -> BindingRow(binding) }

        item {
            Text(
                text = "DOUBLE PINCH NEEDS WEAR OS 7",
                style = DesignType.Caption,
                color = DesignPalette.LabelFaint,
                textAlign = TextAlign.Center,
                maxLines = 2,
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
            )
        }

        item {
            PillButton(label = "DONE", onClick = onDone, minWidth = 64.dp)
        }

        // The other half of this app: dictate a change to a sprite and watch
        // the preview come back. Same daemon, same database, different job.
        item {
            PillButton(
                label = "AGENTS",
                onClick = onOpenAgents,
                minWidth = 64.dp,
                borderColor = DesignPalette.accentEdge(0.45f),
                contentColor = DesignPalette.Accent,
            )
        }
    }
}

@Composable
private fun BindingRow(binding: InputBinding) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 10.dp, vertical = 2.dp)
            .heightIn(min = 34.dp)
            .clip(RoundedCornerShape(6.dp))
            .background(DesignPalette.panel(0.68f))
            .border(BorderStroke(1.dp, DesignPalette.Edge22), RoundedCornerShape(6.dp))
            .padding(horizontal = 7.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(5.dp),
    ) {
        Text(
            text = binding.key,
            style = DesignType.Caption,
            color = DesignPalette.Accent,
            textAlign = TextAlign.Center,
            maxLines = 1,
            modifier = Modifier.width(15.dp),
        )
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = binding.action,
                style = DesignType.RowTitle,
                color = DesignPalette.Bright,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                text = binding.detail,
                style = DesignType.Caption,
                color = DesignPalette.LabelHint,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}
