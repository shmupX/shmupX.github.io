package games.codemonkey.shmupxwatch.catalog

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonPrimitive

/**
 * The launcher manifest, as `https://codemonkey.games/games.manifest.json`
 * serves it.
 *
 * One [ManifestEntry] type covers both arrays on purpose: the build script's
 * `EshopEntry` extends `ManifestEntry`, so the eShop shape is a strict superset
 * and splitting them here would only duplicate twenty nullable fields. Every
 * field but `id` is optional because the manifest gains fields without notice —
 * `twinStick`, `levelEditor`, `subdir`, `streamUrl` all arrived after the first
 * cut, and the parser is configured to ignore what it does not know.
 */
@Serializable
data class GamesManifest(
    /** Short git sha of the commit that generated it. */
    val version: String? = null,
    val generatedAt: String? = null,
    /** The player's own games — in-repo, always present. */
    val games: List<ManifestEntry> = emptyList(),
    /** The global catalog: web builds, arcade romsets, Dezaemon saves. */
    val eshop: List<ManifestEntry> = emptyList(),
)

@Serializable
data class ManifestEntry(
    val id: String,
    val name: String? = null,
    val title: String? = null,
    val sub: String? = null,
    val icon: String? = null,
    val url: String? = null,
    /**
     * How many can play. Genuinely polymorphic in the manifest: `2` on shmupX,
     * `4` on the party game, and the build script's own type allows `"1-4"`.
     * Held as a [JsonPrimitive] so a number and a string both parse — typed as
     * `String` this throws on the live manifest, and as `Int` it throws on the
     * range form.
     */
    val players: JsonPrimitive? = null,
    val size: String? = null,
    val date: String? = null,
    /** eShop only: "web" | "deza" | "arcade". Absent on a `games` row. */
    val kind: String? = null,
    /** Release status, UPPER_SNAKE — "DEBUG", "EARLY_ACCESS". Blank reads as released. */
    val status: String? = null,
    // web
    val source: String? = null,
    val entry: String? = null,
    val downloadUrl: String? = null,
    // arcade
    val core: String? = null,
    val rom: String? = null,
    val romUrl: String? = null,
    // deza
    val sav: String? = null,
    val slug: String? = null,
) {
    /** The design sets every title in caps; the manifest mostly already is. */
    val displayTitle: String get() = (title ?: name ?: id).uppercase()

    val displaySub: String get() = (sub ?: "").uppercase()

    /** "2", "4", "1-4" — whatever the manifest said, as text. */
    val playersText: String? get() = players?.content?.takeIf { it.isNotBlank() }
}

/**
 * One row of `https://evil-invaders-default-rtdb.firebaseio.com/dezaemon/index`.
 *
 * `developerEn` and `genre` are present on only 213 of the 262 entries — the
 * other 49 never matched the games database, and Realtime Database strips
 * nulls, so the KEYS ARE ABSENT rather than null. Defaulting them here is not
 * defensive coding, it is the actual shape.
 *
 * The record's key is the slug, and the slug is derived from the FILENAME, not
 * the title: seven titles are shared by more than one save.
 */
@Serializable
data class DezaIndexEntry(
    val titleEn: String? = null,
    val fileTitle: String? = null,
    val developerEn: String? = null,
    val genre: String? = null,
    val hasCover: Boolean = false,
)

/** `/dezaemon/covers/<slug>` — a PNG as a data URL, ~50 KB, fetched lazily. */
@Serializable
data class DezaCover(
    val png: String,
    val w: Int = 0,
    val h: Int = 0,
)

/** `/dezaemon/meta` — how many saves there are, so the header can say so. */
@Serializable
data class DezaMeta(
    val count: Int = 0,
    val generatedAt: String? = null,
)

/* ─── What the UI actually renders ──────────────────────────────────────── */

/**
 * How a row is started on the desktop. This is the discriminator the launcher
 * page switches on when it reads `/builders/<code>/launch`, so the names are
 * wire values and changing one is a protocol change.
 */
enum class LaunchKind(val wire: String) {
    /** An in-repo game with its own route — `games[]`. */
    GAME("game"),

    /** An eShop web build the desktop unzipped into Cache Storage. */
    ESHOP_WEB("eshop-web"),

    /** A MAME romset, filed against a core. */
    ARCADE("arcade"),

    /** A Dezaemon 2 Saturn save off the shelf. */
    DEZA("deza"),

    /** A Super Famicom cart off the SFC shelf. */
    SNES("snes"),

    /** A PlayStation 2 build off the PS2 shelf. */
    PS2("ps2"),

    /** A shelf row, which opens a shelf screen rather than launching. */
    SHELF("shelf"),
}

/**
 * A row in the library, already reduced to what the screen draws.
 *
 * The design's LIB array is exactly this: `games[] + eshop[]` in that order,
 * then the three shelves appended. Keeping the reduction in one place means the
 * screens never reach back into manifest shapes.
 */
data class LibraryItem(
    val id: String,
    /** Two letters, drawn when there is no icon — the design's `ic`. */
    val initials: String,
    val title: String,
    val sub: String,
    /** Absolute URL, already resolved against the catalog origin. */
    val iconUrl: String? = null,
    /** The small chip on the right of a selected row: "2P", "DEBUG", "262". */
    val tag: String,
    /** The line under the header: "ON THIS BROWSER", "ARCADE SHELF". */
    val kindLabel: String,
    /** Up to three chips on the detail screen. */
    val meta: List<String> = emptyList(),
    val launch: LaunchKind,
    /** Set when this row opens a shelf instead of launching something. */
    val shelf: ShelfKind? = null,
    /** Carried through to the launch payload for an in-repo game. */
    val url: String? = null,
)

/** Which shelf a [LibraryItem] opens. */
enum class ShelfKind(val wire: String, val label: String) {
    DEZAEMON("deza", "DEZAEMON SHELF"),
    SNES("snes", "SUPER FAMICOM SHELF"),
    PS2("ps2", "PLAYSTATION 2 SHELF"),
}

/** One cover on a shelf screen. */
data class ShelfItem(
    val slug: String,
    val title: String,
    val developer: String,
    val genre: String,
    val hasCover: Boolean = false,
)
