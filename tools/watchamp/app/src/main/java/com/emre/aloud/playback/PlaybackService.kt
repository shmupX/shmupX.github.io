package com.emre.aloud.playback

import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService

class PlaybackService : MediaSessionService() {

    private var playerManager: PlayerManager? = null

    override fun onCreate() {
        super.onCreate()
        playerManager = PlayerManager(this)
    }

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession? =
        playerManager?.session

    override fun onDestroy() {
        // The manager is service-owned: no process-wide singleton, so a
        // service teardown cannot leave the UI holding a released player.
        // The UI talks to us through MediaController, which reconnects.
        playerManager?.release()
        playerManager = null
        super.onDestroy()
    }
}
