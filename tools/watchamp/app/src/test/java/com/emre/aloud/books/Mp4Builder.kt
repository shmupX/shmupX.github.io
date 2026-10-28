package com.emre.aloud.books

import java.io.ByteArrayOutputStream

/**
 * Minimal ISO-BMFF writer: builds the exact box layouts Mp4ChapterParser reads,
 * so the parser can be exercised without shipping binary fixtures.
 *
 * Only what the parser looks at is modelled faithfully (box sizes/types, tkhd
 * and mdhd field offsets, the stts/stsz/stsc/stco sample tables); everything
 * else is realistic padding.
 */
object Mp4Builder {

    fun i32(v: Int): ByteArray = byteArrayOf(
        (v ushr 24).toByte(), (v ushr 16).toByte(), (v ushr 8).toByte(), v.toByte(),
    )

    fun i64(v: Long): ByteArray = ByteArray(8) { i -> (v ushr (56 - 8 * i)).toByte() }

    fun u16(v: Int): ByteArray = byteArrayOf((v ushr 8).toByte(), v.toByte())

    fun cat(vararg parts: ByteArray): ByteArray {
        val out = ByteArrayOutputStream()
        parts.forEach { out.write(it) }
        return out.toByteArray()
    }

    fun box(type: String, payload: ByteArray): ByteArray =
        cat(i32(8 + payload.size), type.toByteArray(Charsets.US_ASCII), payload)

    fun container(type: String, vararg children: ByteArray): ByteArray = box(type, cat(*children))

    private fun fullBox(version: Int = 0): ByteArray = byteArrayOf(version.toByte(), 0, 0, 0)

    private val FTYP = box("ftyp", cat("M4A ".toByteArray(), i32(512), "M4A isomiso2".toByteArray()))

    // --- Nero chpl ---------------------------------------------------------

    /** chpl payload: version+flags, one reserved byte, u32 count, then
     *  (u64 start in 100ns units, u8 title length, title) per chapter. */
    fun chpl(
        chapters: List<Pair<Long, String>>,
        declaredCount: Int = chapters.size,
        chplVersion: Int = 1,
        nonZeroFlags: Boolean = false,
    ): ByteArray {
        val body = ByteArrayOutputStream()
        body.write(fullBox(chplVersion).copyOf().apply {
            if (nonZeroFlags) this[3] = 1
        })
        body.write(0) // reserved
        body.write(i32(declaredCount))
        for ((startMs, title) in chapters) {
            body.write(i64(startMs * 10_000))
            val t = title.toByteArray(Charsets.UTF_8)
            body.write(t.size)
            body.write(t)
        }
        return box("chpl", body.toByteArray())
    }

    fun neroFile(
        chapters: List<Pair<Long, String>>,
        declaredCount: Int = chapters.size,
        chplVersion: Int = 1,
        nonZeroFlags: Boolean = false,
    ): ByteArray =
        cat(FTYP, container("moov", container("udta", chpl(chapters, declaredCount, chplVersion, nonZeroFlags))))

    /** Some muxers nest moov inside moov; the parser has to unwrap it. */
    fun nestedNeroFile(chapters: List<Pair<Long, String>>): ByteArray =
        cat(FTYP, container("moov", container("moov", container("udta", chpl(chapters)))))

    // --- QuickTime chapter track -------------------------------------------

    private fun tkhd(trackId: Int): ByteArray =
        box("tkhd", cat(fullBox(0), i32(0), i32(0), i32(trackId), ByteArray(68)))

    private fun mdhd(timescale: Int): ByteArray =
        box("mdhd", cat(fullBox(0), i32(0), i32(0), i32(timescale), i32(0), u16(0x55C4), u16(0)))

    private fun stts(runs: List<Pair<Int, Int>>): ByteArray =
        box("stts", cat(fullBox(), i32(runs.size), *runs.map { cat(i32(it.first), i32(it.second)) }.toTypedArray()))

    private fun stsz(sizes: List<Int>): ByteArray =
        box("stsz", cat(fullBox(), i32(0), i32(sizes.size), *sizes.map { i32(it) }.toTypedArray()))

    /** stsz variant used when every sample is the same size: no size table. */
    private fun stszUniform(size: Int, count: Int): ByteArray =
        box("stsz", cat(fullBox(), i32(size), i32(count)))

    private fun stsc(runs: List<Pair<Int, Int>>): ByteArray =
        box("stsc", cat(fullBox(), i32(runs.size), *runs.map { cat(i32(it.first), i32(it.second), i32(1)) }.toTypedArray()))

    private fun stco(offsets: List<Long>): ByteArray =
        box("stco", cat(fullBox(), i32(offsets.size), *offsets.map { i32(it.toInt()) }.toTypedArray()))

    /** One chapter text sample: u16 length prefix + title + optional trailer
     *  (real muxers append an 'encd' atom after the text). */
    private fun sample(title: String, trailer: Int, utf16: Boolean): ByteArray {
        val payload = if (utf16) {
            cat(byteArrayOf(0xFF.toByte(), 0xFE.toByte()), title.toByteArray(Charsets.UTF_16LE))
        } else {
            title.toByteArray(Charsets.UTF_8)
        }
        return cat(u16(payload.size), payload, ByteArray(trailer))
    }

    /**
     * A file with an audio trak that points at a text trak via tref/chap.
     * [startsMs] must begin at 0 — QuickTime chapter times come from the sample
     * table deltas, which always start at zero.
     */
    fun quickTimeFile(
        startsMs: List<Long>,
        titles: List<String>,
        timescale: Int = 1000,
        samplesPerChunk: Int = 1,
        trailerBytes: Int = 0,
        sttsOverride: List<Pair<Int, Int>>? = null,
        uniformSampleSize: Boolean = false,
        utf16Titles: Boolean = false,
    ): ByteArray {
        val raw = titles.map { sample(it, trailerBytes, utf16Titles) }
        // A fixed-size stsz has no size table at all, so every sample must be
        // padded to the same length.
        val width = raw.maxOf { it.size }
        val samples = if (uniformSampleSize) raw.map { it + ByteArray(width - it.size) } else raw
        val sizes = samples.map { it.size }

        // Chunk layout: fill each chunk with samplesPerChunk samples; the tail
        // chunk takes the remainder (a second stsc run, like real files).
        val chunkCounts = mutableListOf<Int>()
        var placed = 0
        while (placed < samples.size) {
            val c = minOf(samplesPerChunk, samples.size - placed)
            chunkCounts += c
            placed += c
        }
        val stscRuns = mutableListOf<Pair<Int, Int>>()
        chunkCounts.forEachIndexed { idx, count ->
            if (stscRuns.isEmpty() || stscRuns.last().second != count) stscRuns += (idx + 1) to count
        }

        // File layout is ftyp | mdat | moov, so sample offsets are known up front.
        val mdatPayloadStart = FTYP.size + 8L
        val offsets = mutableListOf<Long>()
        var cursor = mdatPayloadStart
        var sampleIdx = 0
        for (count in chunkCounts) {
            offsets += cursor
            repeat(count) { cursor += sizes[sampleIdx++] }
        }

        val deltas = startsMs.indices.map { i ->
            val next = startsMs.getOrNull(i + 1) ?: (startsMs[i] + 5_000)
            ((next - startsMs[i]) * timescale / 1000).toInt()
        }
        val runs = sttsOverride ?: buildList {
            for (d in deltas) {
                val last = lastOrNull()
                if (last != null && last.second == d) set(size - 1, (last.first + 1) to d) else add(1 to d)
            }
        }

        val textTrak = container(
            "trak",
            tkhd(2),
            container(
                "mdia",
                mdhd(timescale),
                box("hdlr", cat(fullBox(), i32(0), "text".toByteArray(), ByteArray(12))),
                container(
                    "minf",
                    box("dinf", ByteArray(8)),
                    container(
                        "stbl",
                        stts(runs),
                        if (uniformSampleSize) stszUniform(width, samples.size) else stsz(sizes),
                        stsc(stscRuns),
                        stco(offsets),
                    ),
                ),
            ),
        )
        val audioTrak = container("trak", tkhd(1), container("tref", box("chap", i32(2))))
        return cat(FTYP, box("mdat", cat(*samples.toTypedArray())), container("moov", audioTrak, textTrak))
    }
}
