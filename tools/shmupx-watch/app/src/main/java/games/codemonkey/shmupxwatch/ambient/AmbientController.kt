package games.codemonkey.shmupxwatch.ambient

import androidx.activity.ComponentActivity
import androidx.wear.ambient.AmbientLifecycleObserver
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Wraps [AmbientLifecycleObserver] so the rest of the app sees a plain flow
 * instead of activity callbacks.
 *
 * On Wear OS 6+ with targetSdk 36 the app is already always-on by default, so
 * this isn't what makes the app stay visible — it's what lets you *change what
 * it looks like* when the screen dims. Without it you get the system's default
 * treatment of your paused UI.
 *
 * Newer releases add a `LocalAmbientModeManager` composable that does much of
 * this for you; if it's available in the Wear Compose version you resolve,
 * prefer it and delete this file. This path is the widely documented one and
 * works back to Wear OS 4.
 */
class AmbientController(activity: ComponentActivity) {

    private val _state = MutableStateFlow<AmbientState>(AmbientState.Interactive)
    val state: StateFlow<AmbientState> = _state.asStateFlow()

    private val callback = object : AmbientLifecycleObserver.AmbientLifecycleCallback {

        override fun onEnterAmbient(ambientDetails: AmbientLifecycleObserver.AmbientDetails) {
            _state.value = AmbientState.Ambient(
                burnInProtectionRequired = ambientDetails.burnInProtectionRequired,
                lowBitAmbient = ambientDetails.deviceHasLowBitAmbient,
                tick = 0L,
            )
        }

        override fun onUpdateAmbient() {
            // Fires about once a minute. Anything you redraw here should be
            // cheap and mostly black.
            _state.value = (_state.value as? AmbientState.Ambient)
                ?.let { it.copy(tick = it.tick + 1) }
                ?: _state.value
        }

        override fun onExitAmbient() {
            _state.value = AmbientState.Interactive
        }
    }

    val observer: AmbientLifecycleObserver = AmbientLifecycleObserver(activity, callback)
}
