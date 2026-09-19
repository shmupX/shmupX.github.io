package games.codemonkey.shmupxwatch.bridge

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * Everything the watch needs from the desktop, behind one interface.
 *
 * Swap the implementation rather than rewriting the UI: [FakeBridge] for
 * development on the emulator, [FirebaseRestBridge] against a real database,
 * or your own over the Wearable Data Layer if you'd rather stay phone-tethered.
 */
interface AgentBridge {
    val agents: StateFlow<List<AgentSnapshot>>
    val preview: StateFlow<PreviewFrame?>
    val connection: StateFlow<ConnectionState>

    /**
     * What the desktop says is running. `idle` until something is, and the only
     * thing that moves the launcher off its LAUNCHING screen — the watch does
     * not get to decide that a game started.
     */
    val playing: StateFlow<PlayingState>

    /** Shelf sizes only the desktop can know. Empty until it says. */
    val shelves: StateFlow<ShelfCounts>

    fun start(scope: CoroutineScope)
    fun stop()

    /** Dictated text on its way to the agent. */
    suspend fun sendUtterance(utterance: Utterance)

    /** A one-tap reply to a blocked agent. */
    suspend fun sendCommand(agentId: String, command: AgentCommand)

    /** Start a game on the paired desktop. */
    suspend fun sendLaunch(request: LaunchRequest)

    /** Pause, resume, stop or set the volume of whatever is running. */
    suspend fun sendControl(command: ControlCommand)
}

/**
 * Canned data that exercises every UI state: a working agent, a blocked one
 * waiting on approval, and a sprite that redraws itself every few seconds.
 * Lets you build the whole UI before the daemon exists.
 */
class FakeBridge : AgentBridge {

    private val _agents = MutableStateFlow(
        listOf(
            AgentSnapshot(
                id = "a1",
                label = "character-preview",
                rawState = "working",
                detail = "Regenerating idle frames",
                workspace = "shmupX",
                updatedAt = System.currentTimeMillis(),
            ),
            AgentSnapshot(
                id = "a2",
                label = "level-editor",
                rawState = "blocked",
                detail = "Overwrite boss_03 in Firebase?",
                workspace = "2028.ai",
                updatedAt = System.currentTimeMillis(),
            ),
            AgentSnapshot(
                id = "a3",
                label = "build-server",
                rawState = "idle",
                detail = null,
                workspace = "shmupX",
                updatedAt = System.currentTimeMillis(),
            ),
        )
    )
    override val agents: StateFlow<List<AgentSnapshot>> = _agents.asStateFlow()

    private val _preview = MutableStateFlow<PreviewFrame?>(null)
    override val preview: StateFlow<PreviewFrame?> = _preview.asStateFlow()

    private val _connection = MutableStateFlow(ConnectionState.DEMO)
    override val connection: StateFlow<ConnectionState> = _connection.asStateFlow()

    private val _playing = MutableStateFlow(PlayingState())
    override val playing: StateFlow<PlayingState> = _playing.asStateFlow()

    // A fake desktop with a plausible pair of shelves on it.
    override val shelves: StateFlow<ShelfCounts> = MutableStateFlow(ShelfCounts(snes = 6, ps2 = 3))

    /** Kept so the fake desktop can answer a launch without an activity around. */
    private var scope: CoroutineScope? = null

    override fun start(scope: CoroutineScope) {
        this.scope = scope
        scope.launch {
            var rev = 0L
            while (true) {
                _preview.value = PreviewFrame(
                    objectId = "player_ship",
                    label = "Player ship",
                    pngBase64 = SampleSprites.next(),
                    widthPx = 16,
                    heightPx = 16,
                    revision = rev++,
                    note = "Demo sprite",
                )
                delay(4_000)
            }
        }
    }

    override fun stop() {
        scope = null
    }

    override suspend fun sendUtterance(utterance: Utterance) {
        // Echo it back as a working agent so the round trip is visible.
        _agents.value = _agents.value.map {
            if (it.id == "a1") it.copy(rawState = "working", detail = utterance.text) else it
        }
    }

    override suspend fun sendCommand(agentId: String, command: AgentCommand) {
        _agents.value = _agents.value.map {
            if (it.id == agentId) it.copy(rawState = "working", detail = "Sent: ${command.kind}") else it
        }
    }

    /**
     * Plays the desktop's part, so the launcher's LAUNCHING → NOW PLAYING path
     * can be walked on an emulator with no database and no desktop. The delay
     * is a stand-in for a real hand-off, not a design constant.
     */
    override suspend fun sendLaunch(request: LaunchRequest) {
        _playing.value = PlayingState(
            state = "launching",
            id = request.id,
            gameId = request.gameId ?: request.shelfId ?: request.slug,
            kind = request.kind,
            // Deliberately no title: the real desktop sends a display title,
            // and echoing the id here would put "shmupx" on a screen whose
            // caller already knows it as "SHMUPX".
            updatedAt = System.currentTimeMillis(),
        )
        scope?.launch {
            delay(1_700)
            // Only answer if this launch is still the current one; a second
            // press while the first was in flight must not be overwritten by
            // the first one's late "playing".
            if (_playing.value.id != request.id) return@launch
            _playing.value = _playing.value.copy(
                state = "playing",
                startedAt = System.currentTimeMillis(),
                updatedAt = System.currentTimeMillis(),
            )
        }
    }

    override suspend fun sendControl(command: ControlCommand) {
        val current = _playing.value
        _playing.value = when (command.action) {
            "pause" -> current.copy(state = "paused")
            "resume" -> current.copy(state = "playing")
            "stop" -> PlayingState(state = "idle")
            "volume" -> current.copy(volume = (command.value ?: current.volume).coerceIn(0, 10))
            else -> current
        }.copy(updatedAt = System.currentTimeMillis())
    }
}
