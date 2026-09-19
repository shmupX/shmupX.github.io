package games.codemonkey.shmupxwatch.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import games.codemonkey.shmupxwatch.LauncherViewModel
import games.codemonkey.shmupxwatch.Screen
import games.codemonkey.shmupxwatch.ambient.LocalAmbientState
import games.codemonkey.shmupxwatch.bridge.ConnectionState
import games.codemonkey.shmupxwatch.catalog.CatalogClient
import games.codemonkey.shmupxwatch.ui.screens.DetailScreen
import games.codemonkey.shmupxwatch.ui.screens.InputMapScreen
import games.codemonkey.shmupxwatch.ui.screens.LaunchingScreen
import games.codemonkey.shmupxwatch.ui.screens.LibraryScreen
import games.codemonkey.shmupxwatch.ui.screens.PlayingScreen
import games.codemonkey.shmupxwatch.ui.screens.ShelfScreen
import games.codemonkey.shmupxwatch.ui.screens.TileScreen
import games.codemonkey.shmupxwatch.ui.screens.VoiceScreen
import games.codemonkey.shmupxwatch.voice.rememberDictation

/**
 * The launcher: eight screens over one state machine.
 *
 * Screen choice lives in [LauncherViewModel] rather than in a nav back stack,
 * because most of the transitions here are not navigations — LAUNCHING becomes
 * PLAYING because the desktop said so, and PLAYING becomes LIBRARY because
 * somebody closed the game at the other end. A back stack would have to be
 * rewritten from the outside on every one of those, and the two would drift.
 * Back is handled explicitly instead, which is the one thing a back stack was
 * going to give us.
 */
@Composable
fun LauncherApp(
    viewModel: LauncherViewModel,
    client: CatalogClient,
    connection: ConnectionState,
    hostLabel: String,
    onOpenAgents: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val playing by viewModel.playing.collectAsStateWithLifecycle()
    val ambient = LocalAmbientState.current

    // Dictation is a separate activity, so "listening" is really "we handed
    // off and have not been called back yet".
    var listening by remember { mutableStateOf(false) }
    val dictate = rememberDictation(
        prompt = "Say what to play",
        onCancelled = {
            listening = false
            viewModel.onDictationCancelled()
        },
    ) { heard ->
        listening = false
        viewModel.onHeard(heard)
    }

    // Opening the voice screen starts the recogniser straight away: the screen
    // exists to hold the result, not to ask permission to begin.
    //
    // Keyed on the request counter, NOT on the screen. Keyed on the screen this
    // re-fires every time the effect restarts — which happens whenever the watch
    // dims and wakes, because ambient swaps the whole composable out. With a
    // cancelled dictation leaving `heard` blank, that was an endless loop of the
    // recogniser reopening itself.
    LaunchedEffect(state.voiceRequest) {
        if (state.voiceRequest > 0 && state.screen == Screen.VOICE) {
            listening = true
            dictate()
        }
    }

    // Back, screen by screen. On the tile there is nothing left to pop, so the
    // handler stands down and the system's swipe-to-dismiss leaves the app.
    BackHandler(enabled = state.screen != Screen.TILE) {
        when (state.screen) {
            Screen.LIBRARY -> viewModel.toTile()
            Screen.LAUNCHING -> viewModel.cancelLaunch()
            Screen.VOICE -> viewModel.toLibrary()
            Screen.INPUT_MAP -> viewModel.toTile()
            else -> viewModel.back()
        }
    }

    WatchFace(modifier = modifier.fillMaxSize()) {
        Box(
            Modifier
                .fillMaxSize()
                // The crown. Lists that scroll (detail, input map) get it from
                // the list itself, so it is disabled there to avoid two things
                // claiming focus and neither getting it.
                .crownDetents(
                    enabled = state.screen in CROWN_SCREENS && !ambient.isAmbient,
                    onDetent = viewModel::crown,
                ),
        ) {
            when (state.screen) {
                Screen.TILE -> TileScreen(
                    connection = connection,
                    hostLabel = hostLabel,
                    lastTitle = state.lastPlayed?.title,
                    lastSub = state.lastPlayed?.subtitle.orEmpty(),
                    onResume = viewModel::resumeLast,
                    onLibrary = viewModel::toLibrary,
                    onVoice = viewModel::startVoice,
                    onShelf = {
                        val shelfIndex = state.library.indexOfFirst { it.shelf != null }
                        if (shelfIndex >= 0) viewModel.pick(shelfIndex) else viewModel.toLibrary()
                    },
                    onShowInputMap = viewModel::toInputMap,
                )

                Screen.LIBRARY -> LibraryScreen(
                    items = state.library,
                    selected = state.selected,
                    kindLabel = state.loadError ?: state.selectedItem?.kindLabel.orEmpty(),
                    totalCount = state.library.size + state.shelf.size,
                    client = client,
                    onSelect = viewModel::select,
                    onOpen = viewModel::pick,
                    onVoice = viewModel::startVoice,
                )

                Screen.SHELF -> ShelfScreen(
                    kind = state.shelfKind,
                    items = state.shelfContents,
                    index = state.shelfIndex,
                    onOpen = viewModel::openShelfItem,
                )

                Screen.DETAIL -> state.detail?.let { detail ->
                    DetailScreen(
                        detail = detail,
                        isFavourite = viewModel.isFavourite(detail.favouriteKey),
                        client = client,
                        onLaunch = viewModel::launch,
                        onToggleFavourite = viewModel::toggleFavourite,
                    )
                }

                Screen.VOICE -> VoiceScreen(
                    heard = state.heard,
                    match = state.voiceMatch,
                    listening = listening,
                    onAccept = viewModel::acceptVoiceMatch,
                    onRetry = viewModel::startVoice,
                    onCancel = viewModel::toLibrary,
                )

                Screen.LAUNCHING -> LaunchingScreen(
                    title = state.detail?.title.orEmpty(),
                    detail = playing.detail,
                    onCancel = viewModel::cancelLaunch,
                )

                Screen.PLAYING -> {
                    // A game adopted from the desktop — started at its keyboard,
                    // or still running from before this app was opened — has no
                    // local detail to draw from, so the row is found by the id
                    // the desktop reported. Without this it shows a placeholder
                    // monogram for a game the library knows perfectly well.
                    val row = state.detail?.item
                        ?: state.library.firstOrNull { it.id == playing.gameId }

                    PlayingScreen(
                    title = playing.title ?: row?.title ?: state.lastPlayed?.title.orEmpty(),
                    iconUrl = state.detail?.iconUrl ?: row?.iconUrl,
                    initials = state.detail?.initials ?: row?.initials ?: "··",
                    clock = if (playing.isPaused) "PAUSED" else "RUNNING",
                    volume = playing.volume,
                    paused = playing.isPaused,
                    client = client,
                    onLibrary = viewModel::toLibrary,
                    onTogglePause = viewModel::togglePause,
                    onStop = viewModel::stop,
                    )
                }

                Screen.INPUT_MAP -> InputMapScreen(
                    onDone = viewModel::toTile,
                    onOpenAgents = onOpenAgents,
                )
            }
        }
    }
}

/**
 * Screens where the crown changes a value rather than scrolling a list.
 *
 * DETAIL and INPUT_MAP are absent on purpose: both are `ScalingLazyColumn`s,
 * which already take the crown and wire their own focus. Adding a second
 * claimant means one of them gets focus and the other silently does nothing.
 */
private val CROWN_SCREENS = setOf(
    Screen.TILE,
    Screen.LIBRARY,
    Screen.SHELF,
    Screen.PLAYING,
)
