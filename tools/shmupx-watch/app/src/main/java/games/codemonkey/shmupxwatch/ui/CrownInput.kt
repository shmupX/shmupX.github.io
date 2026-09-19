package games.codemonkey.shmupxwatch.ui

import androidx.compose.foundation.focusable
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.composed
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.input.rotary.onRotaryScrollEvent
import kotlin.math.abs
import kotlin.math.sign

/**
 * Raw crown deltas, turned into detents.
 *
 * A `ScalingLazyColumn` already scrolls itself with the crown — it defaults
 * `rotaryScrollableBehavior` and wires its own focus — so this is for the other
 * three things the design asks the crown to do, none of which is a scroll: step
 * the library selection, scrub A–Z across the shelf, and set the volume.
 *
 * Two details are load-bearing:
 *
 * - **Modifier order.** `onRotaryScrollEvent` has to come before
 *   `focusRequester`/`focusable`, and the node has to actually hold focus, or
 *   no event is delivered and nothing at all happens.
 * - **Accumulation.** The crown reports pixels, not clicks, and one physical
 *   detent arrives as several events. Stepping per event scrubs 262 saves in
 *   half a turn. Deltas are summed and a step emitted per [threshold] crossed,
 *   which is what makes it feel like a notched dial rather than a slider.
 */
fun Modifier.crownDetents(
    threshold: Float = 48f,
    enabled: Boolean = true,
    onDetent: (direction: Int) -> Unit,
): Modifier = composed {
    val focusRequester = remember { FocusRequester() }
    // Held across recompositions; resetting it per event is the bug above.
    val accumulated = remember { floatArrayOf(0f) }

    LaunchedEffect(enabled) {
        if (enabled) {
            // Focus can legitimately be refused — during a transition, or when
            // the node is not attached yet. A crown that does nothing is
            // recoverable; a crash is not.
            runCatching { focusRequester.requestFocus() }
        }
    }

    this
        .onRotaryScrollEvent { event ->
            if (!enabled) return@onRotaryScrollEvent false
            accumulated[0] += event.verticalScrollPixels
            var steps = 0
            while (abs(accumulated[0]) >= threshold) {
                steps += accumulated[0].sign.toInt()
                accumulated[0] -= threshold * accumulated[0].sign
            }
            repeat(abs(steps)) { onDetent(steps.sign) }
            true
        }
        .focusRequester(focusRequester)
        .focusable(enabled = enabled)
}
