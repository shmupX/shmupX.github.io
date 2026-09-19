package games.codemonkey.shmupxwatch.session

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.wear.ongoing.OngoingActivity
import androidx.wear.ongoing.Status
import games.codemonkey.shmupxwatch.MainActivity
import games.codemonkey.shmupxwatch.R

/**
 * This is the piece that answers "can the app stay open until I close it".
 *
 * Ambient mode keeps your UI on screen when the display dims. It does not stop
 * the second timeout, where the system gives up and shows the watch face. An
 * app with a running ongoing activity is exempt from that — it gets resumed on
 * the next interaction instead of being dropped, which is why workout apps
 * behave the way they do.
 *
 * Cost: a foreground service and a persistent notification. Start it when a
 * session begins, stop it when the work is done — leaving it running forever is
 * how you end up with a watch that dies by lunch.
 */
class SessionService : Service() {

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                stopSelf()
                return START_NOT_STICKY
            }
        }

        val agentCount = intent?.getIntExtra(EXTRA_AGENT_COUNT, 0) ?: 0
        val state = intent?.getStringExtra(EXTRA_STATE) ?: "connected"

        createChannel()
        val notification = buildNotification(agentCount, state)

        ServiceCompat.startForeground(
            this,
            NOTIFICATION_ID,
            notification,
            ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE,
        )
        return START_STICKY
    }

    private fun createChannel() {
        val manager = getSystemService(NotificationManager::class.java)
        if (manager.getNotificationChannel(CHANNEL_ID) != null) return
        manager.createNotificationChannel(
            NotificationChannel(
                CHANNEL_ID,
                getString(R.string.session_channel_name),
                // LOW: present and persistent, but it shouldn't buzz the wrist.
                NotificationManager.IMPORTANCE_LOW,
            ).apply {
                description = getString(R.string.session_channel_desc)
                setShowBadge(false)
            }
        )
    }

    private fun buildNotification(agentCount: Int, state: String): Notification {
        val touchIntent = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        val stopIntent = PendingIntent.getService(
            this,
            1,
            Intent(this, SessionService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        val builder = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_agent)
            .setContentTitle(getString(R.string.session_title))
            .setContentText(state)
            .setContentIntent(touchIntent)
            .setOngoing(true)
            .setSilent(true)
            .addAction(R.drawable.ic_agent, getString(R.string.session_stop), stopIntent)

        // The ongoing activity is what surfaces this on the watch face and in
        // the recents strip, and what exempts the app from the watch-face timeout.
        val status = Status.Builder()
            .addTemplate("#count# agents · #state#")
            .addPart("count", Status.TextPart(agentCount.toString()))
            .addPart("state", Status.TextPart(state))
            .build()

        OngoingActivity.Builder(applicationContext, NOTIFICATION_ID, builder)
            .setStaticIcon(R.drawable.ic_agent)
            .setTouchIntent(touchIntent)
            .setStatus(status)
            .build()
            .apply(applicationContext)

        return builder.build()
    }

    companion object {
        private const val CHANNEL_ID = "shmupx_session"
        private const val NOTIFICATION_ID = 4501
        private const val ACTION_STOP = "games.codemonkey.shmupxwatch.STOP_SESSION"
        private const val EXTRA_AGENT_COUNT = "agent_count"
        private const val EXTRA_STATE = "state"

        fun start(context: Context, agentCount: Int, state: String) {
            val intent = Intent(context, SessionService::class.java)
                .putExtra(EXTRA_AGENT_COUNT, agentCount)
                .putExtra(EXTRA_STATE, state)
            context.startForegroundService(intent)
        }

        fun stop(context: Context) {
            context.startService(
                Intent(context, SessionService::class.java).setAction(ACTION_STOP)
            )
        }
    }
}
