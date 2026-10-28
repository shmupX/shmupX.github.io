package com.emre.aloud.ui

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.core.content.ContextCompat
import androidx.media3.session.MediaController
import androidx.wear.compose.material3.Text
import com.emre.aloud.R
import com.emre.aloud.books.BooksRepository
import com.emre.aloud.data.PlayerPrefs
import com.emre.aloud.playback.ControllerPlaybackUi
import com.emre.aloud.playback.PlaybackState
import com.emre.aloud.playback.PlaybackUi
import com.emre.aloud.upload.UploadServerService
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

private sealed interface Screen {
    data object Library : Screen
    data object NowPlaying : Screen
    data object Chapters : Screen
    data object Uploader : Screen
    data object Remote : Screen
}

@Composable
fun WearApp(
    controller: MediaController?,
    autoplayBookId: String? = null,
    initialScreen: String? = null,
    startUploader: Boolean = false,
) {
    val context = LocalContext.current
    // The UI drives playback exclusively through the MediaController — never
    // through the player object the service owns. Rebuilds when the controller
    // connection settles; until then the buttons simply are not interactive.
    val ui: PlaybackUi? = remember(controller) { controller?.let(::ControllerPlaybackUi) }
    var screen by remember {
        mutableStateOf(
            when (initialScreen) {
                "nowplaying" -> Screen.NowPlaying
                "uploader" -> Screen.Uploader
                "remote" -> Screen.Remote
                else -> Screen.Library
            },
        )
    }

    LaunchedEffect(startUploader) {
        if (startUploader) UploadServerService.start(context)
    }

    // Continue-listening runs once per app launch. Keyed on `ui` alone it also
    // re-fired on every controller reconnect, yanking the user back to
    // NowPlaying mid-browse and re-preparing the last book.
    var restored by rememberSaveable { mutableStateOf(false) }
    LaunchedEffect(ui) {
        if (ui == null || restored) return@LaunchedEffect
        restored = true
        if (autoplayBookId != null) {
            BooksRepository.bookByName(context, autoplayBookId)?.let {
                ui.playBook(it)
                screen = Screen.NowPlaying
            }
        } else if (initialScreen == null) {
            // continue-listening: reopen the last book, paused at its position.
            // It is prepared, not playing — the user decides when to resume.
            val lastId = withContext(Dispatchers.IO) { PlayerPrefs.getLastBook(context) }
            val last = lastId?.let { BooksRepository.bookByName(context, it) }
            if (last != null) {
                ui.prepareBook(last)
                screen = Screen.NowPlaying
            }
        }
    }

    // R15: the media notification needs POST_NOTIFICATIONS on API 33+; requesting
    // it only from the uploader screen used to suppress media controls until the
    // user happened to open the uploader.
    val notificationPerm = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions(),
    ) { }
    fun requestNotificationPermission() {
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED
        ) {
            notificationPerm.launch(arrayOf(Manifest.permission.POST_NOTIFICATIONS))
        }
    }

    // Until the MediaController connects there is no transport to drive. Show
    // the library's own empty/loading frame rather than returning early, which
    // left the watch face blank for the whole connect.
    val uiOr: PlaybackUi = ui ?: run {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            Text(stringResource(R.string.connecting))
        }
        return
    }
    when (screen) {
        Screen.Library -> {
            LibraryScreen(
                onPlay = { book ->
                    // Re-opening the book that is already loaded would tear the
                    // player down and re-prepare it - an audible hiccup for what
                    // the user means as "show me the player".
                    if (PlaybackState.nowPlaying.value?.id != book.id) {
                        requestNotificationPermission()
                        uiOr.playBook(book)
                    }
                    screen = Screen.NowPlaying
                },
                onOpenUploader = { screen = Screen.Uploader },
                onOpenRemote = { screen = Screen.Remote },
                onOpenNowPlaying = { screen = Screen.NowPlaying },
                onDelete = { book ->
                    // Stop playback if the deleted book is the one playing,
                    // then drop the file and its saved position. The library
                    // reloads and shows a "Deleted" confirmation afterwards.
                    if (PlaybackState.nowPlaying.value?.id == book.id) uiOr.stop()
                    withContext(Dispatchers.IO) { book.file.delete() }
                    PlayerPrefs.deletePos(context, book.id)
                },
            )
        }
        Screen.NowPlaying -> {
            BackHandler { screen = Screen.Library }
            NowPlayingScreen(uiOr, onOpenChapters = { screen = Screen.Chapters })
        }
        Screen.Chapters -> {
            BackHandler { screen = Screen.NowPlaying }
            ChapterScreen(uiOr)
        }
        Screen.Uploader -> {
            BackHandler { screen = Screen.Library }
            UploaderScreen()
        }
        Screen.Remote -> {
            BackHandler { screen = Screen.Library }
            RemoteScreen()
        }
    }
}
