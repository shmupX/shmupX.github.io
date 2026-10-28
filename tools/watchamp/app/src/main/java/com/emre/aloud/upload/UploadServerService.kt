package com.emre.aloud.upload

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.IBinder
import com.emre.aloud.R
import kotlinx.coroutines.flow.MutableStateFlow

/**
 * Foreground service (dataSync) hosting the upload server, so long uploads
 * survive the Activity being closed. Started from the Uploader screen —
 * the user-tap start keeps it FGS-at-start compliant.
 */
class UploadServerService : Service() {

    private var server: UploadServer? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START -> startServer()
            ACTION_STOP -> stopSelf()
            // A restart with no action (or a null intent) must not leave a
            // foreground service running without ever calling startForeground().
            else -> if (server == null) stopSelf()
        }
        // The uploader is user-started and self-expiring: never resurrect it.
        return START_NOT_STICKY
    }

    private fun startServer() {
        if (server != null) return
        val newPin = UploadServer.newPin()
        val channel = NotificationChannel(
            CHANNEL_ID, "Uploads", NotificationManager.IMPORTANCE_LOW,
        )
        getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
        val notification: Notification = Notification.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_sys_upload)
            .setContentTitle(getString(R.string.app_name) + " uploads")
            .setContentText("PIN " + newPin)
            .setOngoing(true)
            .build()
        startForeground(1, notification)
        // The idle auto-stop tears the whole service down, so the notification
        // and the "Uploader on" UI can never outlive the running server.
        server = UploadServer(AndroidUploadStore(this), newPin, onAutoStop = { stopSelf() })
        server?.start(PORT)
        pin.value = newPin
        running.value = true
    }

    override fun onDestroy() {
        server?.stop()
        server = null
        running.value = false
        pin.value = null
        super.onDestroy()
    }

    companion object {
        private const val ACTION_START = "com.emre.aloud.upload.START"
        private const val ACTION_STOP = "com.emre.aloud.upload.STOP"
        private const val CHANNEL_ID = "aloud_uploads"
        const val PORT = 8080

        val running = MutableStateFlow(false)

        /** PIN of the currently running server, for display on the watch. */
        val pin = MutableStateFlow<String?>(null)

        fun start(context: Context) {
            context.startForegroundService(Intent(context, UploadServerService::class.java).setAction(ACTION_START))
        }

        fun stop(context: Context) {
            context.startService(Intent(context, UploadServerService::class.java).setAction(ACTION_STOP))
        }
    }
}
