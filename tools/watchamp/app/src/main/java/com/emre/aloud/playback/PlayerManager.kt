package com.emre.aloud.playback

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Handler
import android.os.Looper
import android.net.Uri
import android.os.Bundle
import androidx.annotation.OptIn
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.Metadata
import androidx.media3.common.PlaybackException
import androidx.media3.common.PlaybackParameters
import androidx.media3.common.Tracks
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.extractor.DefaultExtractorsFactory
import androidx.media3.exoplayer.source.ProgressiveMediaSource
import androidx.media3.extractor.metadata.Chapter as Media3Chapter
import androidx.media3.session.MediaSession
import androidx.media3.session.SessionCommand
import androidx.media3.session.SessionError
import androidx.media3.session.SessionResult
import com.emre.aloud.MainActivity
import com.emre.aloud.books.Book
import com.emre.aloud.books.BooksRepository
import com.emre.aloud.books.ChapterReader
import com.emre.aloud.util.Logg
import com.emre.aloud.data.PlayerPrefs
import com.google.common.util.concurrent.ListenableFuture
import java.util.concurrent.Executor
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull


/** Session custom-command names and args, shared by the UI (MediaController)
 *  and the service (PlayerManager). */
object PlaybackCommand {
    const val PLAY_BOOK = "aloud.play_book"
    const val SET_SLEEP = "aloud.sleep"
    const val ARG_MEDIA_ID = "mediaId"
    const val ARG_AUTOPLAY = "autoplay"
    const val ARG_MINUTES = "minutes"
    const val MINUTES_OFF = -1
}

/**
 * Service-side owner of ExoPlayer + MediaSession. Instantiated by
 * PlaybackService only — the UI never holds it. UI state lands in
 * [PlaybackState], which the UI reads; the UI drives the player through its
 * MediaController and the custom commands in [PlaybackCommand].
 *
 * Note the import: this is androidx.annotation.OptIn, not Kotlin's. Media3's
 * marker is enforced by androidx.annotation.experimental, which kotlin.OptIn
 * does not satisfy — it silently had no effect and left 19 lint errors
 * standing. Annotating the class @UnstableApi instead would only push the
 * requirement onto every caller.
 */
@OptIn(UnstableApi::class)
class PlayerManager(private val context: Context) {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    private val mediaSourceFactory = ProgressiveMediaSource.Factory(
        DefaultDataSource.Factory(context),
        DefaultExtractorsFactory(),
    )

    private val player: ExoPlayer = ExoPlayer.Builder(context)
        .setMediaSourceFactory(mediaSourceFactory)
        .setAudioAttributes(
            AudioAttributes.Builder()
                .setUsage(C.USAGE_MEDIA)
                .setContentType(C.AUDIO_CONTENT_TYPE_SPEECH)
                .build(),
            true,
        )
        .setWakeMode(C.WAKE_MODE_LOCAL)
        // Pause when the audio route disappears rather than playing on into
        // nothing. Without this, a Bluetooth headset disconnecting does not
        // stop the book, so a run ends with minutes of it missed.
        .setHandleAudioBecomingNoisy(true)
        .setSeekBackIncrementMs(30_000)
        .setSeekForwardIncrementMs(30_000)
        .build()

    val session: MediaSession = MediaSession.Builder(context, player)
        .setSessionActivity(
            PendingIntent.getActivity(
                context, 0,
                Intent(context, MainActivity::class.java),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            ),
        )
        .setCallback(@OptIn(UnstableApi::class) object : MediaSession.Callback {
            // Custom commands are refused unless advertised on connect; without
            // this the UI's play_book/sleep commands failed silently.
            override fun onConnect(
                session: MediaSession,
                controller: MediaSession.ControllerInfo,
            ): MediaSession.ConnectionResult = MediaSession.ConnectionResult.accept(
                MediaSession.ConnectionResult.DEFAULT_SESSION_COMMANDS.buildUpon()
                    .add(SessionCommand(PlaybackCommand.PLAY_BOOK, Bundle()))
                    .add(SessionCommand(PlaybackCommand.SET_SLEEP, Bundle()))
                    .build(),
                // DEFAULT covers play/pause/seek/speed; 1.11's Player.Commands
                // only exposes EMPTY at compile time.
                MediaSession.ConnectionResult.DEFAULT_PLAYER_COMMANDS,
            )

            override fun onCustomCommand(
                session: MediaSession,
                controller: MediaSession.ControllerInfo,
                customCommand: SessionCommand,
                args: Bundle,
            ): ListenableFuture<SessionResult> = when (customCommand.customAction) {
                PlaybackCommand.PLAY_BOOK -> {
                    val id = args.getString(PlaybackCommand.ARG_MEDIA_ID)
                    val book = id?.let { BooksRepository.bookByName(context, it) }
                    if (book != null) {
                        applyBook(book, autoPlay = args.getBoolean(PlaybackCommand.ARG_AUTOPLAY, true))
                        ImmediateFuture(SessionResult(SessionResult.RESULT_SUCCESS))
                    } else {
                        ImmediateFuture(SessionResult(SessionError.ERROR_BAD_VALUE))
                    }
                }

                PlaybackCommand.SET_SLEEP -> {
                    setSleepTimer(
                        args.getInt(PlaybackCommand.ARG_MINUTES, PlaybackCommand.MINUTES_OFF)
                            .takeIf { it > 0 },
                    )
                    ImmediateFuture(SessionResult(SessionResult.RESULT_SUCCESS))
                }

                else -> super.onCustomCommand(session, controller, customCommand, args)
            }
        })
        .build()

    private var positionJob: Job? = null
    private var chapterJob: Job? = null
    private var sleepJob: Job? = null
    private var ticksSinceSave = 0
    private var recoveryAttempts = 0

    /**
     * True only while playback is paused *because the audio route disappeared* —
     * never because the listener pressed pause. Auto-resume keys off this, so
     * reconnecting a headset after a deliberate pause stays silent.
     */
    private var pausedByRouteLoss = false

    /**
     * Whether the player was actually playing. ExoPlayer reports a
     * becoming-noisy pause even for a book that was ALREADY paused, so without
     * this a route blip would arm auto-resume on a book the listener had
     * deliberately stopped - and reconnecting a headset later would start it.
     */
    private var wasPlaying = false

    private val audioManager = context.getSystemService(AudioManager::class.java)

    /**
     * Puts the book back on when the headset returns. A phone notification
     * seizing the Bluetooth route looks like the route vanishing and returning
     * moments later; without this the book stays paused until the listener
     * reaches for the watch, which is the interruption worth avoiding on a run.
     */
    private val audioDeviceCallback = object : AudioDeviceCallback() {
        override fun onAudioDevicesAdded(addedDevices: Array<out AudioDeviceInfo>?) {
            if (!pausedByRouteLoss) return
            val usable = addedDevices?.any { it.isSink && it.type in RESUMABLE_OUTPUTS } == true
            if (!usable) return
            pausedByRouteLoss = false
            Logg.w("audio route restored, resuming at ${player.currentPosition} ms")
            player.play()
        }
    }

    private companion object {
        /** A changing Bluetooth route surfaces as one of these. */
        val RECOVERABLE_ERROR_CODES = setOf(
            PlaybackException.ERROR_CODE_AUDIO_TRACK_INIT_FAILED,
            PlaybackException.ERROR_CODE_AUDIO_TRACK_WRITE_FAILED,
            PlaybackException.ERROR_CODE_AUDIO_TRACK_OFFLOAD_WRITE_FAILED,
            PlaybackException.ERROR_CODE_AUDIO_TRACK_OFFLOAD_INIT_FAILED,
        )

        /** Outputs worth resuming into. The watch speaker is deliberately absent:
         *  a headset dropping should not restart the book out loud on the wrist. */
        val RESUMABLE_OUTPUTS = setOf(
            AudioDeviceInfo.TYPE_BLUETOOTH_A2DP,
            AudioDeviceInfo.TYPE_BLE_HEADSET,
            AudioDeviceInfo.TYPE_BLE_SPEAKER,
            AudioDeviceInfo.TYPE_WIRED_HEADSET,
            AudioDeviceInfo.TYPE_WIRED_HEADPHONES,
            AudioDeviceInfo.TYPE_USB_HEADSET,
        )

        const val MAX_RECOVERY_ATTEMPTS = 5
        const val RECOVERY_DELAY_MS = 500L
    }

    init {
        audioManager.registerAudioDeviceCallback(audioDeviceCallback, Handler(Looper.getMainLooper()))
        scope.launch {
            val savedSpeed = PlayerPrefs.getSpeed(context)
            player.setPlaybackSpeed(savedSpeed)
            PlaybackState.speed.value = savedSpeed
            val savedSleepEnd = PlayerPrefs.getSleepEndMs(context)?.takeIf { it > System.currentTimeMillis() }
            PlaybackState.sleepEndMs.value = savedSleepEnd
            if (savedSleepEnd == null) {
                PlayerPrefs.setSleepEndMs(context, null)
                PlayerPrefs.setSleepMinutes(context, null)
            } else {
                PlaybackState.sleepMinutes.value = PlayerPrefs.getSleepMinutes(context) ?: 15
                startSleepMonitor()
            }
        }
        player.addListener(object : Player.Listener {
            override fun onPlayerError(error: PlaybackException) {
                // Logged at warning level so it survives into release builds:
                // this class of failure only appears on a real headset, and the
                // first report of it left nothing behind to diagnose.
                Logg.w("playerError: ${error.errorCodeName} (${error.message})")
                PlaybackState.playbackError.value = error.errorCodeName
                maybeRecover(error)
            }

            /**
             * Media3 reports *why* playWhenReady changed, which is the whole
             * basis for auto-resume: only a route that vanished underneath us
             * should bring the book back when it returns. A deliberate pause
             * must stay paused.
             */
            override fun onPlayWhenReadyChanged(playWhenReady: Boolean, reason: Int) {
                // `wasPlaying` still holds the pre-pause state here:
                // onIsPlayingChanged arrives after this callback.
                pausedByRouteLoss = !playWhenReady && wasPlaying &&
                    reason == Player.PLAY_WHEN_READY_CHANGE_REASON_AUDIO_BECOMING_NOISY
                if (pausedByRouteLoss) Logg.w("paused: audio route disappeared")
            }

            override fun onIsPlayingChanged(playing: Boolean) {
                Logg.d("onIsPlayingChanged: $playing")
                wasPlaying = playing
                PlaybackState.isPlaying.value = playing
                if (playing) {
                    // A spell of real playback means the last error is behind
                    // us, so the retry budget is fresh for the next one.
                    recoveryAttempts = 0
                    startPositionTicker()
                } else {
                    positionJob?.cancel()
                    positionJob = null
                    savePositionNow()
                }
            }

            override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) {
                Logg.d("onMediaItemTransition: ${mediaItem?.mediaId} reason=$reason")
                chapterJob?.cancel()
                chapterJob = null
                PlaybackState.playbackError.value = null
                PlaybackState.nowPlaying.value = mediaItem?.let {
                    BooksRepository.bookByName(context, it.mediaId)
                }
                PlaybackState.durationMs.value =
                    mediaItem?.let { player.duration.takeIf { d -> d > 0 } ?: 0L } ?: 0L
                // A book prepared while paused never gets a ticker ("0:00" on a
                // resumed position) and preview transitions don't fire a
                // discontinuity — read the position here, on the main thread.
                PlaybackState.positionMs.value = player.currentPosition
                PlaybackState.chapters.value = emptyList()
                PlaybackState.artwork.value = mediaItem?.mediaMetadata?.artworkData
            }

            // Artwork often arrives only after extraction, in a later
            // media-metadata update; surface it whenever it changes.
            override fun onMediaMetadataChanged(mediaMetadata: MediaMetadata) {
                if (mediaMetadata.artworkData != null) {
                    PlaybackState.artwork.value = mediaMetadata.artworkData
                }
            }

            @UnstableApi
            override fun onMetadata(metadata: Metadata) {
                extractChapters(metadata).takeIf { it.isNotEmpty() }?.let {
                    PlaybackState.chapters.value = it
                }
            }

            override fun onTracksChanged(tracks: Tracks) {
                val fmtMetadata = player.audioFormat?.metadata
                Logg.d("onTracksChanged, audioFormat.metadata entries: ${fmtMetadata?.length() ?: 0}")
                fmtMetadata?.let {
                    extractChapters(it).takeIf { c -> c.isNotEmpty() }?.let { c ->
                        PlaybackState.chapters.value = c
                    }
                }
            }

            override fun onEvents(player: Player, events: Player.Events) {
                val dur = player.duration.takeIf { it > 0 }
                if (dur != null && dur != PlaybackState.durationMs.value) {
                    PlaybackState.durationMs.value = dur
                    // Feeds the per-book progress % in the library.
                    val id = player.currentMediaItem?.mediaId ?: return@onEvents
                    scope.launch { PlayerPrefs.setDur(context, id, dur) }
                }
            }

            override fun onPositionDiscontinuity(
                oldPosition: Player.PositionInfo,
                newPosition: Player.PositionInfo,
                reason: Int,
            ) {
                PlaybackState.positionMs.value = newPosition.positionMs
                savePositionNow()
            }

            override fun onPlaybackParametersChanged(playbackParameters: PlaybackParameters) {
                PlaybackState.speed.value = playbackParameters.speed
                // Speed is set through the MediaController now, so persistence
                // happens here instead of in a UI-facing setter.
                scope.launch { PlayerPrefs.setSpeed(context, playbackParameters.speed) }
            }
        })
    }

    /**
     * Re-prepares after an audio-track failure so a book does not simply die.
     *
     * A Bluetooth route changing under the player — a phone notification
     * grabbing the headset, the headset dropping and coming back — surfaces as
     * an `AUDIO_TRACK_*` error. ExoPlayer stops and stays stopped, which is why
     * a run ended with the book silent and unresumable. `prepare()` rebuilds the
     * audio track against whatever route now exists; the position is kept, so
     * playback continues where it stopped.
     *
     * Bounded on purpose: if the route is genuinely gone, retrying forever would
     * spin. Anything that is not an audio-track failure (a missing or unreadable
     * file) is left alone, because retrying cannot help it.
     */
    private fun maybeRecover(error: PlaybackException) {
        val recoverable = error.errorCode in RECOVERABLE_ERROR_CODES
        if (!recoverable || recoveryAttempts >= MAX_RECOVERY_ATTEMPTS) {
            Logg.w("not recovering (recoverable=$recoverable attempts=$recoveryAttempts)")
            return
        }
        recoveryAttempts++
        val resumeAfterRetry = player.playWhenReady
        scope.launch {
            delay(RECOVERY_DELAY_MS * recoveryAttempts)
            Logg.w("recovery attempt $recoveryAttempts at ${player.currentPosition} ms")
            player.prepare()
            if (resumeAfterRetry) player.play()
        }
    }

    /** Opens a book by its library id; [autoPlay] decides play vs prepare. */
    private fun applyBook(book: Book, autoPlay: Boolean) {
        savePositionNow()
        PlaybackState.playbackError.value = null
        ticksSinceSave = 0
        scope.launch {
            val saved = PlayerPrefs.getPos(context, book.id)
            Logg.d("applyBook '${book.id}' resume at $saved ms (play: $autoPlay)")
            val item = MediaItem.Builder()
                .setMediaId(book.id)
                .setUri(Uri.fromFile(book.file))
                .setMediaMetadata(
                    MediaMetadata.Builder()
                        .setTitle(book.title)
                        .setMediaType(MediaMetadata.MEDIA_TYPE_AUDIO_BOOK)
                        .build(),
                )
                .build()
            player.setMediaItem(item, saved.coerceAtLeast(0))
            player.prepare()
            // Started only after setMediaItem: onMediaItemTransition cancels
            // chapterJob, so a read kicked off before this point would be
            // cancelled by the very item it was reading for.
            readChapters(book)
            // Chapters are read off the file separately (see below), so there
            // is no reason to prepare anywhere other than the resume position.
            //
            // Wait for a real duration before deciding whether the book is
            // finished. Note the explicit `> 0` guard below: an unknown
            // duration is C.TIME_UNSET (Long.MIN_VALUE), and `it - 2_000`
            // would then wrap to a huge positive and skip the restart.
            val duration = withTimeoutOrNull(5_000) {
                while (player.duration <= 0) delay(100)
                player.duration
            } ?: 0L
            if (saved > 0 && duration > 0 && saved >= duration - 2_000) {
                Logg.d("book was finished, restarting from 0")
                player.seekTo(0)
                PlayerPrefs.setPos(context, book.id, 0)
            }
            if (autoPlay) player.play()
            PlayerPrefs.setLastBook(context, book.id)
        }
    }

    /**
     * Chapters come from the file, not from playback. The player publishes the
     * same data, but only while actually playing and only until the first seek,
     * so a book opened paused at its saved position never got any.
     */
    private fun readChapters(book: Book) {
        chapterJob?.cancel()
        chapterJob = scope.launch {
            val chapters = withContext(Dispatchers.IO) { ChapterReader.read(book.file) }
            Logg.d("read ${chapters.size} chapters for '${book.id}'")
            if (chapters.isNotEmpty() && player.currentMediaItem?.mediaId == book.id) {
                PlaybackState.chapters.value = label(chapters)
            }
        }
    }

    private fun startSleepMonitor() {
        sleepJob?.cancel()
        sleepJob = scope.launch {
            while (isActive) {
                val end = PlaybackState.sleepEndMs.value ?: return@launch
                if (System.currentTimeMillis() >= end) {
                    player.pause()
                    PlayerPrefs.setSleepEndMs(context, null)
                    PlayerPrefs.setSleepMinutes(context, null)
                    PlaybackState.sleepEndMs.value = null
                    PlaybackState.sleepMinutes.value = null
                    return@launch
                }
                delay(1_000)
            }
        }
    }

    private fun startPositionTicker() {
        positionJob?.cancel()
        positionJob = scope.launch {
            try {
                while (isActive) {
                    PlaybackState.positionMs.value = player.currentPosition
                    if (++ticksSinceSave >= 20) {
                        ticksSinceSave = 0
                        savePositionNow()
                    }
                    delay(1_000)
                }
            } catch (_: Exception) {
            }
        }
    }

    private fun positionSnapshot(): Pair<String, Long>? {
        val id = player.currentMediaItem?.mediaId ?: return null
        // Deliberately ignores 0: a transient 0 during load/stop must never
        // overwrite a real resume position. The one case where 0 is the true
        // position — a finished book restarted from the start — is persisted
        // explicitly in applyBook instead.
        val pos = player.currentPosition
        return if (pos > 0) id to pos else null
    }

    private fun savePositionNow() {
        val (bookId, posMs) = positionSnapshot() ?: return
        scope.launch { PlayerPrefs.setPos(context, bookId, posMs) }
    }

    /** null = off. [minutes] from now; persisted so a service restart re-arms it. */
    private fun setSleepTimer(minutes: Int?) {
        scope.launch {
            val end = minutes?.let { System.currentTimeMillis() + it * 60_000L }
            PlayerPrefs.setSleepEndMs(context, end)
            PlayerPrefs.setSleepMinutes(context, minutes)
            PlaybackState.sleepEndMs.value = end
            PlaybackState.sleepMinutes.value = minutes
            startSleepMonitor()
        }
    }

    /**
     * Chapters as Media3 extracts them from the *playing* stream: Nero `chpl`
     * and QuickTime chapter tracks from MP4/M4B, ID3 `CHAP` frames from MP3.
     * This is a bonus path — it only delivers while the player is actually
     * playing and only until the first seek, so [ChapterReader] is what the
     * app really relies on. Kept because it costs nothing and fills the list a
     * little sooner when a book is played from the start.
     */
    private fun extractChapters(metadata: Metadata): List<Chapter> = label(
        metadata.getEntriesOfType(Media3Chapter::class.java)
            .filterNot { it.isHidden }
            .map {
                Chapter(
                    startMs = it.startTimeMs,
                    endMs = it.endTimeMs,
                    title = it.title?.value?.trim().orEmpty(),
                )
            },
    )

    /**
     * Sorts, de-duplicates and names a chapter list. Plenty of files tag every
     * chapter with the book's own title, or leave the title empty; twenty-one
     * identical rows say nothing on a 1.7-inch screen, so fall back to
     * numbering unless the titles actually tell the chapters apart.
     */
    private fun label(raw: List<Chapter>): List<Chapter> {
        val chapters = raw.sortedBy { it.startMs }.distinctBy { it.startMs }
        val titlesAreUseful = chapters.mapTo(HashSet()) { it.title }.size > 1
        return chapters.mapIndexed { i, c ->
            if (titlesAreUseful && c.title.isNotEmpty()) c
            else c.copy(title = "Chapter ${i + 1}")
        }
    }

    fun release() {
        audioManager.unregisterAudioDeviceCallback(audioDeviceCallback)
        positionJob?.cancel()
        positionJob = null
        chapterJob?.cancel()
        chapterJob = null
        positionSnapshot()?.let { (bookId, posMs) ->
            runBlocking {
                withTimeoutOrNull(500) { PlayerPrefs.setPos(context, bookId, posMs) }
            }
        }
        player.release()
        session.release()
        scope.cancel()
        // The UI can outlive the service; without this it keeps rendering the
        // old book as playing while a restarted service has nothing loaded.
        PlaybackState.clear()
    }
}

/**
 * The guava artifact Media3 references is the empty "ListenableFuture only"
 * one, so immediate futures have to be provided by hand instead of through
 * com.google.common.util.concurrent.Futures.
 */
private class ImmediateFuture<T>(private val value: T) : ListenableFuture<T> {
    override fun addListener(listener: Runnable, executor: Executor): Unit = executor.execute(listener)
    override fun cancel(mayInterruptIfRunning: Boolean): Boolean = false
    override fun isCancelled(): Boolean = false
    override fun isDone(): Boolean = true
    override fun get(): T = value
    override fun get(timeout: Long, unit: TimeUnit): T = value
}