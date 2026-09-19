package games.codemonkey.shmupxwatch.ui.screens

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.wear.compose.material3.MaterialTheme
import androidx.wear.compose.material3.Text
import games.codemonkey.shmupxwatch.ambient.AmbientState
import games.codemonkey.shmupxwatch.bridge.AgentSnapshot
import games.codemonkey.shmupxwatch.bridge.AgentState
import games.codemonkey.shmupxwatch.ui.theme.LocalStateColors

/**
 * What's on screen once the watch dims.
 *
 * Three rules, all from the ambient guidance: keep at least 85% of the screen
 * black, prefer outlines to fills, and show only what someone would want
 * without touching the watch. Here that's the count of blocked agents — the
 * one thing worth raising a wrist for.
 *
 * [AmbientState.Ambient.tick] arrives about once a minute. If burn-in
 * protection is requested, nudge the content on each tick so no pixel holds the
 * same lit value for hours.
 */
@Composable
fun AmbientScreen(
    ambient: AmbientState.Ambient,
    agents: List<AgentSnapshot>,
) {
    val stateColors = LocalStateColors.current
    val blocked = agents.filter { it.state == AgentState.BLOCKED }
    val working = agents.count { it.state == AgentState.WORKING }

    // Two-pixel shuffle on a slow cycle, only when the device asks for it.
    val shift = if (ambient.burnInProtectionRequired) (ambient.tick % 4).toInt() - 2 else 0

    Column(
        modifier = Modifier
            .fillMaxSize()
            .offset(x = shift.dp, y = shift.dp)
            .padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Row(
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            agents.take(6).forEach { agent ->
                val color = stateColors.forState(agent.state)
                Box(modifier = Modifier.size(12.dp)) {
                    Canvas(modifier = Modifier.fillMaxSize()) {
                        // Ring, not disc: fewer lit pixels, same information.
                        drawCircle(
                            color = color,
                            radius = size.minDimension / 2f - 1f,
                            center = Offset(size.width / 2f, size.height / 2f),
                            style = Stroke(width = 2f),
                        )
                    }
                }
            }
        }

        Spacer(Modifier.height(14.dp))

        Text(
            text = when {
                blocked.isNotEmpty() -> "${blocked.size} waiting"
                working > 0 -> "$working working"
                else -> "Idle"
            },
            color = if (blocked.isNotEmpty()) stateColors.blocked else stateColors.label,
            style = MaterialTheme.typography.titleMedium,
        )

        blocked.firstOrNull()?.detail?.let { detail ->
            Spacer(Modifier.height(4.dp))
            Text(
                text = detail,
                color = stateColors.detail,
                textAlign = TextAlign.Center,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                style = MaterialTheme.typography.bodySmall,
            )
        }
    }
}
