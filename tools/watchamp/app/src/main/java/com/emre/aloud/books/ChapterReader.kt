package com.emre.aloud.books

import androidx.annotation.OptIn
import androidx.media3.common.DataReader
import androidx.media3.common.Format
import androidx.media3.common.util.ParsableByteArray
import androidx.media3.common.util.UnstableApi
import androidx.media3.extractor.DefaultExtractorInput
import androidx.media3.extractor.Extractor
import androidx.media3.extractor.ExtractorOutput
import androidx.media3.extractor.PositionHolder
import androidx.media3.extractor.SeekMap
import androidx.media3.extractor.TrackOutput
import androidx.media3.extractor.metadata.Chapter as Media3Chapter
import androidx.media3.extractor.mp3.Mp3Extractor
import com.emre.aloud.playback.Chapter
import com.emre.aloud.util.Logg
import java.io.EOFException
import java.io.File
import java.io.RandomAccessFile

/**
 * Reads chapters straight from a file, independently of playback.
 *
 * Two reasons this does not simply use the player's own chapter callbacks:
 *
 *  - They only fire while the player is actually *playing*, and `Mp4Extractor`
 *    discards what it collected on the first seek. A book opened paused at its
 *    saved position — the normal case — therefore got nothing.
 *  - Media3's MP4 extractor parses the whole audio sample table before it
 *    publishes chapters. For a 1.3 GB / 23 h audiobook that is millions of
 *    entries and took **over 4 minutes** on a Pixel Watch 5, versus 96 ms for
 *    reading just the chapter boxes.
 *
 * So MP4/M4B goes through [Mp4ChapterParser], which reads only `chpl` and the
 * chapter track — O(chapters) rather than O(audio samples). MP3 has no such
 * table, so Media3's `Mp3Extractor` handles ID3 `CHAP` frames directly and
 * finishes in milliseconds.
 */
@OptIn(UnstableApi::class)
object ChapterReader {

    /** Header parsing is done well before this; the cap only stops a runaway. */
    private const val MAX_READS = 20_000

    /** Blocking; call from [kotlinx.coroutines.Dispatchers.IO]. */
    fun read(file: File): List<Chapter> = try {
        if (file.extension.lowercase() == "mp3") readId3(file)
        else Mp4ChapterParser.parse(file).map { Chapter(it.startMs, it.endMs, it.title) }
    } catch (e: Exception) {
        Logg.d("chapter read failed for ${file.name}: $e")
        emptyList()
    }

    /** ID3 `CHAP` frames, via Media3 — cheap, an MP3 has no sample table. */
    private fun readId3(file: File): List<Chapter> {
        val extractor = Mp3Extractor()
        val sink = FormatSink()
        extractor.init(sink)
        RandomAccessFile(file, "r").use { raf ->
            var position = 0L
            var input = DefaultExtractorInput(RafReader(raf), position, file.length())
            val seek = PositionHolder()
            var reads = 0
            while (reads++ < MAX_READS && sink.chapters().isEmpty() && !sink.sawSample) {
                val result = extractor.read(input, seek)
                if (result == Extractor.RESULT_END_OF_INPUT) break
                if (result == Extractor.RESULT_SEEK) {
                    position = seek.position
                    raf.seek(position)
                    input = DefaultExtractorInput(RafReader(raf), position, file.length())
                }
            }
        }
        extractor.release()
        return sink.chapters()
    }

    private class RafReader(private val raf: RandomAccessFile) : DataReader {
        override fun read(buffer: ByteArray, offset: Int, length: Int): Int =
            raf.read(buffer, offset, length)
    }

    /**
     * Collects the formats the extractor publishes. Chapters ride the track
     * Format's metadata for both containers, so that is all we keep; samples
     * are discarded, and the first one ends the read because header parsing
     * (and therefore chapter extraction) is complete by then.
     */
    private class FormatSink : ExtractorOutput {
        private val formats = mutableListOf<Format>()
        var sawSample = false
            private set

        fun chapters(): List<Chapter> = formats
            .flatMap { f ->
                val m = f.metadata ?: return@flatMap emptyList()
                (0 until m.length()).mapNotNull { m.get(it) as? Media3Chapter }
            }
            .filterNot { it.isHidden }
            .map { Chapter(it.startTimeMs, it.endTimeMs, it.title?.value?.trim().orEmpty()) }
            .sortedBy { it.startMs }
            .distinctBy { it.startMs }

        override fun track(id: Int, type: Int): TrackOutput = object : TrackOutput {
            override fun format(format: Format) { formats += format }

            override fun sampleData(
                input: DataReader, length: Int, allowEndOfInput: Boolean, sampleDataPart: Int,
            ): Int {
                val skipped = input.read(ByteArray(length), 0, length)
                if (skipped < 0) {
                    if (allowEndOfInput) return C_RESULT_END_OF_INPUT
                    throw EOFException()
                }
                return skipped
            }

            override fun sampleData(data: ParsableByteArray, length: Int, sampleDataPart: Int) {
                data.skipBytes(length)
            }

            override fun sampleMetadata(
                timeUs: Long, flags: Int, size: Int, offset: Int,
                cryptoData: TrackOutput.CryptoData?,
            ) {
                sawSample = true
            }
        }

        override fun endTracks() = Unit
        override fun seekMap(seekMap: SeekMap) = Unit
    }

    private const val C_RESULT_END_OF_INPUT = -1
}
