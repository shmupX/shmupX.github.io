package com.emre.aloud.data

import android.content.Context
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.floatPreferencesKey
import androidx.datastore.preferences.core.intPreferencesKey
import androidx.datastore.preferences.core.longPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.first

/**
 * Single DataStore for all player state: per-book resume positions,
 * playback speed, and the sleep-timer end timestamp (epoch ms).
 *
 * DataStore is a per-application singleton: the context's application
 * must be used, so both Activity and Service share the same store.
 */
object PlayerPrefs {

    private val Context.dataStore by preferencesDataStore(name = "player")

    private fun posKey(bookId: String) = longPreferencesKey("pos:$bookId")
    private fun durKey(bookId: String) = longPreferencesKey("dur:$bookId")
    private val KEY_SPEED = floatPreferencesKey("speed")
    private val KEY_SLEEP_END_MS = longPreferencesKey("sleepEndAtMs")
    private val KEY_SLEEP_MINUTES = intPreferencesKey("sleepMinutes")
    private val KEY_LAST_BOOK = stringPreferencesKey("lastBook")
    private val KEY_PAIR_CODE = stringPreferencesKey("pairCode")

    suspend fun getPos(context: Context, bookId: String): Long =
        context.dataStore.data.first()[posKey(bookId)] ?: 0L

    suspend fun setPos(context: Context, bookId: String, posMs: Long) {
        context.dataStore.edit { it[posKey(bookId)] = posMs }
    }

    suspend fun deletePos(context: Context, bookId: String) {
        context.dataStore.edit { it.remove(posKey(bookId)) }
    }

    /** All saved positions: bookId -> ms. One DataStore read for the library. */
    suspend fun positions(context: Context): Map<String, Long> =
        context.dataStore.data.first().asMap()
            .filterKeys { it.name.startsWith("pos:") }
            .entries.associate { it.key.name.removePrefix("pos:") to (it.value as Long) }

    suspend fun getDur(context: Context, bookId: String): Long =
        context.dataStore.data.first()[durKey(bookId)] ?: 0L

    suspend fun setDur(context: Context, bookId: String, durMs: Long) {
        context.dataStore.edit { it[durKey(bookId)] = durMs }
    }

    /** All known durations: bookId -> ms (filled while a book plays). */
    suspend fun durations(context: Context): Map<String, Long> =
        context.dataStore.data.first().asMap()
            .filterKeys { it.name.startsWith("dur:") }
            .entries.associate { it.key.name.removePrefix("dur:") to (it.value as Long) }

    suspend fun getSpeed(context: Context): Float =
        context.dataStore.data.first()[KEY_SPEED] ?: 1.0f

    suspend fun setSpeed(context: Context, speed: Float) {
        context.dataStore.edit { it[KEY_SPEED] = speed }
    }

    suspend fun getSleepEndMs(context: Context): Long? =
        context.dataStore.data.first()[KEY_SLEEP_END_MS]

    suspend fun setSleepEndMs(context: Context, endMs: Long?) {
        context.dataStore.edit {
            if (endMs == null) it.remove(KEY_SLEEP_END_MS)
            else it[KEY_SLEEP_END_MS] = endMs
        }
    }

    suspend fun getSleepMinutes(context: Context): Int? =
        context.dataStore.data.first()[KEY_SLEEP_MINUTES]

    suspend fun setSleepMinutes(context: Context, minutes: Int?) {
        context.dataStore.edit {
            if (minutes == null) it.remove(KEY_SLEEP_MINUTES)
            else it[KEY_SLEEP_MINUTES] = minutes
        }
    }

    suspend fun getLastBook(context: Context): String? =
        context.dataStore.data.first()[KEY_LAST_BOOK]

    suspend fun setLastBook(context: Context, bookId: String) {
        context.dataStore.edit { it[KEY_LAST_BOOK] = bookId }
    }

    /** The desktop this watch is paired with for the music remote, if any. */
    suspend fun getPairCode(context: Context): String? =
        context.dataStore.data.first()[KEY_PAIR_CODE]

    suspend fun setPairCode(context: Context, code: String?) {
        context.dataStore.edit {
            if (code == null) it.remove(KEY_PAIR_CODE)
            else it[KEY_PAIR_CODE] = code
        }
    }
}
