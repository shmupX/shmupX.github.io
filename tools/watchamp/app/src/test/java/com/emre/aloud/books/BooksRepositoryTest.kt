package com.emre.aloud.books

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** The uploader accepts exactly the names this predicate accepts. */
class BooksRepositoryTest {

    @Test
    fun `supported extensions are accepted case-insensitively`() {
        assertTrue(BooksRepository.isSupportedName("book.mp3"))
        assertTrue(BooksRepository.isSupportedName("book.M4B"))
        assertTrue(BooksRepository.isSupportedName("Björn läser.m4b"))
    }

    @Test
    fun `other extensions are rejected`() {
        assertFalse(BooksRepository.isSupportedName("book.mp4"))
        assertFalse(BooksRepository.isSupportedName("book.mp3.part"))
        assertFalse(BooksRepository.isSupportedName("book"))
        assertFalse(BooksRepository.isSupportedName(""))
    }

    /** Media ids arrive from untrusted callers (any app on the watch can send
     *  a MediaSession custom command), so they must not escape books/. */
    @Test
    fun `ids that escape the books directory are rejected`() {
        assertFalse(BooksRepository.isSafeId("../secret.m4b"))
        assertFalse(BooksRepository.isSafeId("../../data/other/x.mp3"))
        assertFalse(BooksRepository.isSafeId("sub/dir.m4b"))
        assertFalse(BooksRepository.isSafeId("/etc/passwd.mp3"))
        assertFalse(BooksRepository.isSafeId(".hidden.m4b"))
        assertFalse(BooksRepository.isSafeId(""))
    }

    @Test
    fun `plain file names are accepted as ids`() {
        assertTrue(BooksRepository.isSafeId("book.m4b"))
        assertTrue(BooksRepository.isSafeId("Björn läser.m4b"))
    }
}
