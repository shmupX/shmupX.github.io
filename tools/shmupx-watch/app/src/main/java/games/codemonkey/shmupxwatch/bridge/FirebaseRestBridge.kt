package games.codemonkey.shmupxwatch.bridge

import android.util.Log
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.encodeToJsonElement
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.sse.EventSource
import okhttp3.sse.EventSourceListener
import okhttp3.sse.EventSources
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit

/**
 * Talks to Firebase Realtime Database over its REST API, streaming changes with
 * `Accept: text/event-stream`.
 *
 * Why REST instead of the Firebase SDK: no google-services.json, no Play
 * Services dependency, and a much smaller APK — which matters more on a watch
 * than it does on a phone. The trade is that you write your own reconnect and
 * you lose the SDK's offline cache. Both are handled below, crudely.
 *
 * Tree this expects, matching what the daemon writes:
 *
 *   /builders/<code>/agents/<agentId>   -> AgentSnapshot
 *   /builders/<code>/preview            -> PreviewFrame
 *   /builders/<code>/playing            -> PlayingState   (desktop writes)
 *   /builders/<code>/shelves            -> ShelfCounts    (desktop writes)
 *   /builders/<code>/utterances/<push>  -> Utterance      (watch writes)
 *   /builders/<code>/commands/<agentId> -> AgentCommand   (watch writes)
 *   /builders/<code>/launch             -> LaunchRequest  (watch writes)
 *   /builders/<code>/control            -> ControlCommand (watch writes)
 *
 * `builderCode` is normalised on the way in. The code is shown to people as
 * `ABCD-EFGH` and stored everywhere else as `ABCDEFGH`; a hyphen left in here
 * builds a real, valid, wrong path that no desktop is watching, and nothing
 * fails loudly enough to notice.
 */
class FirebaseRestBridge(
    private val databaseUrl: String,
    builderCode: String,
    private val authToken: String? = null,
) : AgentBridge {

    private val builderCode: String = BuilderCode.normalize(builderCode)

    private val json = Json {
        ignoreUnknownKeys = true
        coerceInputValues = true
        encodeDefaults = true
    }

    private val client = OkHttpClient.Builder()
        // Long read timeout: an idle SSE stream is normal, not a failure.
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .connectTimeout(20, TimeUnit.SECONDS)
        .retryOnConnectionFailure(true)
        .build()

    private val _agents = MutableStateFlow<List<AgentSnapshot>>(emptyList())
    override val agents: StateFlow<List<AgentSnapshot>> = _agents.asStateFlow()

    private val _preview = MutableStateFlow<PreviewFrame?>(null)
    override val preview: StateFlow<PreviewFrame?> = _preview.asStateFlow()

    private val _connection = MutableStateFlow(ConnectionState.DISCONNECTED)
    override val connection: StateFlow<ConnectionState> = _connection.asStateFlow()

    private val _playing = MutableStateFlow(PlayingState())
    override val playing: StateFlow<PlayingState> = _playing.asStateFlow()

    private val _shelves = MutableStateFlow(ShelfCounts())
    override val shelves: StateFlow<ShelfCounts> = _shelves.asStateFlow()

    // Mutated from the supervisor coroutine and read by stop() on whatever
    // thread cancels the view model, so it is not a plain ArrayList.
    private val streams = CopyOnWriteArrayList<EventSource>()
    private var supervisor: Job? = null

    /**
     * Completed by the SSE listener when a stream ends, so the supervisor can
     * reconnect.
     *
     * This exists because the obvious loop does not work. `newEventSource` is
     * asynchronous and never throws for a network error, so nothing inside the
     * supervisor's `try` can fail once the streams are open — the backoff and
     * `closeStreams()` below it were unreachable. A stream that dropped simply
     * stopped delivering and the watch went quiet until the process died:
     * every launch ending on "NO REPLY" while the desktop happily started the
     * game.
     */
    private var dropped: CompletableDeferred<Unit>? = null

    private fun signalDropped() {
        dropped?.complete(Unit)
    }

    private fun url(path: String, suffix: String = ""): String {
        val base = databaseUrl.trimEnd('/')
        val auth = authToken?.takeIf { it.isNotBlank() }?.let { "?auth=$it" } ?: ""
        val joiner = if (auth.isEmpty()) "?" else "&"
        val extra = if (suffix.isEmpty()) "" else "$joiner$suffix"
        return "$base/builders/$builderCode/$path.json$auth$extra"
    }

    override fun start(scope: CoroutineScope) {
        if (supervisor?.isActive == true) return
        _connection.value = ConnectionState.CONNECTING

        supervisor = scope.launch(Dispatchers.IO) {
            var backoffMs = 1_000L
            while (true) {
                try {
                    val ended = CompletableDeferred<Unit>()
                    dropped = ended
                    openStream("agents") { element -> applyAgents(element) }
                    openStream("preview") { element -> applyPreview(element) }
                    openStream("playing") { element -> applyPlaying(element) }
                    openStream("shelves") { element -> applyShelves(element) }
                    _connection.value = ConnectionState.CONNECTED
                    backoffMs = 1_000L
                    // Streams are callback-driven, so park until one of them
                    // says it ended. Parking on a timer instead is what made
                    // the reconnect below dead code.
                    ended.await()
                    Log.w(TAG, "stream ended, reconnecting in ${backoffMs}ms")
                    _connection.value = ConnectionState.CONNECTING
                    closeStreams()
                    delay(backoffMs)
                    backoffMs = (backoffMs * 2).coerceAtMost(30_000L)
                } catch (e: CancellationException) {
                    // stop() is not a failure, and catching it as one would log
                    // a spurious error and flip the connection back to
                    // CONNECTING after stop() had already set DISCONNECTED.
                    throw e
                } catch (e: Exception) {
                    Log.w(TAG, "stream failed, retrying in ${backoffMs}ms", e)
                    _connection.value = ConnectionState.CONNECTING
                    closeStreams()
                    delay(backoffMs)
                    backoffMs = (backoffMs * 2).coerceAtMost(30_000L)
                }
            }
        }
    }

    private fun openStream(path: String, onData: (JsonElement) -> Unit) {
        val request = Request.Builder()
            .url(url(path))
            .header("Accept", "text/event-stream")
            .build()

        val listener = object : EventSourceListener() {
            override fun onEvent(source: EventSource, id: String?, type: String?, data: String) {
                // RTDB sends `put` (replace at path) and `patch` (merge at path).
                if (type != "put" && type != "patch") return
                runCatching {
                    val payload = json.parseToJsonElement(data).jsonObject
                    val body = payload["data"] ?: JsonNull
                    onData(body)
                }.onFailure { Log.w(TAG, "bad SSE payload on $path", it) }
            }

            override fun onFailure(source: EventSource, t: Throwable?, response: okhttp3.Response?) {
                Log.w(TAG, "SSE failure on $path: ${response?.code}", t)
                _connection.value = ConnectionState.CONNECTING
                signalDropped()
            }

            /**
             * A clean close is still a disconnect. Firebase ends a long-lived
             * REST stream on its own schedule, and without this the watch would
             * treat a perfectly ordinary server-side close as "still
             * connected" and never hear another frame.
             */
            override fun onClosed(source: EventSource) {
                Log.w(TAG, "SSE closed on $path")
                signalDropped()
            }
        }

        streams += EventSources.createFactory(client).newEventSource(request, listener)
    }

    private fun applyAgents(element: JsonElement) {
        if (element is JsonNull) {
            _agents.value = emptyList()
            return
        }
        val obj = element as? JsonObject ?: return
        val parsed = obj.mapNotNull { (id, value) ->
            runCatching {
                json.decodeFromJsonElement(AgentSnapshot.serializer(), value).copy(id = id)
            }.getOrNull()
        }
        // Blocked first: that's the only state that actually needs the wrist.
        _agents.value = parsed.sortedWith(
            compareBy({ it.state != AgentState.BLOCKED }, { it.label })
        )
    }

    private fun applyPreview(element: JsonElement) {
        if (element is JsonNull) {
            _preview.value = null
            return
        }
        runCatching {
            json.decodeFromJsonElement(PreviewFrame.serializer(), element)
        }.onSuccess { _preview.value = it }
            .onFailure { Log.w(TAG, "bad preview frame", it) }
    }

    /**
     * The desktop's answer about what is running.
     *
     * A `patch` frame carries only the changed keys, and RTDB sends one for a
     * single-field write such as a volume nudge. Decoding that as a whole
     * [PlayingState] would reset every field the patch left out — the title
     * would vanish and the state would fall back to "idle" mid-game. So a
     * partial object is merged onto what is already held.
     */
    private fun applyPlaying(element: JsonElement) {
        if (element is JsonNull) {
            _playing.value = PlayingState()
            return
        }
        val obj = element as? JsonObject ?: return
        runCatching {
            val merged = JsonObject(currentPlayingJson() + obj)
            json.decodeFromJsonElement(PlayingState.serializer(), merged)
        }.onSuccess { _playing.value = it }
            .onFailure { Log.w(TAG, "bad playing state", it) }
    }

    private fun currentPlayingJson(): Map<String, JsonElement> =
        runCatching {
            json.encodeToJsonElement(PlayingState.serializer(), _playing.value).jsonObject.toMap()
        }.getOrDefault(emptyMap())

    private fun applyShelves(element: JsonElement) {
        if (element is JsonNull) {
            _shelves.value = ShelfCounts()
            return
        }
        runCatching {
            json.decodeFromJsonElement(ShelfCounts.serializer(), element)
        }.onSuccess { _shelves.value = it }
            .onFailure { Log.w(TAG, "bad shelf counts", it) }
    }

    override suspend fun sendUtterance(utterance: Utterance) {
        post("utterances", json.encodeToString(Utterance.serializer(), utterance))
    }

    override suspend fun sendCommand(agentId: String, command: AgentCommand) {
        put("commands/$agentId", json.encodeToString(AgentCommand.serializer(), command))
    }

    /**
     * One slot, PUT rather than pushed: the newest press is the only one worth
     * acting on, and a queue of launches nobody is waiting for is a way to
     * start the wrong game a minute later.
     */
    override suspend fun sendLaunch(request: LaunchRequest) {
        // Show LAUNCHING immediately rather than waiting for the round trip.
        // The desktop's own write replaces this as soon as it answers; if it
        // never does, the launching screen is what times out and says so.
        _playing.value = PlayingState(
            state = "launching",
            id = request.id,
            gameId = request.gameId ?: request.shelfId ?: request.slug,
            kind = request.kind,
            updatedAt = System.currentTimeMillis(),
        )
        put("launch", json.encodeToString(LaunchRequest.serializer(), request))
    }

    override suspend fun sendControl(command: ControlCommand) {
        put("control", json.encodeToString(ControlCommand.serializer(), command))
    }

    private suspend fun post(path: String, body: String) = withContext(Dispatchers.IO) {
        val request = Request.Builder()
            .url(url(path))
            .post(body.toRequestBody(JSON_MEDIA))
            .build()
        client.newCall(request).execute().use { r ->
            if (!r.isSuccessful) Log.w(TAG, "POST $path -> ${r.code}")
        }
    }

    private suspend fun put(path: String, body: String) = withContext(Dispatchers.IO) {
        val request = Request.Builder()
            .url(url(path))
            .put(body.toRequestBody(JSON_MEDIA))
            .build()
        client.newCall(request).execute().use { r ->
            if (!r.isSuccessful) Log.w(TAG, "PUT $path -> ${r.code}")
        }
    }

    private fun closeStreams() {
        streams.forEach { runCatching { it.cancel() } }
        streams.clear()
    }

    override fun stop() {
        supervisor?.cancel()
        supervisor = null
        dropped = null
        closeStreams()
        _connection.value = ConnectionState.DISCONNECTED
    }

    private companion object {
        const val TAG = "ShmupxBridge"
        val JSON_MEDIA = "application/json; charset=utf-8".toMediaType()
    }
}
