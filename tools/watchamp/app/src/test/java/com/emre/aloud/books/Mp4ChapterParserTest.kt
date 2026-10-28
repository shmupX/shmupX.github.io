package com.emre.aloud.books

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Mp4ChapterParser is the least battle-tested code in the app and the one that
 * reads untrusted bytes, so it is covered here against synthetic files built by
 * [Mp4Builder] — no device and no real audiobook needed.
 */
class Mp4ChapterParserTest {

    private fun fileOf(bytes: ByteArray): File =
        File.createTempFile("wearbite", ".m4b").apply {
            deleteOnExit()
            writeBytes(bytes)
        }

    private fun parse(bytes: ByteArray) = Mp4ChapterParser.parse(fileOf(bytes))

    // --- Nero chpl ---------------------------------------------------------

    @Test
    fun `nero chpl chapters keep their titles and start times`() {
        val chapters = parse(
            Mp4Builder.neroFile(
                listOf(0L to "Opening", 65_432L to "Chapter 2", 3_600_000L to "Chapter 3"),
            ),
        )
        assertEquals(3, chapters.size)
        assertEquals(listOf(0L, 65_432L, 3_600_000L), chapters.map { it.startMs })
        assertEquals(listOf("Opening", "Chapter 2", "Chapter 3"), chapters.map { it.title })
    }

    @Test
    fun `nero chpl end times chain from the next chapter start`() {
        val chapters = parse(Mp4Builder.neroFile(listOf(0L to "A", 1_000L to "B", 5_000L to "C")))
        assertEquals(listOf(1_000L, 5_000L, -1L), chapters.map { it.endMs })
    }

    @Test
    fun `a non-v1 chpl box is refused, not misparsed`() {
        // Only the Nero v1 layout is understood; walking a v2 file as if it
        // were v1 used to produce garbage chapter lists.
        assertTrue(parse(Mp4Builder.neroFile(listOf(0L to "A"), chplVersion = 2)).isEmpty())
    }

    @Test
    fun `a chpl box with set flags is refused`() {
        val chapters = parse(Mp4Builder.neroFile(listOf(0L to "A"), nonZeroFlags = true))
        assertTrue(chapters.isEmpty())
    }

    @Test
    fun `nero chpl decodes multi-byte utf8 titles`() {
        val title = "Björn läser — kapitel ett"
        val chapters = parse(Mp4Builder.neroFile(listOf(0L to title)))
        assertEquals(listOf(title), chapters.map { it.title })
    }

    @Test
    fun `nero chpl with an absurd chapter count is refused`() {
        val chapters = parse(Mp4Builder.neroFile(listOf(0L to "A"), declaredCount = 20_000))
        assertTrue(chapters.isEmpty())
    }

    @Test
    fun `moov nested inside moov is unwrapped`() {
        val chapters = parse(Mp4Builder.nestedNeroFile(listOf(0L to "One", 5_000L to "Two")))
        assertEquals(listOf("One", "Two"), chapters.map { it.title })
    }

    // --- QuickTime chapter track -------------------------------------------

    private val starts = listOf(0L, 12_000L, 30_000L)
    private val titles = listOf("Intro", "The Middle", "The End")

    @Test
    fun `quicktime chapter track is read through the sample tables`() {
        val chapters = parse(Mp4Builder.quickTimeFile(starts, titles))
        assertEquals(titles, chapters.map { it.title })
        assertEquals(starts, chapters.map { it.startMs })
    }

    @Test
    fun `quicktime end times chain to the next chapter`() {
        val chapters = parse(Mp4Builder.quickTimeFile(starts, titles))
        assertEquals(listOf(12_000L, 30_000L, -1L), chapters.map { it.endMs })
    }

    @Test
    fun `quicktime samples spread over multiple chunks are all found`() {
        // Regression guard for the stsc run walk: chunk 1 holds two samples,
        // chunk 2 holds the remainder, so the parser must switch stsc runs.
        val chapters = parse(Mp4Builder.quickTimeFile(starts, titles, samplesPerChunk = 2))
        assertEquals(titles, chapters.map { it.title })
        assertEquals(starts, chapters.map { it.startMs })
    }

    @Test
    fun `quicktime samples with trailing atom bytes still decode`() {
        // Real muxers append an 'encd' atom after the text; the parser must
        // advance by the sample size, not by the text length.
        val chapters = parse(Mp4Builder.quickTimeFile(starts, titles, trailerBytes = 12))
        assertEquals(titles, chapters.map { it.title })
    }

    @Test
    fun `quicktime honours a non-millisecond timescale`() {
        val chapters = parse(Mp4Builder.quickTimeFile(starts, titles, timescale = 600))
        assertEquals(starts, chapters.map { it.startMs })
    }

    @Test
    fun `quicktime handles a compressed stts run`() {
        val evenStarts = listOf(0L, 10_000L, 20_000L)
        val chapters = parse(
            Mp4Builder.quickTimeFile(evenStarts, titles, sttsOverride = listOf(3 to 10_000)),
        )
        assertEquals(evenStarts, chapters.map { it.startMs })
    }

    @Test
    fun `an stts entry claiming millions of samples is refused, not expanded`() {
        // The sample count inside one stts entry is unbounded on its own: an
        // audio track (or a corrupt box) claiming millions of samples used to
        // be expanded into a list one entry at a time until memory ran out.
        val started = System.nanoTime()
        val chapters = parse(
            Mp4Builder.quickTimeFile(starts, titles, sttsOverride = listOf(5_000_000 to 1)),
        )
        val elapsedMs = (System.nanoTime() - started) / 1_000_000
        assertTrue(chapters.isEmpty())
        assertTrue("parse took ${elapsedMs}ms — the sample cap did not fire", elapsedMs < 2_000)
    }

    @Test
    fun `quicktime titles with a UTF-16 BOM decode instead of mojibake`() {
        val title = "The Middle — mid chapters"
        val chapters = parse(Mp4Builder.quickTimeFile(starts, titles.map { t -> if (t == "The Middle") title else t }, utf16Titles = true))
        assertEquals(listOf("Intro", title, "The End"), chapters.map { it.title })
    }

    @Test
    fun `quicktime reads a fixed-size stsz that carries no size table`() {
        val chapters = parse(Mp4Builder.quickTimeFile(starts, titles, uniformSampleSize = true))
        assertEquals(titles, chapters.map { it.title })
        assertEquals(starts, chapters.map { it.startMs })
    }

    @Test
    fun `chapter count comes from stsz sampleCount, not from the first sample size`() {
        // Regression guard: the count used to be read from stsz+12, which is
        // the first size entry — a book opening with a one-character chapter
        // title silently lost every chapter past the third.
        val many = listOf(0L, 1_000L, 2_000L, 3_000L, 4_000L)
        val shortFirst = listOf("1", "Two", "Three", "Four", "Five")
        val chapters = parse(Mp4Builder.quickTimeFile(many, shortFirst))
        assertEquals(shortFirst, chapters.map { it.title })
    }

    // --- hostile / malformed input -----------------------------------------

    @Test
    fun `a file without a moov box yields no chapters`() {
        assertTrue(parse(Mp4Builder.box("mdat", ByteArray(64))).isEmpty())
    }

    @Test
    fun `an empty file yields no chapters`() {
        assertTrue(parse(ByteArray(0)).isEmpty())
    }

    @Test
    fun `random bytes yield no chapters instead of throwing`() {
        val junk = ByteArray(4096) { (it * 31 % 251).toByte() }
        assertTrue(parse(junk).isEmpty())
    }

    @Test
    fun `a truncated chapter file yields no chapters instead of throwing`() {
        val full = Mp4Builder.quickTimeFile(starts, titles)
        assertTrue(parse(full.copyOf(full.size / 2)).isEmpty())
    }
}
