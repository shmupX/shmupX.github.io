package com.emre.aloud.remote

import com.emre.aloud.util.Logg
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.util.UUID
import kotlin.concurrent.thread

/**
 * The wrist end of the desktop music remote: pick a song here, and the paired
 * launcher's music player switches to it.
 *
 * The two never talk directly. A Firebase Realtime Database sits between them,
 * spoken to over plain REST — no SDK, no Play Services, no companion app, and
 * the desktop needs no inbound port:
 *
 *   watch   --> /builders/<code>/music/launch    one slot, latest press wins
 *   watch   --> /builders/<code>/music/control   pause · resume · next · prev · sync
 *   desktop --> /builders/<code>/music/playing   what its player is doing
 *   desktop --> /builders/<code>/music/library   the albums it can play
 *
 * The desktop half is `static/watch-music.js` in the cmg launcher. Nothing here
 * decides that a song started: [pending] is only cleared by the desktop naming
 * the press in `playing`, and says so when nothing answers.
 *
 * One stream on the whole `music` node rather than one per child: a watch
 * radio pays for every open socket, and the node is small.
 */
class RemoteBridge(
    databaseUrl: String,
    code: String,
    private val replyDeadlineMs: Long = REPLY_DEADLINE_MS,
    private val resyncAfterMs: Long = RESYNC_AFTER_MS,
    private val now: () -> Long = System::currentTimeMillis,
) {

    enum class Connection { DISCONNECTED, CONNECTING, CONNECTED }

    private val root = "${databaseUrl.trimEnd('/')}/builders/${PairCode.normalize(code)}/music"

    private val _connection = MutableStateFlow(Connection.DISCONNECTED)
    val connection: StateFlow<Connection> = _connection.asStateFlow()

    private val _library = MutableStateFlow<List<RemoteAlbum>>(emptyList())
    val library: StateFlow<List<RemoteAlbum>> = _library.asStateFlow()

    private val _playing = MutableStateFlow(RemotePlaying())
    val playing: StateFlow<RemotePlaying> = _playing.asStateFlow()

    /**
     * Has a desktop written anything since this connection opened?
     *
     * The stream's first frame is the whole node, i.e. whatever the last
     * desktop left behind — possibly days ago. So a connection alone proves
     * nothing; this turns true only when the desktop answers the `sync` sent on
     * connect, or writes for any other reason.
     */
    private val _hostSeen = MutableStateFlow(false)
    val hostSeen: StateFlow<Boolean> = _hostSeen.asStateFlow()

    private val _pending = MutableStateFlow<PendingLaunch?>(null)
    val pending: StateFlow<PendingLaunch?> = _pending.asStateFlow()

    private var scope: CoroutineScope? = null
    private var deadline: Job? = null

    /** When the last `sync` left, on this watch's own clock. */
    @Volatile
    private var lastSyncAt = 0L

    /** The open stream, so [stop] can break a read that is blocked on it. */
    @Volatile
    private var live: HttpURLConnection? = null

    fun start() {
        if (scope != null) return
        val started = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        scope = started
        started.launch { supervise(started) }
    }

    fun stop() {
        scope?.cancel()
        scope = null
        deadline = null
        // A read blocked on the socket does not notice cancellation; closing the
        // connection is what wakes it. Off the calling thread, because closing
        // a TLS socket writes to it and this is called from the main thread.
        live?.let { conn -> thread(name = "aloud-remote-close") { runCatching { conn.disconnect() } } }
        _connection.value = Connection.DISCONNECTED
        _hostSeen.value = false
        // A press still waiting has lost the stream that would have answered it.
        _pending.update { if (it?.error == null) null else it }
    }

    /** Ask the desktop to switch to a song. */
    fun launch(albumId: String, trackId: String) {
        val running = scope ?: return
        val id = UUID.randomUUID().toString()
        _pending.value = PendingLaunch(id, albumId, trackId)
        deadline?.cancel()
        deadline = running.launch {
            val sent = put("launch", RemoteJson.launchBody(id, albumId, trackId, now()))
            if (sent) delay(replyDeadlineMs)
            _pending.update {
                if (it?.id == id && it.error == null) it.copy(error = if (sent) NO_REPLY else NOT_SENT) else it
            }
        }
    }

    /** "pause" | "resume" | "next" | "prev" | "stop" | "sync". */
    fun control(action: String) {
        scope?.launch { put("control", RemoteJson.controlBody(action, now())) }
    }

    /** Clears a failed press once the listener has seen it. */
    fun dismissError() {
        _pending.update { if (it?.error != null) null else it }
    }

    private suspend fun supervise(running: CoroutineScope) {
        var backoffMs = 1_000L
        while (running.isActive) {
            _connection.value = Connection.CONNECTING
            try {
                stream(running) { backoffMs = 1_000L }
                Logg.d("remote stream closed by server")
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                // stop() breaks the read by closing the socket; that is not a
                // failure worth a warning in a release log.
                if (running.isActive) Logg.w("remote stream failed: $e")
            }
            _hostSeen.value = false
            if (running.isActive) _connection.value = Connection.CONNECTING
            delay(backoffMs)
            backoffMs = (backoffMs * 2).coerceAtMost(30_000L)
        }
    }

    /**
     * One connection's worth of events. Returns when the server closes the
     * stream — which this database does on its own schedule, so a clean close
     * is still a disconnect — and throws when the connection breaks.
     */
    private suspend fun stream(running: CoroutineScope, onOpen: () -> Unit) {
        val conn = (URL("$root.json").openConnection() as HttpURLConnection).apply {
            setRequestProperty("Accept", "text/event-stream")
            connectTimeout = 20_000
            // The server sends a keep-alive every 30 s. Silence for much longer
            // than that is a dead connection that will never say so itself.
            readTimeout = 70_000
        }
        live = conn
        try {
            // stop() may have run before `live` was set and found nothing to close.
            currentCoroutineContext().ensureActive()
            if (conn.responseCode != HttpURLConnection.HTTP_OK) {
                throw IOException("HTTP ${conn.responseCode}")
            }
            val mirror = MusicMirror()
            var opened = false
            conn.inputStream.bufferedReader().use { reader ->
                readSse(reader) { event ->
                    when (event.type) {
                        "put", "patch" -> {
                            val spoke = try {
                                mirror.apply(event.type, JSONObject(event.data))
                            } catch (e: Exception) {
                                Logg.w("bad remote frame: $e")
                                return@readSse
                            }
                            publish(mirror)
                            if (!opened) {
                                opened = true
                                onOpen()
                                _connection.value = Connection.CONNECTED
                                // Say hello. A live desktop answers by writing
                                // its library and state, which is both the
                                // refresh and the proof that it is there.
                                sync(running)
                            } else if (spoke) {
                                val firstWord = !_hostSeen.value
                                _hostSeen.value = true
                                // A launcher switched on after the hello never
                                // heard it: it announces itself, but only a
                                // sync makes it send its albums. Not repeated
                                // for a prompt answer to the hello itself.
                                if (firstWord && now() - lastSyncAt > resyncAfterMs) sync(running)
                            }
                        }
                        "cancel", "auth_revoked" -> throw IOException("stream ${event.type}")
                    }
                }
            }
        } finally {
            live = null
            conn.disconnect()
        }
    }

    private fun sync(running: CoroutineScope) {
        lastSyncAt = now()
        running.launch { put("control", RemoteJson.controlBody("sync", now())) }
    }

    private fun publish(mirror: MusicMirror) {
        val playing = RemoteJson.parsePlaying(mirror.playing)
        _playing.value = playing
        _library.value = RemoteJson.parseLibrary(mirror.library)
        _pending.update { settle(it, playing) }
    }

    private fun put(node: String, body: String): Boolean = try {
        val conn = URL("$root/$node.json").openConnection() as HttpURLConnection
        try {
            conn.requestMethod = "PUT"
            conn.doOutput = true
            conn.connectTimeout = 15_000
            conn.readTimeout = 15_000
            conn.setRequestProperty("Content-Type", "application/json; charset=utf-8")
            conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            val ok = conn.responseCode in 200..299
            if (!ok) Logg.w("remote PUT $node -> ${conn.responseCode}")
            ok
        } finally {
            conn.disconnect()
        }
    } catch (e: IOException) {
        Logg.w("remote PUT $node failed: $e")
        false
    }

    companion object {
        /**
         * How long a press waits for the desktop before saying it got no reply.
         * Generous on purpose: a launcher whose music player is not open yet
         * has to mount it and load its albums before it can answer.
         */
        const val REPLY_DEADLINE_MS = 12_000L

        /** An answer slower than this is taken for a desktop that arrived late. */
        const val RESYNC_AFTER_MS = 3_000L
    }
}

/** The press never left the watch — no network, or the database refused it. */
internal const val NOT_SENT = "not sent"
