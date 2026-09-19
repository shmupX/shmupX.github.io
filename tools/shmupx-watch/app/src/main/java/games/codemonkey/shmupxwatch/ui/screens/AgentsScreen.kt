package games.codemonkey.shmupxwatch.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
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
import androidx.wear.compose.material3.Button
import androidx.wear.compose.material3.ListHeader
import androidx.wear.compose.material3.MaterialTheme
import androidx.wear.compose.material3.ScreenScaffold
import androidx.wear.compose.material3.Text
import games.codemonkey.shmupxwatch.bridge.AgentSnapshot
import games.codemonkey.shmupxwatch.bridge.AgentState
import games.codemonkey.shmupxwatch.bridge.ConnectionState
import games.codemonkey.shmupxwatch.bridge.QuickReply
import games.codemonkey.shmupxwatch.ui.theme.LocalStateColors

@Composable
fun AgentsScreen(
    agents: List<AgentSnapshot>,
    connection: ConnectionState,
    onQuickReply: (agentId: String, reply: QuickReply) -> Unit,
    onDictate: () -> Unit,
    onOpenPreview: () -> Unit,
) {
    val listState = rememberScalingLazyListState()
    val stateColors = LocalStateColors.current

    ScreenScaffold(scrollState = listState) {
        ScalingLazyColumn(
            state = listState,
            modifier = Modifier.fillMaxWidth(),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            item {
                ListHeader {
                    Text(text = connectionLabel(connection))
                }
            }

            if (agents.isEmpty()) {
                item {
                    Text(
                        text = "No agents yet. Start a session on the desktop.",
                        textAlign = TextAlign.Center,
                        color = stateColors.detail,
                        modifier = Modifier.padding(horizontal = 12.dp),
                    )
                }
            }

            items(agents, key = { it.id }) { agent ->
                AgentRow(
                    agent = agent,
                    onQuickReply = { reply -> onQuickReply(agent.id, reply) },
                )
            }

            item {
                Spacer(Modifier.size(4.dp))
            }

            item {
                Button(
                    onClick = onDictate,
                    label = { Text("Speak") },
                    modifier = Modifier.fillMaxWidth(),
                )
            }

            item {
                Button(
                    onClick = onOpenPreview,
                    label = { Text("Preview") },
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        }
    }
}

@Composable
private fun AgentRow(
    agent: AgentSnapshot,
    onQuickReply: (QuickReply) -> Unit,
) {
    val stateColors = LocalStateColors.current
    val accent = stateColors.forState(agent.state)

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 6.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            // A dot, not a badge: readable at a glance without reading a word.
            Box(
                modifier = Modifier
                    .size(10.dp)
                    .clip(CircleShape)
                    .background(accent),
            )
            Spacer(Modifier.width(8.dp))
            Text(
                text = agent.label,
                color = stateColors.label,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                style = MaterialTheme.typography.titleSmall,
            )
        }

        agent.detail?.let { detail ->
            Text(
                text = detail,
                color = stateColors.detail,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                style = MaterialTheme.typography.bodySmall,
                modifier = Modifier.padding(start = 18.dp, top = 2.dp),
            )
        }

        // Only a blocked agent earns buttons. Everything else is read-only,
        // which keeps the list scannable instead of turning it into a control panel.
        if (agent.state == AgentState.BLOCKED) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(start = 18.dp, top = 6.dp),
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                Button(
                    onClick = { onQuickReply(QuickReply.APPROVE) },
                    label = { Text(QuickReply.APPROVE.label) },
                    modifier = Modifier.weight(1f),
                )
                Button(
                    onClick = { onQuickReply(QuickReply.DENY) },
                    label = { Text(QuickReply.DENY.label) },
                    modifier = Modifier.weight(1f),
                )
            }
        }
    }
}

private fun connectionLabel(connection: ConnectionState): String = when (connection) {
    ConnectionState.CONNECTED -> "Agents"
    ConnectionState.CONNECTING -> "Reconnecting"
    ConnectionState.DISCONNECTED -> "Bridge offline"
    ConnectionState.DEMO -> "Agents (demo)"
}
