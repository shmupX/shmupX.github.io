package com.emre.aloud.ui

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.unit.dp
import androidx.wear.compose.foundation.lazy.TransformingLazyColumn
import androidx.wear.compose.foundation.lazy.rememberTransformingLazyColumnState
import androidx.wear.compose.foundation.rotary.RotaryScrollableDefaults
import androidx.wear.compose.material3.Button
import androidx.wear.compose.material3.ListHeader
import androidx.wear.compose.material3.Text
import androidx.wear.compose.material3.TimeText
import com.emre.aloud.R
import com.emre.aloud.books.Book
import com.emre.aloud.books.BooksRepository
import com.emre.aloud.data.PlayerPrefs
import com.emre.aloud.playback.PlaybackState
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** R28/R29/R31/R33/R34: TransformingLazyColumn with crown scrolling, per-book
 *  progress %, and long-press delete against a confirmation dialog. */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun LibraryScreen(
    onPlay: (Book) -> Unit,
    onOpenUploader: () -> Unit,
    onOpenRemote: () -> Unit,
    onOpenNowPlaying: () -> Unit,
    onDelete: suspend (Book) -> Unit,
) {
    val context = LocalContext.current
    val nowPlaying by PlaybackState.nowPlaying.collectAsState()
    var books by remember { mutableStateOf<List<Book>>(emptyList()) }
    var positions by remember { mutableStateOf<Map<String, Long>>(emptyMap()) }
    var durations by remember { mutableStateOf<Map<String, Long>>(emptyMap()) }
    var pendingDelete by remember { mutableStateOf<Book?>(null) }
    var deletedFlash by remember { mutableStateOf(false) }
    val listState = rememberTransformingLazyColumnState()
    val scope = rememberCoroutineScope()

    suspend fun reload() {
        val loaded = withContext(Dispatchers.IO) {
            Triple(BooksRepository.list(context), PlayerPrefs.positions(context), PlayerPrefs.durations(context))
        }
        books = loaded.first
        positions = loaded.second
        durations = loaded.third
    }

    LaunchedEffect(Unit) { reload() }

    if (books.isEmpty()) {
        Column(
            Modifier.fillMaxSize(),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
        ) {
            Text(stringResource(R.string.library_empty))
            Button(
                onClick = onOpenUploader,
                modifier = Modifier.padding(top = 12.dp),
            ) { Text(stringResource(R.string.library_uploader)) }
            // The desktop remote needs no books on the watch, so it has to be
            // reachable from an empty library too.
            Button(
                onClick = onOpenRemote,
                modifier = Modifier.padding(top = 8.dp),
            ) { Text(stringResource(R.string.library_remote)) }
        }
        return
    }

    val rotaryBehavior = RotaryScrollableDefaults.behavior(listState)

    Box(Modifier.fillMaxSize()) {
        TimeText(Modifier.align(Alignment.TopCenter))
        TransformingLazyColumn(
            modifier = Modifier.fillMaxSize(),
            state = listState,
            contentPadding = PaddingValues(top = 32.dp, bottom = 72.dp),
            rotaryScrollableBehavior = rotaryBehavior,
        ) {
            item { ListHeader { Text(stringResource(R.string.library_header)) } }
            // Way back to the player. Without this the library was a one-way
            // trip: NowPlaying has a back handler to here, but nothing led the
            // other way, so the only route back was re-tapping the book (which
            // reloads it) or restarting the app.
            nowPlaying?.let { np ->
                item {
                    Text(
                        text = stringResource(R.string.library_now_playing, np.title),
                        modifier = Modifier
                            .fillMaxWidth()
                            .clickable { onOpenNowPlaying() }
                            .padding(vertical = 10.dp, horizontal = 16.dp),
                        color = Color.Cyan,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
            item {
                Text(
                    text = stringResource(R.string.library_remote),
                    modifier = Modifier
                        .fillMaxWidth()
                        .clickable { onOpenRemote() }
                        .padding(vertical = 10.dp, horizontal = 16.dp),
                    maxLines = 1,
                )
            }
            items(count = books.size, key = { books[it].id }) { i ->
                val book = books[i]
                val pct = posPct(positions[book.id], durations[book.id])
                Text(
                    text = if (pct != null) "${book.title} · ${pct}%" else book.title,
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(vertical = 10.dp, horizontal = 16.dp)
                        .combinedClickable(
                            onClick = { onPlay(book) },
                            onLongClick = { pendingDelete = book },
                        ),
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        if (deletedFlash) {
            Text(
                text = stringResource(R.string.library_delete_done),
                modifier = Modifier
                    .align(Alignment.Center)
                    .padding(horizontal = 16.dp),
                textAlign = TextAlign.Center,
            )
        }
        // Pinned footer: a last list item scrolled below the bezel is invisible
        // and untappable; this one is always on screen.
        Button(
            onClick = onOpenUploader,
            modifier = Modifier
                .align(Alignment.BottomCenter)
                .fillMaxWidth()
                .padding(vertical = 8.dp, horizontal = 16.dp),
        ) { Text(stringResource(R.string.library_uploader)) }
    }

    // Plain compose Dialog: the m3 dialog slot APIs shifted between 1.5/1.6 and
    // this app needs nothing curved here — a centered confirm is enough.
    pendingDelete?.let { book ->
        Dialog(onDismissRequest = { pendingDelete = null }) {
            Column(
                Modifier.fillMaxWidth().padding(16.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Text(stringResource(R.string.library_delete_title))
                Text(
                    stringResource(R.string.library_delete_message, book.title),
                    textAlign = TextAlign.Center,
                    maxLines = 2,
                )
                Button(onClick = {
                    pendingDelete = null
                    scope.launch {
                        onDelete(book)
                        reload()
                        // Acknowledgment: the watch shows no system feedback for
                        // app data removal, so the library confirms it itself.
                        deletedFlash = true
                        delay(1_800)
                        deletedFlash = false
                    }
                }) { Text(stringResource(R.string.action_delete)) }
                Button(onClick = { pendingDelete = null }) {
                    Text(stringResource(R.string.action_cancel))
                }
            }
        }
    }
}

private fun posPct(posMs: Long?, durMs: Long?): Int? =
    if (posMs != null && durMs != null && durMs > 0) ((posMs * 100) / durMs).toInt()
    else null
