package com.emre.aloud.books

import android.content.Context
import java.io.File

/** One audiobook file in the library. [id] is the stable file name (media id). */
data class Book(
    val id: String,
    val title: String,
    val file: File,
)

/**
 * Scans `filesDir/books/` for playable files. Uploads land here as
 * `<name>.part` while in progress and are renamed on completion, so
 * the scan never sees half-written files.
 */
object BooksRepository {

    const val BOOKS_DIR = "books"
    const val PART_SUFFIX = ".part"
    private val EXTENSIONS = setOf("mp3", "m4b")

    /** True for a file name the uploader accepts and the scanner picks up. */
    fun isSupportedName(name: String): Boolean =
        name.substringAfterLast('.', "").lowercase() in EXTENSIONS

    /**
     * True when [id] names a file directly inside the books directory. Media
     * ids arrive from outside — a MediaSession custom command any app on the
     * watch can send, and the debug `--es autoplay` extra — so anything
     * carrying a path component is refused rather than normalised.
     */
    fun isSafeId(id: String): Boolean =
        id.isNotEmpty() && id == File(id).name && !id.startsWith(".")

    fun booksDir(context: Context): File =
        File(context.filesDir, BOOKS_DIR).apply { mkdirs() }

    fun list(context: Context): List<Book> =
        booksDir(context).listFiles { f -> f.isFile && !f.name.endsWith(PART_SUFFIX) }
            .orEmpty()
            .filter { isSupportedName(it.name) }
            .map { Book(id = it.name, title = it.nameWithoutExtension, file = it) }
            .sortedBy { it.title.lowercase() }

    /**
     * Media ids are file names, so a name lookup needs no directory scan — but
     * the id is untrusted, so it must not be able to escape the books
     * directory. See [isSafeId].
     */
    fun bookByName(context: Context, id: String): Book? {
        if (!isSafeId(id)) return null
        val f = File(booksDir(context), id)
        if (!f.isFile || !isSupportedName(f.name)) return null
        return Book(id = f.name, title = f.nameWithoutExtension, file = f)
    }
}
