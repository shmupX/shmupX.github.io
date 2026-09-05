// One call from a cloud level record to a Dezaemon 2 cart image: the palette
// reduction and section assembly of game-to-save.js, then the LZSS payload
// and BackUpRam image of bup-write.js — in the MiSTer / hardware layout the
// community's `Dez 2 - <title>.sav` files use.
//
// Environment-neutral ESM (Node + browser); the editor calls it with frames
// sliced off a canvas, `scripts/build-sav.ts` with frames decoded by
// lib/ps2/png.ts.

import { BUP_LANGUAGE, buildGameSave } from "../bup-write.js";
import { buildSaveFromGame } from "./game-to-save.js";

/** The collection's filename convention: "Dez 2 - <title>.sav". */
export function savFileName(title) {
    const clean = String(title || "game").replace(/[\\/:*?"<>|]+/g, "-").trim() || "game";
    return `Dez 2 - ${clean}.sav`;
}

/** A save comment from a level name: the 10-byte ASCII the header holds. */
export function savComment(title) {
    return String(title || "shmupX").replace(/[^\x20-\x7e]/g, "_").slice(0, 10);
}

/**
 * Export a level record + its RGBA frames as a .sav.
 *
 * Options: everything buildSaveFromGame() takes (`palette`, `gameMode`,
 * `title1`, `title2`, `useBackground`) plus `slot` (1-5), `comment`,
 * `language`, `date` (BUP minutes, or omitted for now) and `layout`
 * ("mister" | "cart").
 *
 * Returns {sav, payload, sections, bank, entry, filename, fileName,
 * warnings, report}.
 */
export function exportLevelToSav(level, art, options = {}) {
    const {
        slot = 1,
        comment,
        language = BUP_LANGUAGE.english,
        date,
        layout = "mister",
        ...buildOptions
    } = options;
    const built = buildSaveFromGame(level, art, buildOptions);
    const title = (level && level.name) || "game";
    const save = buildGameSave(built.sections, {
        slot,
        comment: comment === undefined ? savComment(title) : comment,
        language,
        date,
        layout,
    });
    return {
        sav: save.sav,
        payload: save.payload,
        sections: built.sections,
        bank: built.bank,
        entry: save.entry,
        filename: save.filename,
        fileName: savFileName(title),
        warnings: built.warnings,
        report: built.report,
    };
}
