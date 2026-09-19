package games.codemonkey.shmupxwatch

import android.app.Application
import android.util.Log
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import games.codemonkey.shmupxwatch.bridge.AgentBridge
import games.codemonkey.shmupxwatch.bridge.ControlCommand
import games.codemonkey.shmupxwatch.bridge.LaunchRequest
import games.codemonkey.shmupxwatch.bridge.PlayingState
import games.codemonkey.shmupxwatch.catalog.CatalogClient
import games.codemonkey.shmupxwatch.catalog.LaunchKind
import games.codemonkey.shmupxwatch.catalog.LibraryBuilder
import games.codemonkey.shmupxwatch.catalog.LibraryItem
import games.codemonkey.shmupxwatch.catalog.ShelfItem
import games.codemonkey.shmupxwatch.catalog.ShelfKind
import games.codemonkey.shmupxwatch.session.SessionService
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.launch
import java.util.UUID

/** The eight screens of the handoff, in the order its nav lists them. */
enum class Screen { TILE, LIBRARY, SHELF, DETAIL, VOICE, LAUNCHING, PLAYING, INPUT_MAP }

/**
 * What a detail screen is about: either a catalog row or one save off a shelf.
 * The design carries the same distinction in `detail.__shelf`, and it decides
 * what BACK means.
 */
data class DetailTarget(
    val title: String,
    val sub: String,
    val meta: List<String>,
    val initials: String,
    val iconUrl: String? = null,
    val item: LibraryItem? = null,
    val shelfItem: ShelfItem? = null,
    val shelfKind: ShelfKind? = null,
) {
    val isShelfSave: Boolean get() = shelfItem != null

    /** The key favourites are stored under. Titles are not unique; this is. */
    val favouriteKey: String get() = shelfItem?.slug ?: item?.id ?: title
}

/** What CONTINUE resumes. Survives a restart; the design's whole tile screen. */
data class LastPlayed(
    val title: String,
    val subtitle: String,
    val libraryId: String?,
    val shelfSlug: String?,
)

data class LauncherState(
    val screen: Screen = Screen.TILE,
    /** Index into [library]; the design's `sel`. */
    val selected: Int = 0,
    /** Index into [shelf]; the design's `shelf`. */
    val shelfIndex: Int = 0,
    val detail: DetailTarget? = null,
    /** Which screen BACK returns to. */
    val from: Screen = Screen.LIBRARY,
    val library: List<LibraryItem> = emptyList(),
    val shelf: List<ShelfItem> = emptyList(),
    val shelfKind: ShelfKind = ShelfKind.DEZAEMON,
    val favourites: Set<String> = emptySet(),
    /** What dictation heard, shown as it is confirmed. */
    val heard: String = "",
    val voiceMatch: LibraryItem? = null,
    val loading: Boolean = true,
    val loadError: String? = null,
    /** Set when a launch was sent and the desktop has not answered. */
    val pendingLaunchId: String? = null,
    /** The last thing launched from this watch — what CONTINUE resumes. */
    val lastPlayed: LastPlayed? = null,
    /**
     * Bumped every time the voice screen is opened deliberately.
     *
     * The recogniser is started by an effect, and an effect keyed on "we are on
     * the voice screen and have heard nothing" restarts whenever the composable
     * does — which on a watch is every time the screen dims and wakes. Keyed on
     * a counter instead, it fires exactly once per press.
     */
    val voiceRequest: Int = 0,
) {
    val selectedItem: LibraryItem? get() = library.getOrNull(selected)

    /**
     * The saves on the shelf currently open.
     *
     * Only the Dezaemon shelf is readable from a wrist — the other two live in
     * the launcher page's own IndexedDB. Returning the Saturn list for all
     * three would put 262 Dezaemon saves behind a row labelled
     * "PLAYSTATION 2 SHELF".
     */
    val shelfContents: List<ShelfItem>
        get() = if (shelfKind == ShelfKind.DEZAEMON) shelf else emptyList()

    val shelfItem: ShelfItem? get() = shelfContents.getOrNull(shelfIndex)
}

/**
 * The launcher's state machine.
 *
 * Deliberately separate from [SessionViewModel], which owns the agent side —
 * the two share a bridge and nothing else, and folding the launcher into it
 * would make one class that is both a game launcher and a sprite editor.
 *
 * Two things here differ from the mock on purpose, both because the mock had
 * nobody to talk to:
 *
 * - **LAUNCHING does not advance on a timer.** The design waits 1.7 s and
 *   declares the game running. Here the screen waits for the desktop to say so
 *   on `/playing`, and says what went wrong when it does not — a launcher that
 *   claims success it cannot see is worse than one that admits it lost contact.
 * - **The voice screen does not type a canned phrase.** It runs real dictation
 *   and matches what came back against the real catalog.
 */
class LauncherViewModel(
    app: Application,
    private val bridge: AgentBridge,
    private val catalog: CatalogClient,
) : AndroidViewModel(app) {

    private val favourites = app.getSharedPreferences(PREFS, Application.MODE_PRIVATE)

    /** Whether the ongoing activity is currently held. See [onPlayingChanged]. */
    private var sessionHeld = false

    private val _state = MutableStateFlow(
        LauncherState(
            favourites = favourites.getStringSet(KEY_FAVOURITES, emptySet()).orEmpty(),
            lastPlayed = readLastPlayed(),
        ),
    )
    val state: StateFlow<LauncherState> = _state.asStateFlow()

    /** What the desktop says is running. The playing screen reads this directly. */
    val playing: StateFlow<PlayingState> = bridge.playing

    init {
        refresh()
        // The desktop's answer is what moves LAUNCHING on, and what drops the
        // app back to the library when a game is closed at the other end.
        viewModelScope.launch {
            bridge.playing.collect { playingState -> onPlayingChanged(playingState) }
        }
        // The desktop can report its shelves at any point after boot — it has
        // to read its own IndexedDB first — so the library is rebuilt when it
        // does rather than only at refresh time.
        viewModelScope.launch {
            bridge.shelves.drop(1).collect { refresh() }
        }
    }

    /* ─── Catalog ────────────────────────────────────────────────────────── */

    fun refresh() {
        viewModelScope.launch {
            _state.value = _state.value.copy(loading = true, loadError = null)

            // Concurrently: the manifest is 2 KB and the shelf index is 221 KB
            // ungzipped, and in series the small one waited on the large one —
            // the library sat on "NO GAMES" for the length of the slower fetch
            // even though everything it draws had already arrived.
            val manifestAsync = async { catalog.fetchManifest(System.currentTimeMillis()) }
            val shelfAsync = async { catalog.fetchDezaShelf() }
            val manifest = manifestAsync.await()
            val shelf = shelfAsync.await()

            if (manifest == null) {
                _state.value = _state.value.copy(
                    loading = false,
                    loadError = "CATALOG UNREACHABLE",
                )
                return@launch
            }

            val library = LibraryBuilder.build(
                manifest = manifest,
                shelfCounts = buildMap {
                    // Only claim a count that was actually counted. Dezaemon we
                    // just fetched; the other two are the desktop's to report,
                    // because they live in its browser storage and nowhere a
                    // wrist can reach. Still absent means still unknown.
                    if (shelf.isNotEmpty()) put(ShelfKind.DEZAEMON, shelf.size)
                    bridge.shelves.value.snes?.let { put(ShelfKind.SNES, it) }
                    bridge.shelves.value.ps2?.let { put(ShelfKind.PS2, it) }
                },
                absolute = catalog::absolute,
            )

            _state.value = _state.value.copy(
                library = library,
                shelf = shelf,
                loading = false,
                loadError = null,
                // The design opens the library on the third row. Keep the
                // selection in range when the catalog is shorter than that.
                selected = _state.value.selected.coerceIn(0, (library.size - 1).coerceAtLeast(0)),
            )
        }
    }

    /* ─── Navigation ─────────────────────────────────────────────────────── */

    fun go(screen: Screen) {
        // The screen is the whole state machine, so its transitions are the one
        // thing worth a log line: every bug found in this file so far announced
        // itself as a screen changing when nothing had been pressed.
        Log.d(TAG, "screen ${_state.value.screen} -> $screen")
        _state.value = _state.value.copy(screen = screen)
    }

    fun toTile() = go(Screen.TILE)

    fun toLibrary() = go(Screen.LIBRARY)

    fun toInputMap() = go(Screen.INPUT_MAP)

    /**
     * BACK. A save opened off the shelf returns to the shelf; everything else
     * returns to the library — the design's `from === 'shelf' && isShelfDetail`
     * rule, which matters because the shelf is reached *through* a library row.
     */
    fun back() {
        val current = _state.value
        val target = when {
            current.screen == Screen.DETAIL && current.detail?.isShelfSave == true -> Screen.SHELF
            current.screen == Screen.SHELF -> Screen.LIBRARY
            current.screen == Screen.TILE -> Screen.TILE
            else -> Screen.LIBRARY
        }
        _state.value = current.copy(screen = target)
    }

    /** Move the selection without opening anything — what tapping a neighbour does. */
    fun select(index: Int) {
        val library = _state.value.library
        if (index !in library.indices) return
        _state.value = _state.value.copy(selected = index)
    }

    /** Open row [index]: a shelf row opens its shelf, anything else its detail. */
    fun pick(index: Int) {
        val current = _state.value
        val item = current.library.getOrNull(index) ?: return
        if (item.launch == LaunchKind.SHELF) {
            _state.value = current.copy(
                selected = index,
                screen = Screen.SHELF,
                shelfKind = item.shelf ?: ShelfKind.DEZAEMON,
                shelfIndex = 0,
            )
            return
        }
        _state.value = current.copy(
            selected = index,
            screen = Screen.DETAIL,
            from = Screen.LIBRARY,
            detail = item.toDetail(),
        )
    }

    /** Open the cover currently centred on the shelf. */
    fun openShelfItem() {
        val current = _state.value
        val save = current.shelfItem ?: return
        _state.value = current.copy(
            screen = Screen.DETAIL,
            from = Screen.SHELF,
            detail = DetailTarget(
                title = save.title,
                sub = listOfNotNull(
                    save.developer.takeIf { it.isNotBlank() },
                    "DEZAEMON 2 SAVE",
                ).joinToString(" // "),
                meta = listOfNotNull(
                    "SATURN .SAV",
                    save.genre.takeIf { it.isNotBlank() },
                    "INSTANT PLAY",
                ),
                initials = "DZ",
                shelfItem = save,
                shelfKind = current.shelfKind,
            ),
        )
    }

    private fun LibraryItem.toDetail() = DetailTarget(
        title = title,
        sub = sub,
        meta = meta,
        initials = initials,
        iconUrl = iconUrl,
        item = this,
    )

    /* ─── The crown ──────────────────────────────────────────────────────── */

    /**
     * One detent of the rotating crown, [direction] being +1 down / -1 up.
     *
     * Same dispatch as the design's `crown()`: what the crown does is a
     * property of the screen, not of the device. On the tile it opens the
     * library; on the library it moves the selection; on the shelf it scrubs
     * 262 saves; while playing it is the volume.
     */
    fun crown(direction: Int) {
        val current = _state.value
        when (current.screen) {
            Screen.SHELF -> {
                val contents = current.shelfContents
                if (contents.isEmpty()) return
                _state.value = current.copy(
                    shelfIndex = (current.shelfIndex + direction)
                        .coerceIn(0, contents.lastIndex),
                )
            }

            Screen.PLAYING -> nudgeVolume(direction)

            Screen.TILE -> if (direction > 0) go(Screen.LIBRARY)

            else -> {
                if (current.library.isEmpty()) return
                val count = current.library.size
                _state.value = current.copy(
                    screen = Screen.LIBRARY,
                    // Wraps, as the design does: a list you can fall off the
                    // end of is worse on a crown than one that comes round.
                    selected = ((current.selected + direction) % count + count) % count,
                )
            }
        }
    }

    /* ─── Launching ──────────────────────────────────────────────────────── */

    /**
     * Send the current detail to the desktop.
     *
     * The id is what makes this press distinguishable from a redelivery of it:
     * the desktop remembers ids it has acted on, because the first frame it
     * receives after reconnecting is the whole node, i.e. the last launch
     * again.
     */
    fun launch() {
        val detail = _state.value.detail ?: return
        val id = UUID.randomUUID().toString()

        val request = when {
            detail.shelfItem != null -> LaunchRequest(
                id = id,
                kind = (detail.shelfKind ?: ShelfKind.DEZAEMON).wire,
                shelfId = detail.shelfItem.slug,
                slug = detail.shelfItem.slug,
            )

            detail.item != null -> LaunchRequest(
                id = id,
                kind = detail.item.launch.wire,
                gameId = detail.item.id,
                url = detail.item.url,
            )

            else -> return
        }

        // Remembered on the press, not on success: the design's CONTINUE dial
        // is "the last thing you asked for", and a launch the desktop fumbled
        // is still the thing you want to try again.
        val remembered = LastPlayed(
            title = detail.title,
            subtitle = detail.item?.tag ?: detail.shelfKind?.label.orEmpty(),
            libraryId = detail.item?.id,
            shelfSlug = detail.shelfItem?.slug,
        )
        writeLastPlayed(remembered)

        _state.value = _state.value.copy(
            screen = Screen.LAUNCHING,
            pendingLaunchId = id,
            lastPlayed = remembered,
        )
        viewModelScope.launch { bridge.sendLaunch(request) }
    }

    /**
     * The desktop answered. This is the only thing that moves the launcher off
     * LAUNCHING, and the only thing that can drop it out of PLAYING.
     */
    private fun onPlayingChanged(playingState: PlayingState) {
        // An ongoing activity is what exempts an app from the system's
        // return-to-watch-face timeout. Without it Wear drops the launcher back
        // to the watch face after a few seconds of not being touched — which is
        // survivable while browsing, and absurd while a game you are holding the
        // transport controls for is running. So the session follows the game:
        // it starts when something is launching or playing and stops when
        // nothing is, rather than running all day for a foreground service's
        // battery cost.
        val shouldHold = playingState.isLaunching || playingState.isRunning
        if (shouldHold != sessionHeld) {
            sessionHeld = shouldHold
            val app = getApplication<Application>()
            if (shouldHold) {
                SessionService.start(app, 1, playingState.title ?: "playing")
            } else {
                SessionService.stop(app)
            }
        }

        val current = _state.value
        when {
            playingState.isRunning && current.screen == Screen.LAUNCHING ->
                _state.value = current.copy(screen = Screen.PLAYING, pendingLaunchId = null)

            // A game can be running without this watch having started it — the
            // desktop's own keyboard, or another watch. Adopt it, but only from
            // the tile: that is where the app opens, so opening it while
            // something is running lands on the controls. Doing the same from
            // the library would yank the list out from under somebody who went
            // there to pick the next game.
            playingState.isRunning && current.screen == Screen.TILE ->
                _state.value = current.copy(screen = Screen.PLAYING)

            playingState.isError && current.screen == Screen.LAUNCHING ->
                _state.value = current.copy(screen = Screen.DETAIL, pendingLaunchId = null)

            // The game was closed at the desktop, or by this watch's own STOP.
            !playingState.isRunning && !playingState.isLaunching &&
                current.screen == Screen.PLAYING ->
                _state.value = current.copy(screen = Screen.LIBRARY, pendingLaunchId = null)
        }
    }

    /** Give up on a launch the desktop never acknowledged. */
    fun cancelLaunch() {
        _state.value = _state.value.copy(screen = Screen.DETAIL, pendingLaunchId = null)
    }

    /* ─── Transport ──────────────────────────────────────────────────────── */

    fun togglePause() {
        val action = if (bridge.playing.value.isPaused) "resume" else "pause"
        viewModelScope.launch { bridge.sendControl(ControlCommand(action = action)) }
    }

    fun stop() {
        viewModelScope.launch { bridge.sendControl(ControlCommand(action = "stop")) }
        _state.value = _state.value.copy(screen = Screen.LIBRARY)
    }

    fun nudgeVolume(direction: Int) {
        val next = (bridge.playing.value.volume + direction).coerceIn(0, 10)
        if (next == bridge.playing.value.volume) return
        viewModelScope.launch {
            bridge.sendControl(ControlCommand(action = "volume", value = next))
        }
    }

    /* ─── Favourites ─────────────────────────────────────────────────────── */

    fun toggleFavourite() {
        val key = _state.value.detail?.favouriteKey ?: return
        val next = _state.value.favourites.toMutableSet().apply {
            if (!add(key)) remove(key)
        }
        // Persisted, because a star that forgets itself when the screen dims is
        // not a favourite, it is a decoration.
        favourites.edit().putStringSet(KEY_FAVOURITES, next).apply()
        _state.value = _state.value.copy(favourites = next)
    }

    fun isFavourite(key: String?): Boolean = key != null && key in _state.value.favourites

    /* ─── Last played ────────────────────────────────────────────────────── */

    private fun readLastPlayed(): LastPlayed? {
        val title = favourites.getString(KEY_LAST_TITLE, null)?.takeIf { it.isNotBlank() }
            ?: return null
        return LastPlayed(
            title = title,
            subtitle = favourites.getString(KEY_LAST_SUB, "").orEmpty(),
            libraryId = favourites.getString(KEY_LAST_ID, null),
            shelfSlug = favourites.getString(KEY_LAST_SLUG, null),
        )
    }

    private fun writeLastPlayed(value: LastPlayed) {
        favourites.edit()
            .putString(KEY_LAST_TITLE, value.title)
            .putString(KEY_LAST_SUB, value.subtitle)
            .putString(KEY_LAST_ID, value.libraryId)
            .putString(KEY_LAST_SLUG, value.shelfSlug)
            .apply()
    }

    /** CONTINUE: reopen the last thing launched, if it is still in the catalog. */
    fun resumeLast() {
        val last = _state.value.lastPlayed ?: return toLibrary()
        val index = _state.value.library.indexOfFirst { it.id == last.libraryId }
        if (index >= 0) {
            pick(index)
            return
        }
        // A shelf save, or a game that has since left the catalog. The shelf is
        // the only one we can still reopen by name.
        val slug = last.shelfSlug
        val shelfIndex = if (slug == null) -1 else _state.value.shelf.indexOfFirst { it.slug == slug }
        if (shelfIndex >= 0) {
            _state.value = _state.value.copy(screen = Screen.SHELF, shelfIndex = shelfIndex)
            openShelfItem()
            return
        }
        toLibrary()
    }

    /* ─── Voice ──────────────────────────────────────────────────────────── */

    fun startVoice() {
        Log.d(TAG, "startVoice from ${_state.value.screen}")
        _state.value = _state.value.copy(
            screen = Screen.VOICE,
            heard = "",
            voiceMatch = null,
            voiceRequest = _state.value.voiceRequest + 1,
        )
    }

    /** Dictation came back with nothing — the user backed out of the recogniser. */
    fun onDictationCancelled() {
        if (_state.value.screen != Screen.VOICE) return
        // Backing out of the recogniser means backing out of voice, not sitting
        // on a screen whose only content is a result that never arrived.
        if (_state.value.heard.isBlank()) toLibrary()
    }

    /**
     * What dictation came back with.
     *
     * Matching is deliberately forgiving in one direction only: a spoken title
     * is matched against catalog titles, and the best match has to actually
     * share words. "play zunzunkyou" finds ZUNZUNKYOU NO YABOU; "play something
     * that does not exist" finds nothing and says so, rather than launching
     * whatever sorted first.
     */
    fun onHeard(text: String) {
        val cleaned = text.trim()
        val match = matchTitle(cleaned, _state.value.library)
        _state.value = _state.value.copy(heard = cleaned.uppercase(), voiceMatch = match)
    }

    /** Accept the voice match and go to its detail screen. */
    fun acceptVoiceMatch() {
        val match = _state.value.voiceMatch ?: return
        val index = _state.value.library.indexOfFirst { it.id == match.id }
        if (index >= 0) pick(index)
    }

    override fun onCleared() {
        if (sessionHeld) {
            sessionHeld = false
            SessionService.stop(getApplication())
        }
        super.onCleared()
    }

    companion object {
        private const val TAG = "ShmupxLauncher"
        private const val PREFS = "shmupx_launcher"
        private const val KEY_FAVOURITES = "favourites"
        private const val KEY_LAST_TITLE = "last_title"
        private const val KEY_LAST_SUB = "last_sub"
        private const val KEY_LAST_ID = "last_id"
        private const val KEY_LAST_SLUG = "last_slug"

        /** Words that carry no signal in "play zunzunkyou" / "open the shelf". */
        private val STOP_WORDS = setOf("PLAY", "OPEN", "THE", "A", "START", "RUN", "LAUNCH", "GO", "TO")

        /**
         * Best catalog match for a dictated phrase, or null.
         *
         * Scores on shared words rather than on edit distance: a recogniser
         * mangles an unfamiliar proper noun's spelling but rarely loses the
         * word boundaries, and "METAMOQESTER" against "META QUESTER" should
         * still win on the prefix.
         */
        fun matchTitle(spoken: String, library: List<LibraryItem>): LibraryItem? {
            val words = spoken.uppercase()
                .split(' ', ',', '.', '-')
                .map { it.filter(Char::isLetterOrDigit) }
                .filter { it.length > 1 && it !in STOP_WORDS }
            if (words.isEmpty()) return null

            var best: LibraryItem? = null
            var bestScore = 0

            for (item in library) {
                val haystack = "${item.title} ${item.sub}".uppercase()
                var score = 0
                for (word in words) {
                    when {
                        haystack.contains(word) -> score += word.length * 2
                        // A four-character prefix is enough to tell the
                        // catalog's titles apart and survives a bad ending.
                        word.length >= 4 && haystack.contains(word.take(4)) -> score += word.length
                    }
                }
                if (score > bestScore) {
                    bestScore = score
                    best = item
                }
            }
            // Below this, the "match" is one short word in common — noise.
            return if (bestScore >= 6) best else null
        }
    }
}
