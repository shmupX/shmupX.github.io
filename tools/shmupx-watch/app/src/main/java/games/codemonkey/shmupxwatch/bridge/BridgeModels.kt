package games.codemonkey.shmupxwatch.bridge

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * The four states a coding agent can be in, plus UNKNOWN for anything the
 * daemon couldn't classify. These map 1:1 onto the daemon's own state machine
 * so the watch never has to interpret terminal output itself.
 */
enum class AgentState {
    IDLE,
    WORKING,
    BLOCKED,
    DONE,
    UNKNOWN;

    companion object {
        fun parse(raw: String?): AgentState =
            entries.firstOrNull { it.name.equals(raw?.trim(), ignoreCase = true) } ?: UNKNOWN
    }
}

@Serializable
data class AgentSnapshot(
    val id: String,
    val label: String = id,
    @SerialName("state") val rawState: String = "unknown",
    /** One line of context — the question being asked, or the current task. */
    val detail: String? = null,
    val workspace: String? = null,
    @SerialName("updated_at") val updatedAt: Long = 0L,
) {
    val state: AgentState get() = AgentState.parse(rawState)
}

/**
 * A rendered sprite coming back from the shmupx_character_preview MCP tool.
 * [pngBase64] is the raw base64 payload with no data-URI prefix.
 */
@Serializable
data class PreviewFrame(
    @SerialName("object_id") val objectId: String,
    val label: String = objectId,
    @SerialName("png_base64") val pngBase64: String,
    @SerialName("width_px") val widthPx: Int = 0,
    @SerialName("height_px") val heightPx: Int = 0,
    /** Bumped by the daemon on every write — used as the recomposition key. */
    val revision: Long = 0L,
    /** Optional free-text summary of what changed, shown under the sprite. */
    val note: String? = null,
)

@Serializable
data class Utterance(
    val text: String,
    @SerialName("agent_id") val agentId: String? = null,
    @SerialName("created_at") val createdAt: Long = System.currentTimeMillis(),
    val source: String = "watch",
)

/** Replies the watch can send to a BLOCKED agent without dictating anything. */
enum class QuickReply(val wire: String, val label: String) {
    APPROVE("approve", "Approve"),
    DENY("deny", "Deny"),
    ALWAYS_ALLOW("always_allow", "Always allow"),
}

@Serializable
data class AgentCommand(
    val kind: String,
    val value: String? = null,
    @SerialName("created_at") val createdAt: Long = System.currentTimeMillis(),
)

enum class ConnectionState {
    DISCONNECTED,
    CONNECTING,
    CONNECTED,
    /** Running on canned data because no RTDB URL is configured. */
    DEMO,
}

/* ─── The launcher half of the protocol ─────────────────────────────────── */

/**
 * What the watch writes to `/builders/<code>/launch` to start a game on the
 * paired desktop. One slot, PUT rather than pushed: the latest press wins, and
 * a queue of stale launches is never what anybody wanted.
 *
 * [id] is what makes a press distinguishable from a redelivery of the same
 * press — the desktop keeps the ids it has acted on, and the stream's first
 * frame after a reconnect is the whole node, i.e. history. Without it, opening
 * the launcher page would replay the last launch.
 *
 * Nothing here identifies the watch or its owner. The database is open-read and
 * open-write, so this record is world-readable; it carries a game id and
 * nothing else worth having.
 */
@Serializable
data class LaunchRequest(
    val id: String,
    /** "game" | "eshop-web" | "arcade" | "deza" | "snes" | "ps2". */
    val kind: String,
    @SerialName("game_id") val gameId: String? = null,
    /** A shelf record: a Dezaemon slug, an SFC cart id, a PS2 build id. */
    @SerialName("shelf_id") val shelfId: String? = null,
    /** The cloud .sav slug, for the editor's `&play=` hand-off. */
    val slug: String? = null,
    /** Same-origin path the desktop may open instead of deriving one. */
    val url: String? = null,
    val players: Int? = null,
    /** Close whatever is running first. The watch always means this. */
    val replace: Boolean = true,
    val source: String = "watch",
    @SerialName("created_at") val createdAt: Long = System.currentTimeMillis(),
)

/**
 * What the desktop writes back to `/builders/<code>/playing`.
 *
 * This is what makes the design's LAUNCHING and NOW PLAYING screens honest. The
 * mock advances on a 1.7-second timer; here the watch waits for the desktop to
 * say it actually started, and shows the failure when it did not.
 */
@Serializable
data class PlayingState(
    /** "idle" | "launching" | "playing" | "paused" | "error". */
    val state: String = "idle",
    /** Echoes [LaunchRequest.id], so the watch knows this is about its press. */
    val id: String? = null,
    @SerialName("game_id") val gameId: String? = null,
    val kind: String? = null,
    val title: String? = null,
    @SerialName("started_at") val startedAt: Long = 0L,
    /** 0..10, matching the design's ten-segment meter. */
    val volume: Int = 7,
    val detail: String? = null,
    @SerialName("updated_at") val updatedAt: Long = 0L,
) {
    val isRunning: Boolean get() = state == "playing" || state == "paused"
    val isPaused: Boolean get() = state == "paused"
    val isLaunching: Boolean get() = state == "launching"
    val isError: Boolean get() = state == "error"
}

/** What the watch writes to `/builders/<code>/control` to drive a running game. */
@Serializable
data class ControlCommand(
    /** "pause" | "resume" | "stop" | "volume". */
    val action: String,
    /** 0..10 for "volume"; ignored otherwise. */
    val value: Int? = null,
    val source: String = "watch",
    @SerialName("created_at") val createdAt: Long = System.currentTimeMillis(),
)

/**
 * Shelf sizes the desktop publishes because the watch cannot count them.
 *
 * The games manifest and the Dezaemon index are public and fetched directly.
 * The Super Famicom and PlayStation 2 shelves are not: they live in the
 * launcher page's own IndexedDB. Absent means unknown, which the UI shows as a
 * dash — deliberately different from zero, and from the design's hardcoded
 * counts, which were true once and have not been since.
 */
@Serializable
data class ShelfCounts(
    val deza: Int? = null,
    val snes: Int? = null,
    val ps2: Int? = null,
)
