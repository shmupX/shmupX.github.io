package games.codemonkey.shmupxwatch.ui.screens

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.keyframes
import androidx.compose.animation.core.StartOffset
import androidx.compose.animation.core.StartOffsetType
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
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
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.wear.compose.material3.Text
import games.codemonkey.shmupxwatch.catalog.LibraryItem
import games.codemonkey.shmupxwatch.ui.MicGlyph
import games.codemonkey.shmupxwatch.ui.PillButton
import games.codemonkey.shmupxwatch.ui.theme.DesignPalette
import games.codemonkey.shmupxwatch.ui.theme.DesignType

/**
 * Talking to the launcher.
 *
 * The design animates a canned phrase typing itself out and then jumps to a
 * result. What happens here instead: the screen opens, hands straight off to
 * the system recogniser, and shows what actually came back matched against the
 * actual catalog — including when nothing matched, which the mock had no way to
 * depict.
 *
 * Wear OS has no "hey, launcher" of its own to hook: Voice Actions and App
 * Actions are unsupported outside China, so this is always started from the app.
 */
@Composable
fun VoiceScreen(
    heard: String,
    match: LibraryItem?,
    listening: Boolean,
    onAccept: () -> Unit,
    onRetry: () -> Unit,
    onCancel: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier = modifier
            .fillMaxSize()
            .padding(horizontal = 27.dp, vertical = 22.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        BlinkingLabel(
            text = if (listening) "LISTENING" else "HEARD",
            blink = listening,
        )

        Spacer(Modifier.height(8.dp))

        PulsingTarget(active = listening, onClick = onRetry)

        Spacer(Modifier.height(11.dp))

        Text(
            text = heard.ifBlank { if (listening) "…" else "NOTHING HEARD" },
            style = DesignType.Heard,
            color = DesignPalette.Chalk,
            textAlign = TextAlign.Center,
            maxLines = 3,
            overflow = TextOverflow.Ellipsis,
        )

        if (match != null) {
            Spacer(Modifier.height(6.dp))
            MatchChip(title = match.title, onClick = onAccept)
        } else if (heard.isNotBlank() && !listening) {
            Spacer(Modifier.height(6.dp))
            Text(
                text = "NO MATCH",
                style = DesignType.Caption,
                color = DesignPalette.Danger,
                maxLines = 1,
            )
        }

        Spacer(Modifier.height(12.dp))

        Row(horizontalArrangement = Arrangement.spacedBy(5.dp)) {
            PillButton(label = "CANCEL", onClick = onCancel, minWidth = 60.dp)
            if (!listening) {
                PillButton(
                    label = "AGAIN",
                    onClick = onRetry,
                    minWidth = 56.dp,
                    borderColor = DesignPalette.accentEdge(0.55f),
                    contentColor = DesignPalette.Accent,
                )
            }
        }
    }
}

/** The design's `sxBlink`: hard on/off at 1.1 s, not a fade. */
@Composable
private fun BlinkingLabel(text: String, blink: Boolean) {
    val transition = rememberInfiniteTransition(label = "listen")
    val alpha by if (blink) {
        transition.animateFloat(
            initialValue = 1f,
            targetValue = 0.15f,
            animationSpec = infiniteRepeatable(
                // keyframes, not tween: the design steps between two values
                // rather than easing, and a fade reads as a slow pulse.
                animation = keyframes {
                    durationMillis = 1100
                    1f at 0
                    1f at 494
                    0.15f at 495
                    0.15f at 1100
                },
                repeatMode = RepeatMode.Restart,
            ),
            label = "blink",
        )
    } else {
        remember { mutableFloatStateOf(1f) }
    }

    Row(
        horizontalArrangement = Arrangement.spacedBy(4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            Modifier
                .size(5.dp)
                .clip(CircleShape)
                .background(DesignPalette.Accent.copy(alpha = alpha)),
        )
        Text(
            text = text,
            style = DesignType.Caption,
            color = DesignPalette.Accent,
            maxLines = 1,
        )
    }
}

/**
 * Three rings expanding out of a disc — the design's `sxRing`, 2.2 s, staggered
 * by a third each. Tapping it starts listening again.
 */
@Composable
private fun PulsingTarget(active: Boolean, onClick: () -> Unit) {
    val transition = rememberInfiniteTransition(label = "rings")

    Box(
        modifier = Modifier
            .size(59.dp)
            .clip(CircleShape)
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        if (active) {
            listOf(0, 733, 1466).forEach { offsetMillis ->
                val progress by transition.animateFloat(
                    initialValue = 0f,
                    targetValue = 1f,
                    animationSpec = infiniteRepeatable(
                        animation = tween(2200, easing = LinearEasing),
                        repeatMode = RepeatMode.Restart,
                        // A one-shot PHASE offset, which is what the design's
                        // `animation-delay` is. Passing it as tween's delay
                        // instead adds it to every iteration, so the three
                        // rings run at 2.2 s, 2.9 s and 3.7 s and drift out of
                        // the even cadence within a few seconds.
                        initialStartOffset = StartOffset(offsetMillis, StartOffsetType.FastForward),
                    ),
                    label = "ring$offsetMillis",
                )
                Canvas(Modifier.fillMaxSize()) {
                    // Design: scale .62 → 1.35, opacity .85 → 0.
                    val scale = 0.62f + progress * 0.73f
                    drawCircle(
                        color = DesignPalette.Accent.copy(alpha = (1f - progress) * 0.85f),
                        radius = size.minDimension / 2f * scale,
                        center = Offset(size.width / 2f, size.height / 2f),
                        style = Stroke(width = 2.dp.toPx()),
                    )
                }
            }
        }

        Box(
            modifier = Modifier
                .size(35.dp)
                .clip(CircleShape)
                .background(
                    Brush.radialGradient(
                        colors = listOf(
                            DesignPalette.Accent,
                            DesignPalette.AccentDeep,
                        ),
                        center = Offset.Unspecified,
                    ),
                ),
            contentAlignment = Alignment.Center,
        ) {
            MicGlyph(size = 18.dp, color = DesignPalette.OnAccent)
        }
    }
}

/** "MATCH · ZUNZUNKYOU NO YABOU" — tap to accept. */
@Composable
private fun MatchChip(title: String, onClick: () -> Unit) {
    Row(
        modifier = Modifier
            .clip(RoundedCornerShape(percent = 50))
            .background(DesignPalette.accentPanel(0.72f))
            .border(
                BorderStroke(1.dp, DesignPalette.accentEdge(0.55f)),
                RoundedCornerShape(percent = 50),
            )
            .clickable(onClick = onClick)
            .padding(horizontal = 9.dp, vertical = 6.dp),
        horizontalArrangement = Arrangement.spacedBy(5.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = "MATCH",
            style = DesignType.Caption,
            color = DesignPalette.accentEdge(0.8f),
            maxLines = 1,
        )
        Text(
            text = title,
            style = DesignType.RowTitle,
            color = DesignPalette.Bright,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.widthIn(max = 100.dp),
        )
    }
}
