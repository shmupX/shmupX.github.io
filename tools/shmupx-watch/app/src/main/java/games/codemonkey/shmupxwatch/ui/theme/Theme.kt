package games.codemonkey.shmupxwatch.ui.theme

import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.wear.compose.material3.ColorScheme
import androidx.wear.compose.material3.MaterialTheme
import games.codemonkey.shmupxwatch.ambient.AmbientState
import games.codemonkey.shmupxwatch.ambient.LocalAmbientState
import games.codemonkey.shmupxwatch.bridge.AgentState

/**
 * Colour here is doing a job, not decorating. Agent state has to be readable in
 * peripheral vision, at a glance, on a dimmed screen — so the four states get
 * four separable hues borrowed from arcade CRT phosphors rather than four tints
 * of one brand colour.
 *
 * The black background isn't a style choice. Ambient guidance is to keep at
 * least 85% of the screen black, and on OLED an unlit pixel costs nothing.
 */
object ShmupxPalette {
    val Void = Color(0xFF000000)
    val Phosphor = Color(0xFF6FE86F)   // P1 green — the shmupX identity colour
    val Amber = Color(0xFFFFB000)      // P3 amber — work in progress
    val Alert = Color(0xFFFF2E5B)      // needs you now
    val Slate = Color(0xFF4A5A66)      // idle: deliberately low-energy
    val Haze = Color(0xFF7A6E8C)       // unclassifiable
    val Chalk = Color(0xFFE8ECEF)
    val Dust = Color(0xFF8E9AA3)
    val Hull = Color(0xFF12161A)
}

/**
 * Ambient counterparts. Dimmer, and meant to be drawn as outlines rather than
 * fills — a solid block of colour is both expensive and misleading when the
 * watch is in a low-power state.
 */
object ShmupxAmbientPalette {
    val Phosphor = Color(0xFF2E6B33)
    val Amber = Color(0xFF7A5400)
    val Alert = Color(0xFF7A1630)
    val Slate = Color(0xFF2A333A)
    val Haze = Color(0xFF3A3444)
    val Chalk = Color(0xFF9AA3AA)
    val Dust = Color(0xFF55606A)
}

/** Semantic colours the components read, resolved for the current power state. */
data class StateColors(
    val idle: Color,
    val working: Color,
    val blocked: Color,
    val done: Color,
    val unknown: Color,
    val label: Color,
    val detail: Color,
) {
    fun forState(state: AgentState): Color = when (state) {
        AgentState.IDLE -> idle
        AgentState.WORKING -> working
        AgentState.BLOCKED -> blocked
        AgentState.DONE -> done
        AgentState.UNKNOWN -> unknown
    }
}

private val InteractiveStateColors = StateColors(
    idle = ShmupxPalette.Slate,
    working = ShmupxPalette.Amber,
    blocked = ShmupxPalette.Alert,
    done = ShmupxPalette.Phosphor,
    unknown = ShmupxPalette.Haze,
    label = ShmupxPalette.Chalk,
    detail = ShmupxPalette.Dust,
)

private val AmbientStateColors = StateColors(
    idle = ShmupxAmbientPalette.Slate,
    working = ShmupxAmbientPalette.Amber,
    blocked = ShmupxAmbientPalette.Alert,
    done = ShmupxAmbientPalette.Phosphor,
    unknown = ShmupxAmbientPalette.Haze,
    label = ShmupxAmbientPalette.Chalk,
    detail = ShmupxAmbientPalette.Dust,
)

val LocalStateColors = staticCompositionLocalOf { InteractiveStateColors }

/**
 * Only four scheme slots are overridden on purpose. Wear Material 3 keeps
 * evolving its colour roles, and a theme that names twenty of them is a theme
 * that breaks on the next library bump. Everything state-specific lives in
 * [LocalStateColors] instead, where this app owns the contract.
 */
@Composable
fun ShmupxTheme(
    ambientState: AmbientState = LocalAmbientState.current,
    content: @Composable () -> Unit,
) {
    val stateColors = if (ambientState.isAmbient) AmbientStateColors else InteractiveStateColors

    MaterialTheme(
        colorScheme = ColorScheme(
            background = ShmupxPalette.Void,
            onBackground = if (ambientState.isAmbient) ShmupxAmbientPalette.Chalk else ShmupxPalette.Chalk,
            primary = if (ambientState.isAmbient) ShmupxAmbientPalette.Phosphor else ShmupxPalette.Phosphor,
            onPrimary = ShmupxPalette.Void,
        ),
    ) {
        CompositionLocalProvider(
            LocalStateColors provides stateColors,
            content = content,
        )
    }
}
