package com.emre.aloud.ui

import androidx.compose.foundation.Image
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.wear.compose.foundation.rotary.RotaryScrollableDefaults
import androidx.wear.compose.foundation.rotary.rotaryScrollable
import androidx.wear.compose.material3.Button
import androidx.wear.compose.material3.Text
import com.emre.aloud.R
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import com.emre.aloud.playback.PlaybackState
import com.emre.aloud.playback.PlaybackUi
import com.emre.aloud.playback.chapterIndexAt
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import java.util.Locale

private val SPEED_OPTIONS = listOf(0.75f, 1.0f, 1.25f, 1.5f, 2.0f)
private val SLEEP_OPTIONS = listOf(15, 30, 60, 120)

@Composable
fun NowPlayingScreen(ui: PlaybackUi, onOpenChapters: () -> Unit) {
    val nowPlaying by PlaybackState.nowPlaying.collectAsState()
    val isPlaying by PlaybackState.isPlaying.collectAsState()
    val positionMs by PlaybackState.positionMs.collectAsState()
    val durationMs by PlaybackState.durationMs.collectAsState()
    val chapters by PlaybackState.chapters.collectAsState()
    val speed by PlaybackState.speed.collectAsState()
    val sleepEndMs by PlaybackState.sleepEndMs.collectAsState()
    val sleepArmed by PlaybackState.sleepMinutes.collectAsState()
    val error by PlaybackState.playbackError.collectAsState()
    val artworkBytes by PlaybackState.artwork.collectAsState()
    var cover by remember { mutableStateOf<ImageBitmap?>(null) }

    // Decode the cover off the main thread, downscaled; the source art can be
    // a full-size picture and this is a ~2-inch round screen.
    LaunchedEffect(artworkBytes) {
        cover = artworkBytes?.let { bytes ->
            withContext(Dispatchers.Default) {
                val art = BitmapFactory.decodeByteArray(bytes, 0, bytes.size) ?: return@withContext null
                val target = 256
                val scaled = if (art.width > target || art.height > target) {
                    val scale = target.toFloat() / maxOf(art.width, art.height)
                    Bitmap.createScaledBitmap(
                        art,
                        (art.width * scale).toInt().coerceAtLeast(1),
                        (art.height * scale).toInt().coerceAtLeast(1),
                        true,
                    )
                } else art
                scaled.asImageBitmap()
            }
        }
    }

    // Tick so the sleep countdown stays fresh. The clock is refreshed *before*
    // the first delay: waiting 30 s first meant a freshly armed 15-minute timer
    // was measured against a stale `now` and read "Zzz 16m".
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(sleepEndMs) {
        while (sleepEndMs != null) {
            now = System.currentTimeMillis()
            delay(30_000)
        }
    }

    val chapterIndex = remember(positionMs, chapters) {
        chapters.chapterIndexAt(positionMs)
    }
    // Round remaining time up: a 15-minute timer should read "15m" for its
    // first minute, not drop to "14m" a second after it is armed.
    val sleepRemainingMin = sleepEndMs?.let {
        ((it - now + 59_999) / 60_000).toInt().coerceAtLeast(1)
    }

    // This screen has to scroll. Cover art plus a two-line chapter title pushed
    // the speed and sleep chips clean off the bottom of a 480 px watch - they
    // were unreachable - and clipped the Chapters button against the bezel.
    val scrollState = rememberScrollState()
    val focusRequester = remember { FocusRequester() }
    LaunchedEffect(Unit) { focusRequester.requestFocus() }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .rotaryScrollable(
                RotaryScrollableDefaults.behavior(scrollState),
                focusRequester,
            )
            .verticalScroll(scrollState)
            .padding(vertical = 32.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        // R33: current chapter title when known, else the plain header.
        val chapterTitle = chapters.getOrNull(chapterIndex)?.title
        cover?.let {
            Image(
                bitmap = it,
                contentDescription = "Book cover",
                modifier = Modifier
                    .size(88.dp)
                    .padding(bottom = 4.dp),
            )
        }
        Text(
            text = chapterTitle ?: (nowPlaying?.title ?: ""),
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
            textAlign = TextAlign.Center,
        )
        Text(
            text = if (chapters.isNotEmpty())
                "ch ${(chapterIndex + 1).coerceAtLeast(1)}/${chapters.size} · ${fmtTime(positionMs)}/${fmtTime(durationMs)}"
            else
                "${fmtTime(positionMs)}/${fmtTime(durationMs)}",
            maxLines = 1,
        )
        error?.let {
            Text(
                text = "⚠ $it",
                color = Color.Red,
                textAlign = TextAlign.Center,
                maxLines = 2,
            )
        }

        val prevDesc = stringResource(R.string.action_previous_chapter)
        val nextDesc = stringResource(R.string.action_next_chapter)
        val playDesc = stringResource(if (isPlaying) R.string.action_pause else R.string.action_play)
        Row(
            modifier = Modifier.padding(top = 12.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            // Chapters when present; otherwise -30s/+30s rewind/fast-forward.
            Button(
                onClick = {
                    if (chapters.isNotEmpty()) ui.skipToChapter((chapterIndex - 1).coerceAtLeast(0))
                    else ui.skipRelative(-30_000)
                },
                enabled = if (chapters.isNotEmpty()) chapterIndex > 0 else durationMs > 0,
                modifier = Modifier.semantics { contentDescription = prevDesc },
            ) { Text("⏮") }
            Button(
                onClick = { ui.togglePlayPause() },
                modifier = Modifier.semantics { contentDescription = playDesc },
            ) { Text(if (isPlaying) "⏸" else "▶") }
            Button(
                onClick = {
                    if (chapters.isNotEmpty()) ui.skipToChapter(chapterIndex + 1)
                    else ui.skipRelative(30_000)
                },
                enabled = if (chapters.isNotEmpty()) chapterIndex < chapters.size - 1 else durationMs > 0,
                modifier = Modifier.semantics { contentDescription = nextDesc },
            ) { Text("⏭") }
        }

        Button(
            onClick = onOpenChapters,
            modifier = Modifier.padding(top = 8.dp),
            enabled = chapters.isNotEmpty(),
        ) { Text(stringResource(R.string.action_open_chapters)) }

        Row(
            modifier = Modifier.padding(top = 8.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Button(onClick = {
                // Match with a tolerance: a speed restored from DataStore need
                // not be bit-identical to an option, and exact Float equality
                // would return -1 and snap the user back to 0.75x.
                val idx = SPEED_OPTIONS.indexOfFirst { kotlin.math.abs(it - speed) < 0.01f }
                val next = SPEED_OPTIONS[(idx.coerceAtLeast(0) + 1) % SPEED_OPTIONS.size]
                ui.setSpeed(next)
            }) { Text(String.format(Locale.US, "%.2f×", speed)) }

            // Cycle from the armed option, not the shrunk remaining minutes:
            // 15 → 30 → 60 → 120 → off, mid-countdown included.
            Button(onClick = {
                val next = when (val idx = sleepArmed?.let { SLEEP_OPTIONS.indexOf(it) } ?: -1) {
                    -1 -> SLEEP_OPTIONS.first()
                    SLEEP_OPTIONS.lastIndex -> null // off
                    else -> SLEEP_OPTIONS[idx + 1]
                }
                ui.setSleepTimer(next)
            }) { Text(if (sleepEndMs != null) "Zzz ${sleepRemainingMin}m" else stringResource(R.string.action_sleep_off)) }
        }
    }
}