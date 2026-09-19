package games.codemonkey.shmupxwatch.ambient

import androidx.compose.runtime.compositionLocalOf

/**
 * The two power states a foreground Wear app can be in.
 *
 * The system moves between them on its own after user inactivity. You don't get
 * to prevent the transition — you only get to decide what's on screen when it
 * happens. See [games.codemonkey.shmupxwatch.session.SessionService] for the
 * separate question of staying in the foreground at all.
 */
sealed interface AmbientState {

    data object Interactive : AmbientState

    data class Ambient(
        /** Shift pixels periodically; the OLED will thank you. */
        val burnInProtectionRequired: Boolean = false,
        /** Device supports only a restricted color set in ambient. */
        val lowBitAmbient: Boolean = false,
        /**
         * Incremented on every onUpdateAmbient callback — roughly once a
         * minute. Read it from a composable to force a redraw on each tick.
         */
        val tick: Long = 0L,
    ) : AmbientState

    val isAmbient: Boolean get() = this is Ambient
}

val LocalAmbientState = compositionLocalOf<AmbientState> { AmbientState.Interactive }
