package com.emre.aloud.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
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
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.LifecycleStartEffect
import androidx.wear.compose.foundation.lazy.TransformingLazyColumn
import androidx.wear.compose.foundation.lazy.rememberTransformingLazyColumnState
import androidx.wear.compose.foundation.rotary.RotaryScrollableDefaults
import androidx.wear.compose.foundation.rotary.rotaryScrollable
import androidx.wear.compose.material3.Button
import androidx.wear.compose.material3.ListHeader
import androidx.wear.compose.material3.Text
import androidx.wear.compose.material3.TimeText
import com.emre.aloud.BuildConfig
import com.emre.aloud.R
import com.emre.aloud.data.PlayerPrefs
import com.emre.aloud.remote.NOT_SENT
import com.emre.aloud.remote.NO_REPLY
import com.emre.aloud.remote.PairCode
import com.emre.aloud.remote.RemoteAlbum
import com.emre.aloud.remote.RemoteBridge
import com.emre.aloud.remote.RemoteTrack
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * The desktop music remote: the paired launcher's albums, and a tap switches
 * the song playing over there. Nothing on this screen touches the watch's own
 * player — a book loaded here stays exactly as it was.
 */
@Composable
fun RemoteScreen() {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    // null while the stored code is being read; "" once known to be unpaired.
    var code by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(Unit) {
        val stored = withContext(Dispatchers.IO) { PlayerPrefs.getPairCode(context) }
        code = PairCode.resolve(stored, BuildConfig.REMOTE_PAIR_CODE)
    }

    fun save(next: String) {
        code = next
        // "" rather than removing the key: an explicit unpair must not fall
        // back to a code baked in at build time.
        scope.launch { PlayerPrefs.setPairCode(context, next) }
    }

    when (val paired = code) {
        null -> Unit
        "" -> PairPrompt(onPair = ::save)
        else -> RemoteLibrary(paired, onUnpair = { save("") })
    }
}

@Composable
private fun PairPrompt(onPair: (String) -> Unit) {
    var typed by remember { mutableStateOf("") }
    val valid = PairCode.isValid(typed)
    val scrollState = rememberScrollState()
    val focusRequester = remember { FocusRequester() }
    val fieldDesc = stringResource(R.string.remote_pair_code)
    LaunchedEffect(Unit) { focusRequester.requestFocus() }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .rotaryScrollable(RotaryScrollableDefaults.behavior(scrollState), focusRequester)
            .verticalScroll(scrollState)
            .padding(vertical = 32.dp, horizontal = 20.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Text(
            text = stringResource(R.string.remote_pair_hint),
            textAlign = TextAlign.Center,
        )
        BasicTextField(
            value = typed,
            // Typed on a watch keyboard: keep whatever separator was typed out
            // of the way and never hold more than a code's worth.
            onValueChange = { typed = PairCode.normalize(it).take(PairCode.LENGTH) },
            singleLine = true,
            // The default text style is black, which on this screen is invisible.
            textStyle = TextStyle(color = Color.White, fontSize = 20.sp, textAlign = TextAlign.Center),
            cursorBrush = SolidColor(Color.Cyan),
            keyboardOptions = KeyboardOptions(
                capitalization = KeyboardCapitalization.Characters,
                autoCorrectEnabled = false,
                imeAction = ImeAction.Done,
            ),
            // The watch keyboard hands over the text and fires Done back to back,
            // before this screen has recomposed — so validity is read from the
            // state here, not from `valid`, which is still the pre-typing value.
            // And supplying onDone replaces the default of closing the keyboard,
            // so a code that is not one yet has to close it explicitly or the
            // confirm button appears to do nothing at all.
            keyboardActions = KeyboardActions(
                onDone = {
                    if (PairCode.isValid(typed)) onPair(PairCode.normalize(typed))
                    else defaultKeyboardAction(ImeAction.Done)
                },
            ),
            modifier = Modifier
                .fillMaxWidth()
                .padding(vertical = 12.dp)
                .semantics { contentDescription = fieldDesc },
            decorationBox = { field ->
                Box(contentAlignment = Alignment.Center) {
                    if (typed.isEmpty()) {
                        Text(stringResource(R.string.remote_pair_placeholder), color = Color.Gray)
                    }
                    field()
                }
            },
        )
        Button(
            onClick = { onPair(PairCode.normalize(typed)) },
            enabled = valid,
        ) { Text(stringResource(R.string.action_pair)) }
    }
}

/** One row of the flattened album list. Keys are positional: ids come from a
 *  database other people can write to, and a lazy list crashes on a repeat. */
private sealed interface RemoteRow {
    val key: String

    data class Album(val index: Int, val album: RemoteAlbum) : RemoteRow {
        override val key get() = "a$index"
    }

    data class Track(val albumIndex: Int, val index: Int, val albumId: String, val track: RemoteTrack) : RemoteRow {
        override val key get() = "t$albumIndex-$index"
    }
}

@Composable
private fun RemoteLibrary(code: String, onUnpair: () -> Unit) {
    val bridge = remember(code) { RemoteBridge(BuildConfig.REMOTE_RTDB_URL, code) }
    // Open only while the app is in front. A stream held through a pocketed,
    // screen-off afternoon is a radio kept awake for a list nobody is reading.
    LifecycleStartEffect(bridge) {
        bridge.start()
        onStopOrDispose { bridge.stop() }
    }

    val connection by bridge.connection.collectAsState()
    val hostSeen by bridge.hostSeen.collectAsState()
    val library by bridge.library.collectAsState()
    val playing by bridge.playing.collectAsState()
    val pending by bridge.pending.collectAsState()

    // "Not answering" is a claim about the desktop, so it waits for the sync
    // sent on connect to have had a fair chance of being answered.
    var waitedOut by remember { mutableStateOf(false) }
    LaunchedEffect(connection, hostSeen) {
        waitedOut = false
        if (connection == RemoteBridge.Connection.CONNECTED && !hostSeen) {
            delay(6_000)
            waitedOut = true
        }
    }
    LaunchedEffect(pending) {
        if (pending?.error != null) {
            delay(4_000)
            bridge.dismissError()
        }
    }

    val rows = remember(library) {
        buildList<RemoteRow> {
            library.forEachIndexed { a, album ->
                add(RemoteRow.Album(a, album))
                album.tracks.forEachIndexed { t, track -> add(RemoteRow.Track(a, t, album.id, track)) }
            }
        }
    }
    // What the desktop last said is only "now playing" while a desktop is there
    // to have said it; otherwise it is whatever was left behind.
    val current = playing.takeIf { hostSeen && it.hasTrack }
    val status = when {
        connection != RemoteBridge.Connection.CONNECTED -> stringResource(R.string.remote_connecting)
        current != null -> stringResource(
            if (current.isPaused) R.string.remote_paused else R.string.remote_playing,
            current.title ?: current.trackId.orEmpty(),
        )
        hostSeen -> stringResource(R.string.remote_idle)
        waitedOut -> stringResource(R.string.remote_no_desktop)
        else -> stringResource(R.string.remote_waiting)
    }

    val listState = rememberTransformingLazyColumnState()
    val rotaryBehavior = RotaryScrollableDefaults.behavior(listState)
    val prevDesc = stringResource(R.string.action_previous_song)
    val nextDesc = stringResource(R.string.action_next_song)
    val playDesc = stringResource(if (current?.isPaused == false) R.string.action_pause else R.string.action_play)

    Box(Modifier.fillMaxSize()) {
        TimeText(Modifier.align(Alignment.TopCenter))
        TransformingLazyColumn(
            modifier = Modifier.fillMaxSize(),
            state = listState,
            contentPadding = PaddingValues(top = 32.dp, bottom = 32.dp),
            rotaryScrollableBehavior = rotaryBehavior,
        ) {
            item { ListHeader { Text(stringResource(R.string.remote_header)) } }
            item {
                Text(
                    text = status,
                    modifier = Modifier.fillMaxWidth().padding(vertical = 6.dp, horizontal = 16.dp),
                    color = if (current != null) Color.Cyan else Color.Unspecified,
                    textAlign = TextAlign.Center,
                    maxLines = 3,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            if (current != null) {
                item {
                    Row(
                        modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
                        horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterHorizontally),
                    ) {
                        Button(
                            onClick = { bridge.control("prev") },
                            modifier = Modifier.semantics { contentDescription = prevDesc },
                        ) { Text("⏮") }
                        Button(
                            onClick = { bridge.control(if (current.isPaused) "resume" else "pause") },
                            modifier = Modifier.semantics { contentDescription = playDesc },
                        ) { Text(if (current.isPaused) "▶" else "⏸") }
                        Button(
                            onClick = { bridge.control("next") },
                            modifier = Modifier.semantics { contentDescription = nextDesc },
                        ) { Text("⏭") }
                    }
                }
            }
            pending?.error?.let { error ->
                item {
                    Text(
                        text = when (error) {
                            NO_REPLY -> stringResource(R.string.remote_no_reply)
                            NOT_SENT -> stringResource(R.string.remote_not_sent)
                            else -> stringResource(R.string.remote_failed, error)
                        },
                        modifier = Modifier
                            .fillMaxWidth()
                            .clickable { bridge.dismissError() }
                            .padding(vertical = 6.dp, horizontal = 16.dp),
                        color = Color.Red,
                        textAlign = TextAlign.Center,
                        maxLines = 2,
                    )
                }
            }
            if (rows.isEmpty() && hostSeen) {
                item {
                    Text(
                        text = stringResource(R.string.remote_no_albums),
                        modifier = Modifier.fillMaxWidth().padding(vertical = 10.dp, horizontal = 16.dp),
                        textAlign = TextAlign.Center,
                    )
                }
            }
            items(count = rows.size, key = { rows[it].key }) { i ->
                when (val row = rows[i]) {
                    is RemoteRow.Album -> ListHeader { Text(row.album.title, maxLines = 1, overflow = TextOverflow.Ellipsis) }
                    is RemoteRow.Track -> {
                        val waiting = pending?.takeIf {
                            it.error == null && it.albumId == row.albumId && it.trackId == row.track.id
                        } != null
                        val isCurrent = current?.albumId == row.albumId && current.trackId == row.track.id
                        Text(
                            text = if (waiting) stringResource(R.string.remote_sending, row.track.title) else row.track.title,
                            color = if (isCurrent) Color.Cyan else Color.Unspecified,
                            modifier = Modifier
                                .fillMaxWidth()
                                .clickable { bridge.launch(row.albumId, row.track.id) }
                                .padding(vertical = 8.dp, horizontal = 16.dp),
                            maxLines = 2,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
            }
            item {
                Button(
                    onClick = onUnpair,
                    modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp, horizontal = 16.dp),
                ) { Text(stringResource(R.string.remote_unpair, PairCode.format(code))) }
            }
        }
    }
}
