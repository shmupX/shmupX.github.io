package com.emre.aloud.upload

import com.emre.aloud.books.Book
import io.ktor.client.request.delete
import io.ktor.client.request.get
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsText
import io.ktor.http.HttpStatusCode
import io.ktor.server.testing.testApplication
import kotlinx.coroutines.delay
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** The uploader's contract, exercised without a watch: PIN enforcement,
 *  offset/space validation, chunked writes, name rules and cleanup. */
class UploadServerTest {

    private val pin = "123456"

    private class FakeStore(override val dir: File) : UploadStore {
        val deletedPositions = mutableListOf<String>()
        var freeBytesValue = Long.MAX_VALUE

        override fun list(): List<Book> =
            dir.listFiles { f -> f.isFile && !f.name.endsWith(".part") }
                .orEmpty()
                .filter { it.name.endsWith(".mp3") || it.name.endsWith(".m4b") }
                .map { Book(id = it.name, title = it.nameWithoutExtension, file = it) }

        override suspend fun deletePosition(name: String) {
            deletedPositions += name
        }

        override fun freeBytes(): Long = freeBytesValue
    }

    // testApplication cannot create a temp dir inside the lambda easily; build one here.
    private fun withServer(
        store: FakeStore,
        state: UploadState = UploadState(),
        pin: String = this.pin,
        block: suspend io.ktor.server.testing.ApplicationTestBuilder.(UploadState, FakeStore) -> Unit,
    ) = testApplication {
        application { uploadRoutes(store, state, pin, onAutoStop = { }) }
        block(state, store)
    }

    private fun newStore(): FakeStore {
        val dir = File.createTempFile("wb-upload", "").apply { delete(); mkdirs() }
        return FakeStore(dir)
    }

    @Test
    fun `mutating endpoints require the PIN`() = withServer(newStore()) { _, _ ->
        assertEquals(HttpStatusCode.Unauthorized, client.post("/book?name=a.m4b").status)
        assertEquals(HttpStatusCode.Unauthorized, client.get("/books").status)
        assertEquals(HttpStatusCode.Unauthorized, client.delete("/book?name=a.m4b").status)
    }

    @Test
    fun `a wrong PIN is rejected and does not count as activity`() = withServer(newStore()) { state, _ ->
        for (i in 1..3) {
            val r = client.post("/book?name=a.m4b&pin=000000&offset=0&total=10") { setBody(ByteArray(4)) }
            assertEquals(HttpStatusCode.Unauthorized, r.status)
        }
        // Wrong access must not keep the idle timer alive: the server's
        // lastActivityMs is only bumped by *successful* operations.
        delay(50)
        assertTrue(state.lastActivityMs < System.currentTimeMillis())
    }

    @Test
    fun `20 wrong PINs trip the lockout`() {
        var autoStopped = false
        val store = newStore()
        val state = UploadState()
        testApplication {
            application { uploadRoutes(store, state, pin, onAutoStop = { autoStopped = true }) }
            repeat(20) {
                assertEquals(HttpStatusCode.Unauthorized, client.post("/book?name=a.m4b&pin=000000").status)
            }
            delay(500) // the lockout fires after a short flush delay
        }
        assertTrue(autoStopped)
    }

    @Test
    fun `a chunked upload lands as one file`() = withServer(newStore()) { _, store ->
        val body = "hello world".toByteArray()
        val r1 = client.post("/book?name=book.m4b&pin=$pin&offset=0&total=${body.size}") {
            setBody(body.copyOf(5))
        }
        assertEquals(HttpStatusCode.OK, r1.status)
        // second chunk completes the file
        val r2 = client.post("/book?name=book.m4b&pin=$pin&offset=5&total=${body.size}") {
            setBody(body.copyOfRange(5, body.size))
        }
        assertEquals(HttpStatusCode.OK, r2.status)
        assertTrue(r2.bodyAsText().contains("\"complete\":true"))
        val final = File(store.dir, "book.m4b")
        assertEquals("hello world", final.readText())
        assertFalse(File(store.dir, "book.m4b.part").exists())
        // and it is listed
        val list = client.get("/books?pin=$pin")
        assertEquals(HttpStatusCode.OK, list.status)
        assertTrue(list.bodyAsText().contains("book.m4b"))
    }

    @Test
    fun `offsets outside the received range are refused`() = withServer(newStore()) { _, _ ->
        val r = client.post("/book?name=book.m4b&pin=$pin&offset=100&total=1000") { setBody(ByteArray(4)) }
        assertEquals(HttpStatusCode.BadRequest, r.status)
        val r2 = client.post("/book?name=book.m4b&pin=$pin&offset=-1&total=1000") { setBody(ByteArray(4)) }
        assertEquals(HttpStatusCode.BadRequest, r2.status)
    }

    @Test
    fun `an oversized chunk is refused`() = withServer(newStore()) { _, _ ->
        val r = client.post("/book?name=book.m4b&pin=$pin&offset=0&total=100") {
            setBody(ByteArray(5 * 1024 * 1024))
        }
        assertEquals(HttpStatusCode.PayloadTooLarge, r.status)
    }

    @Test
    fun `a first chunk that would not fit is refused`() = withServer(newStore().apply { freeBytesValue = 100 }) { _, _ ->
        val r = client.post("/book?name=book.m4b&pin=$pin&offset=0&total=1000") { setBody(ByteArray(4)) }
        assertEquals(HttpStatusCode.InsufficientStorage, r.status)
    }

    @Test
    fun `name rules reject separators and dot-segments but keep unicode`() = withServer(newStore()) { _, _ ->
        val bad = listOf("../evil.m4b", "a/b.m4b", "a\\b.m4b", "x\"y.m4b", ".hidden.m4b", "book.m4b.part", "book.exe")
        for (name in bad) {
            val r = client.post("/book?name=$name&pin=$pin&offset=0&total=10") { setBody(ByteArray(1)) }
            assertEquals("name $name", HttpStatusCode.BadRequest, r.status)
        }
        val ok = client.post("/book?name=Björn läser.m4b&pin=$pin&offset=0&total=10") { setBody(ByteArray(1)) }
        assertEquals(HttpStatusCode.OK, ok.status)
    }

    @Test
    fun `delete book removes the file and the saved position`() = withServer(newStore()) { _, store ->
        File(store.dir, "book.m4b").writeBytes(ByteArray(8))
        File(store.dir, "book.m4b.part").writeBytes(ByteArray(4))
        val r = client.delete("/book?name=book.m4b&pin=$pin")
        assertEquals(HttpStatusCode.OK, r.status)
        assertFalse(File(store.dir, "book.m4b").exists())
        assertFalse(File(store.dir, "book.m4b.part").exists())
        assertEquals(listOf("book.m4b"), store.deletedPositions)
    }

    @Test
    fun `delete part only drops the partial upload`() = withServer(newStore()) { _, store ->
        File(store.dir, "book.m4b").writeBytes(ByteArray(8))
        File(store.dir, "book.m4b.part").writeBytes(ByteArray(4))
        val r = client.delete("/part?name=book.m4b&pin=$pin")
        assertEquals(HttpStatusCode.OK, r.status)
        assertTrue(File(store.dir, "book.m4b").exists())
        assertFalse(File(store.dir, "book.m4b.part").exists())
        assertTrue(store.deletedPositions.isEmpty())
    }

    /** Without a declared total the free-space check was skipped entirely and
     *  a caller could append chunks to a .part until the watch filled up. */
    @Test
    fun `an upload without a declared total is refused`() = withServer(newStore()) { _, store ->
        for (query in listOf("", "&total=0", "&total=-1", "&total=abc")) {
            val r = client.post("/book?name=book.m4b&pin=$pin&offset=0$query") {
                setBody(ByteArray(4))
            }
            assertEquals("total '$query'", HttpStatusCode.BadRequest, r.status)
        }
        assertFalse(File(store.dir, "book.m4b.part").exists())
    }

    /** A chunk may never push the .part past the size it declared. */
    @Test
    fun `a chunk overshooting the declared total is refused`() = withServer(newStore()) { _, store ->
        val r = client.post("/book?name=book.m4b&pin=$pin&offset=0&total=4") {
            setBody(ByteArray(64))
        }
        assertEquals(HttpStatusCode.PayloadTooLarge, r.status)
        assertFalse(File(store.dir, "book.m4b").exists())
    }

    /** A tab closed mid-upload never calls DELETE /part, so nothing else
     *  would ever remove the debris. */
    @Test
    fun `starting a server reaps abandoned partial uploads`() {
        val store = newStore()
        File(store.dir, "good.m4b").writeBytes(ByteArray(8))
        File(store.dir, "abandoned.m4b.part").writeBytes(ByteArray(4))
        File(store.dir, "another.mp3.part").writeBytes(ByteArray(4))

        reapPartials(store.dir)

        assertTrue(File(store.dir, "good.m4b").exists())
        assertFalse(File(store.dir, "abandoned.m4b.part").exists())
        assertFalse(File(store.dir, "another.mp3.part").exists())
    }

    /** ext4 caps a name at 255 bytes; a char-based limit let 180 multi-byte
     *  characters through and the file open then failed with ENAMETOOLONG. */
    @Test
    fun `an over-long multibyte name is refused`() = withServer(newStore()) { _, _ ->
        val name = "ä".repeat(150) + ".m4b" // 300+ bytes, only 154 chars
        val r = client.post("/book?name=$name&pin=$pin&offset=0&total=10") { setBody(ByteArray(1)) }
        assertEquals(HttpStatusCode.BadRequest, r.status)
    }
}
