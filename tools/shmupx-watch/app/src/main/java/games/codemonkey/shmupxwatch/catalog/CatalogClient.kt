package games.codemonkey.shmupxwatch.catalog

import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import okhttp3.OkHttpClient
import okhttp3.Request
import java.util.concurrent.TimeUnit

/**
 * Reads the two catalogs the launcher screens draw from, over plain HTTPS.
 *
 * No Firebase SDK and no image library, for the same reason
 * `FirebaseRestBridge` gives: a watch APK pays for every dependency, and both
 * of these are a GET and a parse. The one OkHttp client is shared.
 *
 * Neither endpoint is authenticated. The manifest is a public static file; the
 * Realtime Database is open-read. Treat everything that comes back as data —
 * it is world-writable, so a title is a string to draw, never a URL to follow
 * or a path to build.
 */
class CatalogClient(
    private val catalogOrigin: String = "https://codemonkey.games",
    private val rtdbUrl: String = DEFAULT_RTDB,
) {

    private val json = Json {
        ignoreUnknownKeys = true
        coerceInputValues = true
        isLenient = true
    }

    private val client = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .retryOnConnectionFailure(true)
        .build()

    /** A root-relative manifest path is relative to the catalog origin, not to us. */
    fun absolute(url: String?): String? = when {
        url.isNullOrBlank() -> null
        url.startsWith("http://") || url.startsWith("https://") -> url
        url.startsWith("/") -> catalogOrigin.trimEnd('/') + url
        else -> catalogOrigin.trimEnd('/') + "/" + url
    }

    private suspend fun getText(url: String): String? = withContext(Dispatchers.IO) {
        try {
            val request = Request.Builder()
                .url(url)
                // The launcher page does the same: the manifest is served
                // no-store and a stale one shows games that are gone.
                .header("Cache-Control", "no-store")
                .build()
            client.newCall(request).execute().use { response ->
                if (!response.isSuccessful) {
                    Log.w(TAG, "GET $url -> ${response.code}")
                    return@use null
                }
                response.body?.string()
            }
        } catch (e: Exception) {
            Log.w(TAG, "GET $url failed: ${e.message}")
            null
        }
    }

    /**
     * The games manifest, or null when it could not be fetched or parsed.
     *
     * The `?ts=` buster mirrors the launcher page. Deno Deploy already answers
     * `no-store`, but an intermediate proxy on a phone network does not
     * necessarily agree.
     */
    suspend fun fetchManifest(nowMillis: Long): GamesManifest? {
        val body = getText("${catalogOrigin.trimEnd('/')}/games.manifest.json?ts=$nowMillis")
            ?: return null
        return try {
            json.decodeFromString(GamesManifest.serializer(), body)
        } catch (e: Exception) {
            Log.w(TAG, "manifest parse failed: ${e.message}")
            null
        }
    }

    /**
     * The whole Dezaemon shelf index — 262 records, ~216 KB, ungzipped.
     *
     * Fetched whole because there is no alternative: the node has no
     * `.indexOn`, so `orderBy` is a 400, and sorting and A–Z banding have to
     * happen here anyway. `?shallow=true` would give keys only, which is not
     * enough to show a title. Covers are deliberately NOT fetched — that would
     * be 262 × ~50 KB.
     */
    suspend fun fetchDezaShelf(): List<ShelfItem> {
        val body = getText("${rtdbUrl.trimEnd('/')}/dezaemon/index.json") ?: return emptyList()
        return try {
            val raw = json.decodeFromString<Map<String, DezaIndexEntry>>(body)
            raw.map { (slug, entry) ->
                ShelfItem(
                    slug = slug,
                    // titleEn is on all 262; fileTitle is the fallback the
                    // launcher page uses, and the slug is the last resort.
                    title = (entry.titleEn ?: entry.fileTitle ?: slug).uppercase(),
                    // Absent on 49 of 262 — never assume these are there.
                    developer = entry.developerEn.orEmpty(),
                    genre = entry.genre.orEmpty().uppercase(),
                    hasCover = entry.hasCover,
                )
            }.sortedBy { it.title }
        } catch (e: Exception) {
            Log.w(TAG, "deza index parse failed: ${e.message}")
            emptyList()
        }
    }

    /** One cover, as a bare base64 PNG, or null. Called only for what is on screen. */
    suspend fun fetchDezaCover(slug: String): String? {
        val body = getText("${rtdbUrl.trimEnd('/')}/dezaemon/covers/$slug.json") ?: return null
        return try {
            val cover = json.decodeFromString(DezaCover.serializer(), body)
            // Stored as a data URL; every decoder here wants the payload alone.
            cover.png.substringAfterLast(',').takeIf { it.isNotBlank() }
        } catch (e: Exception) {
            Log.w(TAG, "cover parse failed for $slug: ${e.message}")
            null
        }
    }

    /** Raw bytes of an icon, for [IconCache]. */
    suspend fun fetchBytes(url: String): ByteArray? = withContext(Dispatchers.IO) {
        try {
            client.newCall(Request.Builder().url(url).build()).execute().use { response ->
                if (response.isSuccessful) response.body?.bytes() else null
            }
        } catch (e: Exception) {
            Log.w(TAG, "GET bytes $url failed: ${e.message}")
            null
        }
    }

    companion object {
        private const val TAG = "ShmupxCatalog"

        /** static/firebase-config.js — the one database everything here shares. */
        const val DEFAULT_RTDB = "https://evil-invaders-default-rtdb.firebaseio.com"
    }
}
