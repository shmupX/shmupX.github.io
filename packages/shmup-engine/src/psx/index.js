// PlayStation Dezaemon saves — Dezaemon+ (1996) and Dezaemon Kids! (1998) —
// the structural pass, alongside `../sfc/` for the Super Famicom cart.
//
// parsePsxSav() takes whatever a dump is (a raw memory-card image, a DexDrive
// .gme, a single-save .mcs, a PS3 .psv, or the bare save blocks), finds every
// Dezaemon save in it, and decodes each as far as the format is understood:
// the "SC" title frame and icon, then for Kids! the section directory, the
// LZSS-packed graphics (four Dezaemon 2 CG pages) and data (stage maps and
// the rest), the high scores and options; for Dezaemon+ the raw 4bpp graphics
// bitmap, 24 palette rows, five stage blocks, the shared groups, sound, high
// scores and options. Like parseSfcSav(), nothing here throws on content —
// every decoder runs in its own try/catch and failures land in `errors`.
//
// The card-level parse and the Kids! section table, LZSS and checksums are
// confirmed on all 165 community saves; FORMAT-PSX.md marks the rest.
// Environment-neutral ESM (Node + browser).

import { locateSaves } from "./memcard.js";
import { parseSaveHeader } from "./save-header.js";
import { isKidsBlock, KIDS_PRODUCT, KIDS_TITLE_PREFIX, kidsDisplayName, parseKidsSave } from "./kids.js";
export * from "./kids-palette.js";
import { PLUS_PRODUCT, PLUS_TITLE_PREFIX, parsePlusSave } from "./plus.js";

export * from "./memcard.js";
export * from "./save-header.js";
export * from "./kids.js";
export * from "./plus.js";

/** The two games, by the product code their save file is named after. */
export const PSX_GAMES = Object.freeze({
    kids: Object.freeze({ id: "kids", product: KIDS_PRODUCT, title: "Dezaemon Kids!", code: "SLPS-01503", titlePrefix: KIDS_TITLE_PREFIX }),
    plus: Object.freeze({ id: "plus", product: PLUS_PRODUCT, title: "Dezaemon+", code: "SLPS-00335", titlePrefix: PLUS_TITLE_PREFIX }),
});

/**
 * Which Dezaemon a save block belongs to: the file name first, then the
 * title text, then the Kids! directory shape. null for anything else.
 */
export function identifyGame(block, filename = "") {
    if (filename === KIDS_PRODUCT) return "kids";
    if (filename === PLUS_PRODUCT) return "plus";
    if (block.length < 0x100) return null;
    const header = parseSaveHeader(block);
    if (!header.magicOk) return null;
    if (header.title.startsWith(KIDS_TITLE_PREFIX)) return "kids";
    if (header.title.startsWith(PLUS_TITLE_PREFIX)) return "plus";
    if (isKidsBlock(block)) return "kids";
    return null;
}

/**
 * @param {Uint8Array} bytes  a card image, .gme, .mcs, .psv or bare save
 * @returns {{container: string, card: object | null, saves: object[], others: {filename: string, size: number}[], errors: {block: string, message: string}[]}}
 */
export function parsePsxSav(bytes) {
    const located = locateSaves(bytes);
    const result = { container: located.container, card: located.card, saves: [], others: [], errors: [] };
    if (located.container === "unknown") {
        result.errors.push({ block: "container", message: `${bytes.length} bytes: not a memory card image, .gme, .mcs, .psv or "SC" save block` });
        return result;
    }
    for (const save of located.saves) {
        const game = identifyGame(save.data, save.filename);
        if (!game) {
            result.others.push({ filename: save.filename, size: save.data.length, deleted: save.deleted });
            continue;
        }
        const parsed = game === "kids" ? parseKidsSave(save.data, { filename: save.filename }) : parsePlusSave(save.data, { filename: save.filename });
        parsed.deleted = save.deleted;
        result.saves.push(parsed);
    }
    return result;
}

/** True when the bytes hold at least one Dezaemon+ or Dezaemon Kids! save. */
export function isPsxDezaemonSav(bytes) {
    return parsePsxSav(bytes).saves.length > 0;
}

function hex(n) {
    return "0x" + n.toString(16);
}

/** A one-screen summary of a parse, for CLIs and logs. */
export function summarizePsxSav(parsed) {
    const lines = [];
    lines.push(`container: ${parsed.container}${parsed.card ? ` (${parsed.card.files.length} file${parsed.card.files.length === 1 ? "" : "s"}, ${parsed.card.freeBlocks} free blocks)` : ""}`);
    for (const save of parsed.saves) {
        const game = PSX_GAMES[save.game];
        lines.push(`${game.title} (${save.filename || "no directory entry"})${save.deleted ? " [deleted]" : ""}: ${save.size} bytes${save.sizeOk ? "" : " (unexpected size)"}`);
        if (save.header) lines.push(`  title: ${save.header.title}`);
        if (save.game === "kids") {
            lines.push(`  game name: ${kidsDisplayName(save)}`);
            if (save.table) {
                const s = save.table.sections;
                lines.push(`  sections: graphics ${s.graphics.size} B @${hex(s.graphics.offset)}, data ${s.data.size} B @${hex(s.data.offset)}, tail @${hex(s.tail.offset)}; end ${hex(save.table.end)}${save.table.consistent ? "" : " (INCONSISTENT)"}`);
            }
            if (save.checksums) lines.push(`  checksums: graphics ${save.checksums.graphics ? "ok" : "BAD"}, data ${save.checksums.data ? "ok" : "BAD"}, tail ${save.checksums.tail ? "ok" : "BAD"}`);
            if (save.graphics) lines.push(`  graphics: ${save.graphics.length} B decompressed (4 CG pages)`);
            if (save.data) lines.push(`  data: ${save.data.length} B decompressed`);
            if (save.map) lines.push(`  map chips used per stage: ${save.map.map((m) => m.used).join("/")}`);
            if (save.appear) lines.push(`  spawns per stage: ${save.appear.map((a) => a.spawns.length + (a.boss ? "+boss" : "")).join("/")}`);
            if (save.config) lines.push(`  ${save.config.horizontal ? "horizontal" : "vertical"} scrolling, ${save.config.stageCount} stage${save.config.stageCount === 1 ? "" : "s"}`);
            if (save.hiScores) lines.push(`  hi-scores: ${save.hiScores.slice(0, 3).map((h) => `${h.score} ${h.name.trim() || "-"}`).join(", ")} …`);
        } else {
            if (save.checksums) {
                lines.push(`  checksums: ${save.checksums.ok ? `all ${save.checksums.checkedGroups} verified groups match` : `groups ${save.checksums.bad.join(", ")} MISMATCH`}`);
            }
            if (save.palettes) lines.push(`  palettes: ${save.palettes.filter((r) => !r.blank).length}/${save.palettes.length} rows in use`);
            if (save.graphics) lines.push(`  graphics: ${save.graphics.blank ? "blank" : `${save.graphics.usedBytes} of ${save.graphics.indexed.length / 2} bytes non-zero`}`);
            if (save.stages) lines.push(`  map chips used per stage: ${save.stages.map((s) => s.used).join("/")}`);
            if (save.sound) lines.push(`  sound: ${save.sound.length} songs of ${save.sound[0]?.bytes.length ?? 0} bytes`);
            if (save.hiScores) lines.push(`  hi-scores: ${save.hiScores.slice(0, 3).map((h) => `${h.score} ${h.name.trim() || "-"}`).join(", ")} …`);
        }
        for (const e of save.errors) lines.push(`  error in ${e.block}: ${e.message}`);
    }
    for (const o of parsed.others) lines.push(`other save: ${o.filename || "(unnamed)"} ${o.size} B${o.deleted ? " [deleted]" : ""}`);
    for (const e of parsed.errors) lines.push(`error in ${e.block}: ${e.message}`);
    return lines.join("\n");
}
