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
export * from "./rom.js";

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
    });
    attempt(result, "checksum", () => readChecksumBlocks(bytes));
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
    if (parsed.checksum) lines.push(`checksum copy ${parsed.checksum.equal ? "matches" : "DIFFERS"}`);
    if (parsed.palettes) lines.push(`palettes: ${parsed.palettes.colorRowCount}/${parsed.palettes.rows.length} rows are colour words`);
    if (parsed.maps) lines.push(`maps: ${parsed.maps.map((m) => m.used).join("/")} cells used per stage`);
    if (parsed.hiScores) lines.push(`hi-scores: ${parsed.hiScores.slice(0, 3).map((h) => `${h.score} ${h.name.trim() || "-"}`).join(", ")} …`);
    if (parsed.enemies) lines.push(`enemies: ${parsed.enemies.filter((e) => !e.blank).length}/${parsed.enemies.length} records in use`);
    if (parsed.graphics) lines.push(`graphics: ${!parsed.graphics.present ? "absent (64 KB dump)" : parsed.graphics.blank ? "blank" : `${parsed.graphics.usedCount} tiles in use`}`);
    if (parsed.rom) {
        const r = parsed.rom;
        lines.push(`rom: ${r.header.title} sram ${r.header.sramSizeBytes} B, region table ${r.regionTableMatches.matches ? "matches" : "DIFFERS"}, default image ${r.defaultImage.identical ? "identical" : `${r.defaultImage.equal}/${r.defaultImage.total} bytes equal`}`);
    }
    for (const e of parsed.errors) lines.push(`error in ${e.block}: ${e.message}`);
    return lines.join("\n");
}

export { CONFIDENCES, coverage, regionFor, regionStats };
