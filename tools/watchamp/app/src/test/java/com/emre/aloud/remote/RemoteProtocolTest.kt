package com.emre.aloud.remote

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The remote's pure half: the pairing code, the wire format and the mirror of
 *  the database node. None of it needs a network. */
class RemoteProtocolTest {

    // ── Pairing code ─────────────────────────────────────────────────────────

    @Test
    fun `the displayed form and the stored form are the same code`() {
        assertEquals("ABCDEFGH", PairCode.normalize("abcd-efgh"))
        assertEquals("ABCDEFGH", PairCode.normalize(" ABCD EFGH "))
        assertEquals("ABCD-EFGH", PairCode.format("abcdefgh"))
    }

    @Test
    fun `codes with misreadable characters or the wrong length are rejected`() {
        assertTrue(PairCode.isValid("ABCD-EFGH"))
        assertTrue(PairCode.isValid("2345WXYZ"))
        assertFalse(PairCode.isValid("ABCDEFG"))
        assertFalse(PairCode.isValid("ABCDEFGHJ"))
        // I, O, 0 and 1 are not in the alphabet.
        assertFalse(PairCode.isValid("ABCDEFGI"))
        assertFalse(PairCode.isValid("ABCDEFG0"))
        assertFalse(PairCode.isValid(""))
        assertFalse(PairCode.isValid(null))
    }

    @Test
    fun `a typed code wins over the build default and an unpair sticks`() {
        assertEquals("ABCDEFGH", PairCode.resolve(null, "abcd-efgh"))
        assertEquals("JKLMNPQR", PairCode.resolve("JKLMNPQR", "ABCDEFGH"))
        assertEquals("", PairCode.resolve("", "ABCDEFGH"))
        assertEquals("", PairCode.resolve(null, ""))
        assertEquals("", PairCode.resolve(null, "not a code"))
    }

    // ── Server-sent events ───────────────────────────────────────────────────

    private fun events(stream: String): List<SseEvent> {
        val out = mutableListOf<SseEvent>()
        readSse(stream.reader().buffered()) { out += it }
        return out
    }

    @Test
    fun `events are split on blank lines and keep-alives carry no data`() {
        val got = events(
            "event: put\ndata: {\"path\":\"/\",\"data\":null}\n\n" +
                "event: keep-alive\ndata: null\n\n" +
                ": a comment\n\n" +
                "event: patch\ndata: {\"path\":\"/playing\",\"data\":{\"state\":\"paused\"}}\n\n",
        )
        assertEquals(listOf("put", "keep-alive", "patch"), got.map { it.type })
        assertEquals("{\"path\":\"/\",\"data\":null}", got[0].data)
    }

    @Test
    fun `an event cut off by the stream ending is not delivered`() {
        assertEquals(emptyList<SseEvent>(), events("event: put\ndata: {\"path\":\"/\""))
    }

    // ── The mirror of the music node ─────────────────────────────────────────

    private fun MusicMirror.frame(type: String, json: String) = apply(type, JSONObject(json))

    @Test
    fun `the opening snapshot fills the mirror but is not the desktop speaking`() {
        val mirror = MusicMirror()
        val spoke = mirror.frame(
            "put",
            """{"path":"/","data":{"playing":{"state":"playing","track":"t1"},"library":{"albums":[]},"launch":{"id":"x"}}}""",
        )
        assertFalse(spoke)
        assertEquals("playing", RemoteJson.parsePlaying(mirror.playing).state)
        assertTrue(mirror.library != null)
    }

    @Test
    fun `a write to playing or library is the desktop speaking`() {
        val mirror = MusicMirror()
        assertTrue(mirror.frame("put", """{"path":"/playing","data":{"state":"paused"}}"""))
        assertTrue(mirror.frame("put", """{"path":"/library","data":{"albums":[]}}"""))
    }

    @Test
    fun `the watch's own launch and control coming back are ignored`() {
        val mirror = MusicMirror()
        assertFalse(mirror.frame("put", """{"path":"/launch","data":{"id":"x"}}"""))
        assertFalse(mirror.frame("put", """{"path":"/control","data":{"action":"sync"}}"""))
        assertNull(mirror.playing)
    }

    @Test
    fun `a patch merges onto the held record instead of replacing it`() {
        val mirror = MusicMirror()
        mirror.frame("put", """{"path":"/playing","data":{"state":"playing","title":"Red Beam","track":"t2"}}""")
        mirror.frame("patch", """{"path":"/playing","data":{"state":"paused"}}""")
        val playing = RemoteJson.parsePlaying(mirror.playing)
        assertEquals("paused", playing.state)
        assertEquals("Red Beam", playing.title)
    }

    @Test
    fun `a single field written on its own lands on that field`() {
        val mirror = MusicMirror()
        mirror.frame("put", """{"path":"/playing","data":{"state":"playing","title":"Red Beam"}}""")
        mirror.frame("put", """{"path":"/playing/state","data":"paused"}""")
        mirror.frame("put", """{"path":"/playing/title","data":null}""")
        val playing = RemoteJson.parsePlaying(mirror.playing)
        assertEquals("paused", playing.state)
        assertNull(playing.title)
    }

    @Test
    fun `a deleted node empties the mirror`() {
        val mirror = MusicMirror()
        mirror.frame("put", """{"path":"/","data":{"playing":{"state":"playing"}}}""")
        mirror.frame("put", """{"path":"/","data":null}""")
        assertNull(mirror.playing)
        assertEquals("idle", RemoteJson.parsePlaying(mirror.playing).state)
    }

    // ── The wire format ──────────────────────────────────────────────────────

    @Test
    fun `the library is read as albums of tracks`() {
        val albums = RemoteJson.parseLibrary(
            JSONObject(
                """{"albums":[{"id":"demo","title":"AZ Legend Demo","tracks":[
                   {"id":"1._Hold_You_Down","title":"1. Hold You Down"},{"id":"2._Red_Beam"}]}]}""",
            ),
        )
        assertEquals(1, albums.size)
        assertEquals("AZ Legend Demo", albums[0].title)
        assertEquals(listOf("1. Hold You Down", "2._Red_Beam"), albums[0].tracks.map { it.title })
    }

    @Test
    fun `duplicate ids are dropped, because they would crash the list`() {
        val albums = RemoteJson.parseLibrary(
            JSONObject(
                """{"albums":[{"id":"a","tracks":[{"id":"t"},{"id":"t"},{"id":"u"}]},{"id":"a","tracks":[]}]}""",
            ),
        )
        assertEquals(listOf("a"), albums.map { it.id })
        assertEquals(listOf("t", "u"), albums[0].tracks.map { it.id })
    }

    @Test
    fun `a sparse list arrives as an object keyed by index`() {
        val albums = RemoteJson.parseLibrary(
            JSONObject("""{"albums":{"2":{"id":"c"},"0":{"id":"a"},"10":{"id":"k"}}}"""),
        )
        assertEquals(listOf("a", "c", "k"), albums.map { it.id })
    }

    @Test
    fun `junk in the library is survived rather than trusted`() {
        assertEquals(emptyList<RemoteAlbum>(), RemoteJson.parseLibrary(null))
        assertEquals(emptyList<RemoteAlbum>(), RemoteJson.parseLibrary(JSONObject("""{"albums":"nope"}""")))
        val albums = RemoteJson.parseLibrary(
            JSONObject("""{"albums":[null,7,{"title":"no id"},{"id":{"nested":1}},{"id":3,"tracks":"x"}]}"""),
        )
        assertEquals(listOf("3"), albums.map { it.id })
        assertEquals(emptyList<RemoteTrack>(), albums[0].tracks)
    }

    @Test
    fun `titles are cut to fit but an id is never shortened`() {
        val longId = "x".repeat(300)
        val albums = RemoteJson.parseLibrary(
            JSONObject().put(
                "albums",
                org.json.JSONArray().put(JSONObject().put("id", longId).put("title", "t".repeat(300))),
            ),
        )
        assertEquals(longId, albums[0].id)
        assertEquals(RemoteJson.MAX_TEXT, albums[0].title.length)
    }

    @Test
    fun `a launch names the song and can be told from a redelivery`() {
        val body = JSONObject(RemoteJson.launchBody("press-1", "demo", "2._Red_Beam", 1234L))
        assertEquals("press-1", body.getString("id"))
        assertEquals("demo", body.getString("album"))
        assertEquals("2._Red_Beam", body.getString("track"))
        assertEquals(1234L, body.getLong("created_at"))
        assertEquals("watch", body.getString("source"))
    }

    // ── Settling a press ─────────────────────────────────────────────────────

    private val press = PendingLaunch("press-1", "demo", "t2")

    @Test
    fun `only a record naming the press settles it`() {
        assertEquals(press, settle(press, RemotePlaying(state = "playing", launchId = "someone-else")))
        assertEquals(press, settle(press, RemotePlaying(state = "paused")))
        assertNull(settle(press, RemotePlaying(state = "playing", launchId = "press-1")))
        assertNull(settle(null, RemotePlaying(state = "playing", launchId = "press-1")))
    }

    @Test
    fun `a refusal fails the press without touching what is playing`() {
        val playing = RemoteJson.parsePlaying(
            JSONObject("""{"state":"playing","track":"t1","title":"Hold You Down","failed_id":"press-1","detail":"not in library"}"""),
        )
        assertEquals("not in library", settle(press, playing)?.error)
        assertTrue(playing.hasTrack)
        assertEquals("Hold You Down", playing.title)
    }

    @Test
    fun `a press that already failed stays failed`() {
        val failed = press.copy(error = NO_REPLY)
        assertEquals(failed, settle(failed, RemotePlaying(state = "playing", launchId = "press-1")))
    }
}
