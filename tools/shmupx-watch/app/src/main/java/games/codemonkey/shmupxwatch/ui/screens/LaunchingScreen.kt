package games.codemonkey.shmupxwatch.ui.screens

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.wear.compose.material3.Text
import games.codemonkey.shmupxwatch.ui.HintLine
import games.codemonkey.shmupxwatch.ui.PillButton
import games.codemonkey.shmupxwatch.ui.theme.DesignPalette
import games.codemonkey.shmupxwatch.ui.theme.DesignType
import kotlinx.coroutines.delay

/**
 * Waiting for the desktop to pick the launch up.
 *
 * The design holds this for 1.7 seconds and then declares victory. Here it
 * waits for the desktop to actually say the game is running, which means it
 * also has to handle the case the mock could not: the desktop is closed, or
 * asleep, or was never paired, and nothing is ever going to answer.
 *
 * So there is a deadline. After it, the spinner stops and the screen says what
 * is actually true — the request is sitting in the database unread — and offers
 * the way back. A launcher that spins forever is indistinguishable from one
 * that crashed.
 */
@Composable
fun LaunchingScreen(
    title: String,
    detail: String?,
    onCancel: () -> Unit,
    modifier: Modifier = Modifier,
    timeoutMillis: Long = 12_000,
) {
    var timedOut by remember(title) { mutableStateOf(false) }

    LaunchedEffect(title) {
        timedOut = false
        delay(timeoutMillis)
        timedOut = true
    }

    Column(
        modifier = modifier
            .fillMaxSize()
            .padding(horizontal = 28.dp, vertical = 30.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Box(contentAlignment = Alignment.Center) {
            SweepRing(spinning = !timedOut, modifier = Modifier.size(75.dp))
            Text(
                text = if (timedOut) "NO REPLY" else "SENDING",
                style = DesignType.ScreenTitle,
                color = if (timedOut) DesignPalette.Danger else DesignPalette.Accent,
                maxLines = 1,
            )
        }

        Spacer(Modifier.height(11.dp))

        Text(
            text = title,
            style = DesignType.ItemTitle,
            color = DesignPalette.Bright,
            textAlign = TextAlign.Center,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
        )

        Spacer(Modifier.height(4.dp))

        if (timedOut) {
            Text(
                text = "DESKTOP DID NOT ANSWER",
                style = DesignType.Caption,
                color = DesignPalette.LabelHint,
                textAlign = TextAlign.Center,
                maxLines = 2,
            )
            Spacer(Modifier.height(8.dp))
            PillButton(
                label = "BACK",
                onClick = onCancel,
                minWidth = 64.dp,
                borderColor = DesignPalette.accentEdge(0.55f),
                contentColor = DesignPalette.Accent,
            )
        } else {
            HintLine("→ CMG-DESKTOP")
            Text(
                text = detail ?: "rtdb /launch",
                style = DesignType.Caption,
                color = DesignPalette.LabelHint,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

/**
 * The design's `sxSpin`: a 110° arc of accent sweeping round a faint track once
 * every 1.1 s. Written as a rotating arc rather than the original's masked
 * conic gradient, which Compose has no direct equivalent for.
 */
@Composable
private fun SweepRing(spinning: Boolean, modifier: Modifier = Modifier) {
    val transition = rememberInfiniteTransition(label = "sweep")
    val angle by if (spinning) {
        transition.animateFloat(
            initialValue = 0f,
            targetValue = 360f,
            animationSpec = infiniteRepeatable(
                animation = tween(1100, easing = LinearEasing),
                repeatMode = RepeatMode.Restart,
            ),
            label = "spin",
        )
    } else {
        remember { androidx.compose.runtime.mutableFloatStateOf(0f) }
    }

    Canvas(modifier) {
        val stroke = Stroke(width = 3.dp.toPx())
        val inset = stroke.width / 2f
        val arcSize = androidx.compose.ui.geometry.Size(
            size.width - stroke.width,
            size.height - stroke.width,
        )
        drawArc(
            color = DesignPalette.Edge20,
            startAngle = 0f,
            sweepAngle = 360f,
            useCenter = false,
            topLeft = androidx.compose.ui.geometry.Offset(inset, inset),
            size = arcSize,
            style = stroke,
        )
        if (spinning) {
            drawArc(
                brush = Brush.sweepGradient(
                    0f to DesignPalette.Accent.copy(alpha = 0f),
                    1f to DesignPalette.Accent,
                ),
                startAngle = angle,
                sweepAngle = 110f,
                useCenter = false,
                topLeft = androidx.compose.ui.geometry.Offset(inset, inset),
                size = arcSize,
                style = stroke,
            )
        }
    }
}
