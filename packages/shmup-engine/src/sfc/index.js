// Super Famicom Dezaemon (SHVC-66) save parser — the structural pass.
//
// parseSfcSav() takes a raw SRAM dump and returns every region the ROM's own
// map names, decoded as far as the format is understood: the container and
// its magic, the checksum block and its copy, the 24 palette rows, the six
// stage maps and scroll tables, every tile group, the high-score table and
// the configuration words, and the graphics bank when the dump has one. Raw
// regions (SOUND DATA, ENEMY DATA, APPEAR DATA) come back as sized views.
//
// Like decodeSave() for the Saturn format, it never throws on content: each
// block decodes inside its own try/catch and failures land in `errors`, so a
// truncated or odd dump still yields whatever it does contain. `confidence`
// mirrors regions.js. With a ROM beside the save, `rom` reports whether the
// header, region table and default image agree with what this parser assumes.
// Environment-neutral ESM (Node + browser).

import { CONFIDENCES, coverage, REGION, regionFor, regionStats, SFC_REGIONS } from "./regions.js";
import {
    ACCEPTED_SIZES,
    CHECK_STRING,
    hasCheckString,
    isSfcSav,
    readCheckString,
    readChecksumBlocks,
    splitSegments,
    SRAM_SIZE,
} from "./sram.js";
import { decodePaletteData } from "./cgram.js";
import { decodeMapData, decodeScrollEffect } from "./map.js";
import { decodeGroups } from "./groups.js";
import { decodeConfig, decodeHiScores, sliceSound } from "./tables.js";
import { decodeAppearData, decodeEnemyData } from "./enemy.js";
import { decodeGraphics } from "./graphics.js";
import { compareWithRomDefault, isDezaemonRom, parseRomRegionTable, readRomHeader, regionTableMatches } from "./rom.js";
import { verifySfcChecksums } from "./checksum.js";

export * from "./regions.js";
export * from "./sram.js";
export * from "./cgram.js";
export * from "./tiles.js";
export * from "./tilemap.js";
export * from "./groups.js";
export * from "./map.js";
export * from "./tables.js";
export * from "./enemy.js";
export * from "./graphics.js";
export * from "./cover.js";
export * from "./rom.js";
export * from "./checksum.js";
export * from "./factory-data.js";
export * from "./chips.js";
export * from "./sfc-format.js";
export * from "./tile-bank.js";
export * from "./sfc-write.js";

/**
 * @typedef {object} SfcRomReport
 * @property {ReturnType<typeof readRomHeader>} header
 * @property {boolean} isDezaemon
 * @property {ReturnType<typeof parseRomRegionTable>} regionTable
 * @property {ReturnType<typeof regionTableMatches>} regionTableMatches
 * @property {ReturnType<typeof compareWithRomDefault>} defaultImage
 */

/**
 * @typedef {object} SfcSave
 * @property {number} size
 * @property {boolean} sizeOk
 * @property {boolean} complete            128 KB, so GRAPIC DATA is in the file
 * @property {string} checkString
 * @property {boolean} checkStringOk
 * @property {boolean} isSfcSav
 * @property {ReturnType<typeof splitSegments>} segments
 * @property {Record<string, string>} confidence
 * @property {{block: string, message: string}[]} errors
 * @property {ReturnType<typeof readChecksumBlocks> | null} checksum
 * @property {ReturnType<typeof decodePaletteData> | null} palettes
 * @property {ReturnType<typeof decodeMapData> | null} maps
 * @property {ReturnType<typeof decodeScrollEffect> | null} scroll
 * @property {ReturnType<typeof decodeGroups> | null} groups
 * @property {ReturnType<typeof decodeHiScores> | null} hiScores
 * @property {ReturnType<typeof decodeConfig> | null} config
 * @property {ReturnType<typeof sliceSound> | null} sound
 * @property {ReturnType<typeof decodeEnemyData> | null} enemies
 * @property {ReturnType<typeof decodeAppearData> | null} appear
 * @property {ReturnType<typeof decodeGraphics> | null} graphics
 * @property {typeof SFC_REGIONS} regions
 * @property {SfcRomReport | null} rom
 * @property {Uint8Array} bytes            the dump itself, for drawing its chips
 * @property {Uint8Array | null} romBytes  the ROM when given, for the factory sheets
 */

function attempt(result, block, fn) {
    try {
        result[block] = fn();
    } catch (err) {
        result[block] = null;
        result.errors.push({ block, message: err.message });
    }
}

/**
 * @param {Uint8Array} bytes  a raw 64 KB or 128 KB SRAM dump
 * @param {{rom?: Uint8Array | null}} [options]  the Dezaemon ROM, to cross-check
 * @returns {SfcSave}
 */
export function parseSfcSav(bytes, { rom = null } = {}) {
    const result = /** @type {SfcSave} */ ({
        size: bytes.length,
        sizeOk: ACCEPTED_SIZES.includes(bytes.length),
        complete: bytes.length >= SRAM_SIZE,
        checkString: readCheckString(bytes),
        checkStringOk: hasCheckString(bytes),
        isSfcSav: isSfcSav(bytes),
        segments: splitSegments(bytes),
        confidence: {},
        errors: [],
        checksum: null,
        palettes: null,
        maps: null,
        scroll: null,
        groups: null,
        hiScores: null,
        config: null,
        sound: null,
        enemies: null,
        appear: null,
        graphics: null,
        regions: SFC_REGIONS,
        rom: null,
        /** The dump itself and, when given, the ROM — what drawing a chip needs. */
        bytes,
        romBytes: rom || null,
    });
    attempt(result, "checksum", () => {
        const blocks = readChecksumBlocks(bytes);
        // The seventeen words recomputed; a 64 KB dump cannot be verified
        // (word 0 sums the graphics bank), so `verified` is null for it.
        let verified = null;
        try {
            verified = bytes.length >= SRAM_SIZE ? verifySfcChecksums(bytes) : null;
        } catch {
            verified = null;
        }
        return { ...blocks, verified };
    });
    attempt(result, "palettes", () => decodePaletteData(bytes));
    attempt(result, "maps", () => decodeMapData(bytes));
    attempt(result, "scroll", () => decodeScrollEffect(bytes));
    attempt(result, "groups", () => decodeGroups(bytes));
    attempt(result, "hiScores", () => decodeHiScores(bytes));
    attempt(result, "config", () => decodeConfig(bytes));
    attempt(result, "sound", () => sliceSound(bytes));
    attempt(result, "enemies", () => decodeEnemyData(bytes));
    attempt(result, "appear", () => decodeAppearData(bytes));
    attempt(result, "graphics", () => decodeGraphics(bytes));
    result.confidence = {
        checksum: REGION.checksum.confidence,
        palettes: REGION.palette.confidence,
        maps: REGION.map.confidence,
        scroll: REGION.scroll.confidence,
        groups: REGION.mapGroup.confidence,
        hiScores: REGION.hiScore.confidence,
        config: REGION.titleType.confidence,
        sound: REGION.sound.confidence,
        enemies: REGION.enemyData.confidence,
        appear: REGION.appear.confidence,
        graphics: REGION.graphics.confidence,
    };
    if (rom) {
        attempt(result, "rom", () => {
            const header = readRomHeader(rom);
            const table = parseRomRegionTable(rom);
            return {
                header,
                isDezaemon: isDezaemonRom(rom),
                regionTable: table,
                regionTableMatches: regionTableMatches(table),
                defaultImage: compareWithRomDefault(bytes, rom),
            };
        });
    }
    return result;
}

/**
 * A one-screen summary of a parse, for CLIs and logs.
 * @param {SfcSave} parsed
 */
export function summarizeSfcSav(parsed) {
    const lines = [];
    lines.push(`size ${parsed.size} (${parsed.sizeOk ? "ok" : "unexpected"}), check string ${JSON.stringify(parsed.checkString)}${parsed.checkStringOk ? "" : ` (expected ${CHECK_STRING})`}`);
    lines.push(`segments: ${parsed.segments.map((s) => `$${s.bank.toString(16)} ${!s.present ? "absent" : s.blank ? "blank" : "data"}`).join(", ")}`);
    if (parsed.checksum) {
        const v = parsed.checksum.verified;
        lines.push(`checksum copy ${parsed.checksum.equal ? "matches" : "DIFFERS"}${v ? `; ${v.ok ? "all 17 words verify" : `${v.words.filter((w) => !w.ok).length} of 17 words FAIL (${v.words.filter((w) => !w.ok).map((w) => w.name).join(", ")})`}` : ""}`);
    }
    if (parsed.palettes) lines.push(`palettes: ${parsed.palettes.colorRowCount}/${parsed.palettes.rows.length} rows are colour words`);
    if (parsed.maps) lines.push(`maps: ${parsed.maps.map((m) => m.used).join("/")} cells used per stage`);
    if (parsed.groups) {
        const chips = (list) => list.filter((c) => !c.empty).length;
        const romArt = parsed.groups.map.some((g) => g.chips.some((c) => c.rom)) || parsed.groups.myShip.some((c) => c.rom);
        lines.push(`chips: map ${parsed.groups.map.map((g) => chips(g.chips)).join("/")}, enemies ${parsed.groups.enemy.map((g) => chips(g.chips)).join("/")}, bosses ${parsed.groups.boss.map((g) => chips(g.chips)).join("/")}, ship ${chips(parsed.groups.myShip)}, title ${chips(parsed.groups.title)}; art ${romArt ? "partly from the ROM's sheets" : "from the save's sheets"}`);
    }
    if (parsed.hiScores) lines.push(`hi-scores: ${parsed.hiScores.slice(0, 3).map((h) => `${h.score} ${h.name.trim() || "-"}`).join(", ")} …`);
    if (parsed.enemies) lines.push(`enemies: ${parsed.enemies.map((e) => e.used).join("/")} entries per stage${parsed.appear ? `; spawn lines ${parsed.appear.map((a) => a.used).join("/")}` : ""}`);
    if (parsed.graphics) lines.push(`graphics: ${!parsed.graphics.present ? "absent (64 KB dump)" : parsed.graphics.blank ? "blank" : `${parsed.graphics.usedCount} tiles in use`}`);
    if (parsed.rom) {
        const r = parsed.rom;
        lines.push(`rom: ${r.header.title} sram ${r.header.sramSizeBytes} B, region table ${r.regionTableMatches.matches ? "matches" : "DIFFERS"}, default image ${r.defaultImage.identical ? "identical" : `${r.defaultImage.equal}/${r.defaultImage.total} bytes equal`}`);
    }
    for (const e of parsed.errors) lines.push(`error in ${e.block}: ${e.message}`);
    return lines.join("\n");
}

export { CONFIDENCES, coverage, regionFor, regionStats };
