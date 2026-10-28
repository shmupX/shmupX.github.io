package com.emre.aloud.remote

import io.ktor.http.ContentType
import io.ktor.server.application.Application
import io.ktor.server.cio.CIO
import io.ktor.server.engine.EmbeddedServer
import io.ktor.server.engine.embeddedServer
import io.ktor.server.request.receiveText
import io.ktor.server.response.respondText
import io.ktor.server.response.respondTextWriter
import io.ktor.server.routing.get
import io.ktor.server.routing.put
import io.ktor.server.routing.routing
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The bridge against a stand-in for the Realtime Database: a real HTTP server
 * that streams events on GET and records PUTs, so the reconnect loop and the
 * press-and-wait-for-an-answer path are exercised end to end without a watch,
 * a desktop or a network.
 */
class RemoteBridgeTest {

    /** `event` to stream next, or [CLOSE] to end the stream the way the real
     *  database does on its own schedule. */
    private class FakeDatabase {
        val frames = Channel<String>(Channel.UNLIMITED)
        val puts = Channel<Pair<String, JSONObject>>(Channel.UNLIMITED)
        var streamsOpened = 0
            private set

        private val server: EmbeddedServer<*, *> = embeddedServer(CIO, port = 0, host = "127.0.0.1") { routes() }
        lateinit var url: String
            private set

        private fun Application.routes() = routing {
            get("/builders/ABCDEFGH/music.json") {
                streamsOpened++
                call.respondTextWriter(ContentType.Text.EventStream) {
                    for (frame in frames) {
                        if (frame == CLOSE) break
                        write(frame)
                        flush()
                    }
                }
            }
            for (node in listOf("launch", "control")) {
                put("/builders/ABCDEFGH/music/$node.json") {
                    val body = call.receiveText()
                    puts.send(node to JSONObject(body))
                    call.respondText(body, ContentType.Application.Json)
                }
            }
        }

        fun start() = apply {
            server.start(wait = false)
            url = "http://127.0.0.1:" + runBlocking { server.engine.resolvedConnectors().first().port }
        }

        fun stop() = server.stop(100, 500)

        fun send(type: String, path: String, data: String) {
            frames.trySend("event: $type\ndata: {\"path\":\"$path\",\"data\":$data}\n\n")
        }

        suspend fun nextPut(): Pair<String, JSONObject> = withTimeout(WAIT_MS) { puts.receive() }
    }

    private val db = FakeDatabase().start()
    private var bridge: RemoteBridge? = null

    private fun bridge(replyDeadlineMs: Long = WAIT_MS, resyncAfterMs: Long = WAIT_MS): RemoteBridge =
        RemoteBridge(db.url, "abcd-efgh", replyDeadlineMs, resyncAfterMs).also {
            bridge = it
            it.start()
        }

    @After
    fun tearDown() {
        bridge?.stop()
        db.stop()
    }

    private val snapshot =
        """{"playing":{"state":"playing","track":"old","title":"Left behind"},""" +
            """"library":{"albums":[{"id":"demo","title":"Demo","tracks":[{"id":"t1","title":"One"},{"id":"t2","title":"Two"}]}]}}"""

    /** Connects, and consumes the `sync` every connection opens with. */
    private suspend fun connected(bridge: RemoteBridge) {
        db.send("put", "/", snapshot)
        withTimeout(WAIT_MS) { bridge.connection.first { it == RemoteBridge.Connection.CONNECTED } }
        val (node, body) = db.nextPut()
        assertEquals("control", node)
        assertEquals("sync", body.getString("action"))
    }

    @Test
    fun `a snapshot alone does not prove a desktop is there`() = runBlocking {
        val bridge = bridge()
        connected(bridge)

        // The library left in the database is shown, but nothing has spoken.
        assertEquals(listOf("One", "Two"), bridge.library.value.single().tracks.map { it.title })
        assertFalse(bridge.hostSeen.value)

        // The desktop answers the sync.
        db.send("put", "/playing", """{"state":"idle","updated_at":5}""")
        withTimeout(WAIT_MS) { bridge.hostSeen.first { it } }
        assertEquals("idle", bridge.playing.value.state)
    }

    @Test
    fun `a desktop that turns up late is greeted again`() = runBlocking {
        // The hello went out to nobody; the launcher is switched on afterwards
        // and announces itself. Only a second sync gets its albums.
        val bridge = bridge(resyncAfterMs = 0)
        connected(bridge)

        db.send("put", "/playing", """{"state":"idle","updated_at":9}""")
        val (node, body) = db.nextPut()
        assertEquals("control", node)
        assertEquals("sync", body.getString("action"))

        // Its answer to that is not another reason to ask.
        db.send("put", "/playing", """{"state":"idle","updated_at":10}""")
        bridge.control("pause")
        assertEquals("pause", db.nextPut().second.getString("action"))
    }

    @Test
    fun `a press is settled by the desktop naming it`() = runBlocking {
        val bridge = bridge()
        connected(bridge)

        bridge.launch("demo", "t2")
        val (node, body) = db.nextPut()
        assertEquals("launch", node)
        assertEquals("demo", body.getString("album"))
        assertEquals("t2", body.getString("track"))
        assertEquals("t2", bridge.pending.value?.trackId)

        // Somebody pausing the old song is not an answer to this press.
        db.send("patch", "/playing", """{"state":"paused"}""")
        withTimeout(WAIT_MS) { bridge.playing.first { it.isPaused } }
        assertNotNull(bridge.pending.value)

        db.send(
            "put",
            "/playing",
            """{"state":"playing","id":"${body.getString("id")}","album":"demo","track":"t2","title":"Two"}""",
        )
        withTimeout(WAIT_MS) { bridge.pending.first { it == null } }
        assertEquals("Two", bridge.playing.value.title)
    }

    @Test
    fun `a press nobody answers says so`() = runBlocking {
        val bridge = bridge(replyDeadlineMs = 200)
        connected(bridge)

        bridge.launch("demo", "t1")
        db.nextPut()
        val failed = withTimeout(WAIT_MS) { bridge.pending.first { it?.error != null } }
        assertEquals(NO_REPLY, failed?.error)

        bridge.dismissError()
        assertNull(bridge.pending.value)
    }

    @Test
    fun `a press the desktop refuses carries its reason`() = runBlocking {
        val bridge = bridge()
        connected(bridge)

        bridge.launch("demo", "gone")
        val (_, body) = db.nextPut()
        db.send(
            "put",
            "/playing",
            """{"state":"idle","failed_id":"${body.getString("id")}","detail":"not in library"}""",
        )
        val failed = withTimeout(WAIT_MS) { bridge.pending.first { it?.error != null } }
        assertEquals("not in library", failed?.error)
    }

    @Test
    fun `transport controls are written to the control slot`() = runBlocking {
        val bridge = bridge()
        connected(bridge)

        bridge.control("next")
        val (node, body) = db.nextPut()
        assertEquals("control", node)
        assertEquals("next", body.getString("action"))
        assertTrue(body.getLong("created_at") > 0)
    }

    @Test
    fun `a stream the server closes is reopened and greeted again`() = runBlocking {
        val bridge = bridge()
        connected(bridge)
        db.send("put", "/playing", """{"state":"idle"}""")
        withTimeout(WAIT_MS) { bridge.hostSeen.first { it } }

        db.frames.trySend(CLOSE)
        // A closed stream is a disconnect: what the desktop said before it no
        // longer proves anything about now.
        withTimeout(WAIT_MS) { bridge.hostSeen.first { !it } }

        connected(bridge)
        assertEquals(2, db.streamsOpened)
    }

    @Test
    fun `stopping forgets a press that can no longer be answered`() = runBlocking {
        val bridge = bridge()
        connected(bridge)
        bridge.launch("demo", "t1")
        db.nextPut()

        bridge.stop()
        assertEquals(RemoteBridge.Connection.DISCONNECTED, bridge.connection.value)
        assertNull(bridge.pending.value)
    }

    private companion object {
        const val WAIT_MS = 10_000L
        const val CLOSE = "\u0000close"
    }
}
