package com.emre.aloud.playback

import android.os.Bundle
import androidx.media3.session.MediaController
import androidx.media3.session.SessionCommand
import com.emre.aloud.books.Book
import kotlinx.coroutines.flow.MutableStateFlow

/** One chapter of the current book, as extracted by Media3 (Nero `chpl`,
 *  QuickTime chapter tracks and ID3 `CHAP` all land here). [endMs] is -1 when
 *  the source did not provide one. */
data class Chapter(val startMs: Long, val endMs: Long, val title: String)

/** Index of the chapter containing [positionMs], or -1 before the first one. */
fun List<Chapter>.chapterIndexAt(positionMs: Long): Int =
    indexOfLast { it.startMs <= positionMs }

/**
 * UI-facing playback state, written by PlayerManager (the service side) and
 * read by the UI. Process-wide by design; no Context, so it is not the thing
 * R20 gets rid of — that is the PlayerManager singleton.
 */
object PlaybackState {
    val nowPlaying = MutableStateFlow<Book?>(null)
    val isPlaying = MutableStateFlow(false)
    val positionMs = MutableStateFlow(0L)
    val durationMs = MutableStateFlow(0L)
    val speed = MutableStateFlow(1.0f)
    val chapters = MutableStateFlow<List<Chapter>>(emptyList())
    val sleepEndMs = MutableStateFlow<Long?>(null)
    /** Armed sleep-timer option (15/30/60/120), kept across re-arms and restarts. */
    val sleepMinutes = MutableStateFlow<Int?>(null)
    /** Last playback error to show on the now-playing screen; null = fine. */
    val playbackError = MutableStateFlow<String?>(null)
    /** Extracted cover art (ID3 APIC / M4B covr) of the current book. */
    val artwork = MutableStateFlow<ByteArray?>(null)

    /**
     * Clears everything the service owns. Called when the player goes away, so
     * a UI that outlives the service does not keep showing a book as playing
     * while the restarted service actually has nothing loaded.
     */
    fun clear() {
        nowPlaying.value = null
        isPlaying.value = false
        positionMs.value = 0L
        durationMs.value = 0L
        chapters.value = emptyList()
        playbackError.value = null
        artwork.value = null
    }
}

/**
 * The transport surface the UI uses. One implementation, backed by the
 * MediaController — the UI has no direct handle to the player.
 */
interface PlaybackUi {
    fun togglePlayPause()
    fun skipToChapter(index: Int)
    fun skipRelative(deltaMs: Long)
    fun setSpeed(speed: Float)
    fun setSleepTimer(minutes: Int?)
    fun playBook(book: Book)
    fun prepareBook(book: Book)
    fun stop()
}

class ControllerPlaybackUi(private val controller: MediaController) : PlaybackUi {

    override fun togglePlayPause() {
        if (controller.isPlaying) controller.pause() else controller.play()
    }

    override fun skipToChapter(index: Int) {
        PlaybackState.chapters.value.getOrNull(index)?.let { controller.seekTo(it.startMs) }
    }

    /** ±[deltaMs] skip for chapterless books, clamped to the track. */
    override fun skipRelative(deltaMs: Long) {
        val max = controller.duration.takeIf { it > 0 } ?: Long.MAX_VALUE
        val target = (controller.currentPosition + deltaMs).coerceIn(0L, max)
        controller.seekTo(target)
    }

    override fun setSpeed(speed: Float) = controller.setPlaybackSpeed(speed)

    /** null = off. [minutes] from now; the session persists and re-arms it. */
    override fun setSleepTimer(minutes: Int?) {
        controller.sendCustomCommand(
            SessionCommand(PlaybackCommand.SET_SLEEP, Bundle()),
            Bundle().apply {
                putInt(PlaybackCommand.ARG_MINUTES, minutes ?: PlaybackCommand.MINUTES_OFF)
            },
        )
    }

    override fun playBook(book: Book) {
        sendPlayBook(book, autoPlay = true)
    }

    override fun prepareBook(book: Book) {
        sendPlayBook(book, autoPlay = false)
    }

    override fun stop() = controller.stop()

    private fun sendPlayBook(book: Book, autoPlay: Boolean) = controller.sendCustomCommand(
        SessionCommand(PlaybackCommand.PLAY_BOOK, Bundle()),
        Bundle().apply {
            putString(PlaybackCommand.ARG_MEDIA_ID, book.id)
            putBoolean(PlaybackCommand.ARG_AUTOPLAY, autoPlay)
        },
    )
}
