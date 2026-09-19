package games.codemonkey.shmupxwatch

import android.Manifest
import android.content.pm.PackageManager
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.getValue
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import games.codemonkey.shmupxwatch.ambient.AmbientController

class MainActivity : ComponentActivity() {

    private lateinit var ambientController: AmbientController

    private val notificationPermission = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { /* Denied just means no ongoing activity; the app still works. */ }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Registering the observer is what lets this app draw its own ambient
        // UI. On Wear OS 6+ with targetSdk 36 the app is already always-on
        // by default — this controls what that looks like.
        ambientController = AmbientController(this)
        lifecycle.addObserver(ambientController.observer)

        requestNotificationPermissionIfNeeded()

        setContent {
            val ambientState by ambientController.state.collectAsStateWithLifecycle()
            ShmupxApp(ambientState = ambientState)
        }
    }

    /**
     * The ongoing activity rides on a notification, so without this permission
     * the session indicator never appears and the app loses its exemption from
     * the return-to-watch-face timeout.
     */
    private fun requestNotificationPermissionIfNeeded() {
        val granted = ContextCompat.checkSelfPermission(
            this,
            Manifest.permission.POST_NOTIFICATIONS,
        ) == PackageManager.PERMISSION_GRANTED

        if (!granted) {
            notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
    }

    override fun onDestroy() {
        lifecycle.removeObserver(ambientController.observer)
        super.onDestroy()
    }
}
