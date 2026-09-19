package games.codemonkey.shmupxwatch.ui

import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.wear.compose.material3.Text
import games.codemonkey.shmupxwatch.ui.theme.DesignPalette
import games.codemonkey.shmupxwatch.ui.theme.DesignType

/**
 * The parts every launcher screen is built from.
 *
 * One note that runs through all of them: the design is a 456-unit square and
 * the panel it targets is 456 device pixels at density 2, i.e. about 228 dp —
 * so every measurement in the handoff halves on the way here. That is fine for
 * type and spacing and NOT fine for anything you touch: the design's 46-unit
 * pills land at 23 dp, half the 48 dp minimum target. Interactive heights are
 * therefore floored at 48 dp and the surrounding spacing gives way instead.
 * Where that happens it is called out at the site. Everything non-interactive
 * keeps the design's proportion exactly.
 */
object LauncherMetrics {
    /** One design unit, in dp. 456 units across a ~228 dp panel. */
    const val SCALE = 0.5f

    /** Wear's minimum touch target. Nothing tappable goes under this. */
    val MinTouch = 48.dp

    fun units(design: Int): Dp = (design * SCALE).dp
}

/** The monospace heading at the top of a screen: "LIBRARY · 270". */
@Composable
fun ScreenTitle(
    text: String,
    modifier: Modifier = Modifier,
    color: Color = DesignPalette.LabelDim,
) {
    Text(
        text = text,
        style = DesignType.ScreenTitle,
        color = color,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
        textAlign = TextAlign.Center,
        modifier = modifier,
    )
}

/** The quiet line at the foot: "CROWN TO SCROLL". */
@Composable
fun HintLine(
    text: String,
    modifier: Modifier = Modifier,
    color: Color = DesignPalette.LabelHint,
) {
    Text(
        text = text,
        style = DesignType.Hint,
        color = color,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
        textAlign = TextAlign.Center,
        modifier = modifier,
    )
}

/**
 * The breathing status dot — the design's `sxBreathe`, 2.6 s, .55 to 1 opacity.
 * Still in ambient, where an animation is a wake-up a minute.
 */
@Composable
fun StatusDot(
    color: Color,
    size: Dp = 7.dp,
    animate: Boolean = true,
    periodMillis: Int = 2600,
    modifier: Modifier = Modifier,
) {
    val alpha by if (animate) {
        rememberInfiniteTransition(label = "dot").animateFloat(
            initialValue = 0.55f,
            targetValue = 1f,
            animationSpec = infiniteRepeatable(
                animation = tween(periodMillis / 2),
                repeatMode = RepeatMode.Reverse,
            ),
            label = "breathe",
        )
    } else {
        androidx.compose.runtime.remember { androidx.compose.runtime.mutableFloatStateOf(1f) }
    }

    Box(
        modifier = modifier
            .size(size)
            .alpha(alpha)
            .clip(CircleShape)
            .background(color),
    )
}

/**
 * A stadium-shaped text button: the design's LIBRARY / SHELF / CANCEL / DONE.
 *
 * Height is floored at 48 dp — the design's 46 units would be 23 dp.
 */
@Composable
fun PillButton(
    label: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    minWidth: Dp = 0.dp,
    borderColor: Color = DesignPalette.Edge42,
    contentColor: Color = DesignPalette.Label,
    background: Color = DesignPalette.panelDeep(0.80f),
) {
    Box(
        modifier = modifier
            .defaultMinSize(minWidth = minWidth, minHeight = LauncherMetrics.MinTouch)
            .height(LauncherMetrics.MinTouch)
            .clip(RoundedCornerShape(percent = 50))
            .background(background)
            .border(BorderStroke(1.dp, borderColor), RoundedCornerShape(percent = 50))
            .clickable(onClick = onClick)
            // 6 dp, not 12. These sit in a row near the bottom of a circle,
            // where only about 145 dp of width is left — the design's roomier
            // padding pushed "SHELF" off the edge on a 227 dp panel.
            .padding(horizontal = 6.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = label,
            style = DesignType.Button,
            color = contentColor,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

/** A round button holding a drawn glyph — the ◉ / ≡ / ■ / ★ controls. */
@Composable
fun RoundGlyphButton(
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    diameter: Dp = LauncherMetrics.MinTouch,
    borderColor: Color = DesignPalette.Edge32,
    background: Color = DesignPalette.panelDeep(0.80f),
    content: @Composable () -> Unit,
) {
    Box(
        modifier = modifier
            .size(diameter)
            .clip(CircleShape)
            .background(background)
            .border(BorderStroke(1.dp, borderColor), CircleShape)
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
        content = { content() },
    )
}

/** One of the metadata chips under a detail title. */
@Composable
fun MetaChip(text: String, modifier: Modifier = Modifier) {
    Box(
        modifier = modifier
            .clip(RoundedCornerShape(4.dp))
            .background(DesignPalette.panelDeep(0.70f))
            .border(BorderStroke(1.dp, DesignPalette.Edge28), RoundedCornerShape(4.dp))
            .padding(horizontal = 5.dp, vertical = 2.dp),
    ) {
        Text(
            text = text,
            style = DesignType.Caption,
            color = DesignPalette.LabelDim,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

/** The small outlined chip on the right of the selected row: "2P", "DEBUG". */
@Composable
fun TagChip(text: String, modifier: Modifier = Modifier) {
    if (text.isBlank()) return
    Box(
        modifier = modifier
            .clip(RoundedCornerShape(4.dp))
            .border(BorderStroke(1.dp, DesignPalette.accentEdge(0.5f)), RoundedCornerShape(4.dp))
            .padding(horizontal = 4.dp, vertical = 1.dp),
    ) {
        Text(
            text = text,
            style = DesignType.Caption,
            color = DesignPalette.Accent,
            maxLines = 1,
        )
    }
}

/** A row of separated monospace fragments: `CMG-DESKTOP · 42 ms`. */
@Composable
fun DotSeparatedRow(
    modifier: Modifier = Modifier,
    content: @Composable RowScope.() -> Unit,
) {
    Row(
        modifier = modifier,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
        verticalAlignment = Alignment.CenterVertically,
        content = content,
    )
}

/** The `·` between them, at the design's dimmer weight. */
@Composable
fun Separator() {
    Text("·", style = DesignType.Caption, color = DesignPalette.LabelFaint)
}

/** Fixed-width spacer in design units, for translating the handoff literally. */
@Composable
fun UnitSpacer(design: Int, horizontal: Boolean = false) {
    if (horizontal) {
        Box(Modifier.width(LauncherMetrics.units(design)))
    } else {
        Box(Modifier.height(LauncherMetrics.units(design)))
    }
}
