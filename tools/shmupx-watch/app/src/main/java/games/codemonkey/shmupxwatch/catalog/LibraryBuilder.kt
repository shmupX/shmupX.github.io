package games.codemonkey.shmupxwatch.catalog

/**
 * Turns the manifest into the rows the library screen draws.
 *
 * The design's LIB array is `games[] + eshop[]` in that order, then the shelves
 * appended — reproducing it is a matter of not re-ordering anything. What is
 * NOT free is the four derived fields the manifest has no column for: the
 * two-letter monogram, the chip on the right, the grouping label, and the three
 * metadata chips on the detail screen. Each is derived below from fields that
 * really exist rather than hardcoded per game, so a game added to
 * `data/eshop.json` tomorrow arrives on the wrist with the rest.
 */
object LibraryBuilder {

    /**
     * @param shelfCounts live sizes for the shelves that can be counted from
     *   here. A shelf with no count still shows — it just does not claim one.
     */
    fun build(
        manifest: GamesManifest?,
        shelfCounts: Map<ShelfKind, Int> = emptyMap(),
        absolute: (String?) -> String? = { it },
    ): List<LibraryItem> {
        if (manifest == null) return emptyList()

        val games = manifest.games.map { entry ->
            entry.toItem(
                kindLabel = "ON THIS BROWSER",
                launch = LaunchKind.GAME,
                platform = entry.platformToken(default = "LOCAL"),
                absolute = absolute,
            )
        }

        val eshop = manifest.eshop.map { entry ->
            when (entry.kind) {
                "arcade" -> entry.toItem(
                    kindLabel = "ARCADE SHELF",
                    launch = LaunchKind.ARCADE,
                    platform = "ARCADE",
                    absolute = absolute,
                )

                "deza" -> entry.toItem(
                    kindLabel = "SHELF",
                    launch = LaunchKind.DEZA,
                    platform = "SATURN",
                    absolute = absolute,
                )

                // "web", and anything new the manifest grows: a web build is
                // the default kind and the only one that needs no player.
                else -> entry.toItem(
                    kindLabel = "ESHOP · INSTALLED",
                    launch = LaunchKind.ESHOP_WEB,
                    platform = entry.platformToken(default = "WEB"),
                    absolute = absolute,
                )
            }
        }

        val shelves = ShelfKind.entries.map { shelf ->
            val count = shelfCounts[shelf]
            LibraryItem(
                id = shelf.wire,
                initials = when (shelf) {
                    ShelfKind.DEZAEMON -> "DZ"
                    ShelfKind.SNES -> "SF"
                    ShelfKind.PS2 -> "P2"
                },
                title = shelf.label,
                sub = when (shelf) {
                    ShelfKind.DEZAEMON -> ".SAV GAMES // SEGA SATURN"
                    ShelfKind.SNES -> "DEZAEMON SFC // IMPORTED CARTS"
                    ShelfKind.PS2 -> "LEVEL EDITOR BUILDS"
                },
                // The design hardcodes 258 / 6 / 3. Those were true once; the
                // shelf holds 262 today. A count that is fetched is a count
                // that stays right, and a shelf we cannot reach shows none
                // rather than a number we made up.
                tag = count?.toString() ?: "—",
                kindLabel = "SHELF",
                meta = listOfNotNull(
                    when (shelf) {
                        ShelfKind.DEZAEMON -> "SATURN"
                        ShelfKind.SNES -> "SFC"
                        ShelfKind.PS2 -> "PS2"
                    },
                    count?.let {
                        when (shelf) {
                            ShelfKind.DEZAEMON -> "$it SAVES"
                            ShelfKind.SNES -> "$it CARTS"
                            ShelfKind.PS2 -> "$it TITLES"
                        }
                    },
                    "LOCAL",
                ),
                launch = LaunchKind.SHELF,
                shelf = shelf,
            )
        }

        return games + eshop + shelves
    }

    private fun ManifestEntry.toItem(
        kindLabel: String,
        launch: LaunchKind,
        platform: String,
        absolute: (String?) -> String?,
    ) = LibraryItem(
        id = id,
        initials = monogram(displayTitle, id),
        title = displayTitle,
        sub = displaySub,
        iconUrl = absolute(icon),
        tag = chip(),
        kindLabel = kindLabel,
        meta = listOfNotNull(
            platform,
            size ?: date,
            playersText?.let { if (it == "1") "1 PLAYER" else "$it PLAYERS" },
        ),
        launch = launch,
        url = url,
    )

    /**
     * The chip on the right of the selected row.
     *
     * Status wins over player count because that is what the design does —
     * SUPER MARIO SP is a two-player-capable build that shows DEBUG, not 2P.
     * A release status of RELEASED is the absence of news and is not shown.
     */
    private fun ManifestEntry.chip(): String {
        val status = status?.takeIf { it.isNotBlank() && !it.equals("RELEASED", true) }
        if (status != null) return status.replace('_', ' ')
        val players = playersText ?: return ""
        return "${players}P"
    }

    /**
     * The platform word in the first metadata chip.
     *
     * `sub` is written as "SFC / .SFC // SNES9X" or "Level Editor // Phaser 4":
     * the half after "//" is the engine and the half before any "/" is the
     * platform. The design shows the engine for shmupX ("PHASER 4") and the
     * platform for the SFC build ("SFC"), which is the same rule read from
     * both ends — take the platform when the subtitle names one, else the
     * engine.
     */
    private fun ManifestEntry.platformToken(default: String): String {
        val sub = displaySub
        if (sub.isBlank()) return default
        val before = sub.substringBefore("//").trim()
        val after = sub.substringAfter("//", "").trim()
        val platform = before.substringBefore("/").trim()
        return when {
            // "SFC / .SFC" — a platform token, short and file-extension-ish.
            platform.isNotEmpty() && platform.length <= 6 && before.contains("/") -> platform
            after.isNotEmpty() -> after
            platform.isNotEmpty() -> platform
            else -> default
        }
    }

    /**
     * Two letters for the icon-less rows.
     *
     * Initials of the first two words when there are two ("SUPER MARIO" → SM,
     * "METAMOQESTER" → MQ from the first two letters). Letters only, so
     * "SH'M↑ PARTY" does not become "S↑".
     */
    fun monogram(title: String, fallback: String): String {
        val words = title.split(' ', '-', '_')
            .mapNotNull { word -> word.firstOrNull { it.isLetter() } }
        val picked = when {
            words.size >= 2 -> "${words[0]}${words[1]}"
            else -> title.filter { it.isLetter() }.take(2)
        }
        return picked.ifBlank { fallback.filter { it.isLetter() }.take(2) }.uppercase()
    }
}
