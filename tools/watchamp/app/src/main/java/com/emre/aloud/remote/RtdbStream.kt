package com.emre.aloud.remote

import org.json.JSONObject
import java.io.BufferedReader

/** One server-sent event off a Realtime Database REST stream. */
internal data class SseEvent(val type: String, val data: String)

/**
 * Reads `text/event-stream` until the stream ends, handing over each event.
 *
 * Hand-rolled because the alternative is an HTTP client library in a watch APK
 * for the sake of forty lines. Blocks; returning means the server closed the
 * stream, which for this database is routine and means "reconnect".
 */
internal fun readSse(reader: BufferedReader, onEvent: (SseEvent) -> Unit) {
    var type: String? = null
    val data = StringBuilder()
    while (true) {
        val line = reader.readLine() ?: return
        when {
            // A blank line ends the event.
            line.isEmpty() -> {
                if (type != null || data.isNotEmpty()) {
                    onEvent(SseEvent(type ?: "message", data.toString()))
                }
                type = null
                data.setLength(0)
            }
            line.startsWith(":") -> Unit // comment
            line.startsWith("event:") -> type = line.substring(6).trim()
            line.startsWith("data:") -> {
                if (data.isNotEmpty()) data.append('\n')
                data.append(line.substring(5).removePrefix(" "))
            }
        }
    }
}

/**
 * The watch's copy of `/builders/<code>/music`, kept current from stream events.
 *
 * The database sends `put` (replace at a path) and `patch` (merge at a path),
 * and the path is relative to the node being watched. Decoding every frame as a
 * whole record is the obvious mistake: a one-field write arrives as just that
 * field, and the title would vanish mid-song.
 *
 * Only the two nodes the desktop writes are mirrored. `launch` and `control`
 * are the watch's own words coming back, and are ignored.
 */
internal class MusicMirror {

    var playing: JSONObject? = null
        private set
    var library: JSONObject? = null
        private set

    /**
     * Applies one `put`/`patch` payload — `{"path": …, "data": …}`.
     *
     * Returns true when the event is the desktop speaking *now*: a write to
     * `playing` or `library` on its own, as opposed to the snapshot of the
     * whole node that every connection opens with, which is history and says
     * nothing about whether a desktop is there.
     */
    fun apply(type: String, payload: JSONObject): Boolean {
        val merge = type == "patch"
        val data = payload.opt("data").takeUnless { it == JSONObject.NULL }
        val path = payload.optString("path", "/").split('/').filter { it.isNotEmpty() }

        if (path.isEmpty()) {
            val node = data as? JSONObject
            if (!merge) {
                playing = node?.optJSONObject("playing")
                library = node?.optJSONObject("library")
            } else if (node != null) {
                if (node.has("playing")) playing = node.optJSONObject("playing")
                if (node.has("library")) library = node.optJSONObject("library")
            }
            return false
        }

        when (path[0]) {
            "playing" -> when (path.size) {
                1 -> playing = if (merge) merged(playing, data as? JSONObject) else data as? JSONObject
                // A single field written on its own, e.g. `/playing/state`.
                2 -> if (!merge) {
                    val next = playing ?: JSONObject()
                    if (data == null) next.remove(path[1]) else next.put(path[1], data)
                    playing = next
                }
                else -> return false
            }
            // The desktop only ever writes the library whole; a deeper write is
            // not something this mirror can place, so it is left alone.
            "library" -> if (path.size == 1 && !merge) library = data as? JSONObject else return false
            else -> return false
        }
        return true
    }

    private fun merged(base: JSONObject?, patch: JSONObject?): JSONObject? {
        if (patch == null) return base
        val out = base ?: JSONObject()
        for (key in patch.keys()) {
            if (patch.isNull(key)) out.remove(key) else out.put(key, patch.get(key))
        }
        return out
    }
}
