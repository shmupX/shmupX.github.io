package com.emre.aloud

import android.content.ComponentName
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.runtime.mutableStateOf
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import com.google.common.util.concurrent.ListenableFuture
import com.emre.aloud.playback.PlaybackService
import com.emre.aloud.ui.WearApp

class MainActivity : ComponentActivity() {

    private var controllerFuture: ListenableFuture<MediaController>? = null

    /** Composable state holding the resolved controller, so the UI can rebuild
     *  with a working PlaybackUi the moment the connection settles. */
    private val controllerState = mutableStateOf<MediaController?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val token = SessionToken(this, ComponentName(this, PlaybackService::class.java))
        val future = MediaController.Builder(this, token).buildAsync()
        controllerFuture = future
        future.addListener(
            {
                // The activity may be gone before the future resolves: cancelled
                // futures must not be read, and nothing may leak a live controller.
                controllerState.value = runCatching { future.get() }.getOrNull()
            },
            androidx.core.content.ContextCompat.getMainExecutor(this),
        )
        // Debug hooks (compiled out of release builds):
        //   --es autoplay <bookId>   play a book without UI taps
        //   --es screen <name>       start on a specific screen (library/nowplaying/uploader/remote)
        //   --es uploader_start 1    also start the upload server immediately (perms pre-granted via pm)
        val autoplay = intent.getStringExtra("autoplay").takeIf { BuildConfig.DEBUG }
        val screen = intent.getStringExtra("screen").takeIf { BuildConfig.DEBUG }
        val uploaderStart = intent.getStringExtra("uploader_start") == "1" && BuildConfig.DEBUG
        setContent {
            WearApp(
                controller = controllerState.value,
                autoplayBookId = autoplay,
                initialScreen = screen,
                startUploader = uploaderStart,
            )
        }
    }

    override fun onDestroy() {
        // The resolved controller is released here; releaseFuture additionally
        // cancels a still-pending build — without it, an activity destroyed
        // before the controller resolved leaked a live binding.
        controllerState.value?.release()
        controllerState.value = null
        controllerFuture?.let { MediaController.releaseFuture(it) }
        controllerFuture = null
        super.onDestroy()
    }
}
