// Compose a 256x480 cover from parseSfcSav() output — the picture a Super
// Famicom cart wears on the shelf.
//
// The Saturn sequel's cover (src/cover/compose-cover.js) is the drawn KUMITATE
// TITLE page over a screenful of scenery. Here the cover is the scenery alone:
// the stage map drawn through its MAP GROUP chips and its own palette row,
// from the save's sheets or, when the parse was given the ROM, the factory
// sheets the sample game draws from. TITLE GROUP is a 32-chip picture the
// title screen animates; compositing it over scenery is not what the game
// shows either, so it stays out.
//
// WHY 256x480, WHICH IS NOT A SNES SCREEN
// Every shelf surface — the launcher's coverflow, the editor's LOAD GAME
// drawer, the eShop rows — is laid out for the 256x480 portrait covers the
// Saturn library ships. A cover of a different aspect would be the one row
// that letterboxes, so the geometry is chosen to land on those numbers
// honestly rather than by stretching:
//
//   width   a stage is 16 chips (256 px) wide, exactly the cover's width.
//   height  30 rows of 16 px. The map is 128 rows tall, so the window slides.
//
// WHICH 30 ROWS
// The busiest one, over every stage: the window with the most non-zero cells,
// earliest stage and lowest row winning ties. A Dezaemon stage is mostly empty
// sky — ALDI Adventure's stage 0 uses 1,234 of 2,304 cells and they are not
// spread evenly — so the first screenful is usually a poor portrait of the
// game and the densest one is usually its set piece.
//
// Pure data -> RGBA, like its Saturn counterpart: no canvas, no network, no
// DOM. Environment-neutral ESM (Node + browser).

import { indexedToRgba } from "../decode/decode-cg.js";
import { MAP_COLUMNS } from "./map.js";
import { decodeChipPixels, flipChip } from "./chips.js";
import { withPaletteRow } from "./tiles.js";

export const SFC_COVER_W = 256;
export const SFC_COVER_H = 480;
export const SFC_COVER_CHIP = 16;
/** Map columns the cover shows: all 16 of the playfield. */
export const SFC_COVER_COLUMNS = SFC_COVER_W / SFC_COVER_CHIP; // 16
/** Map rows one cover shows. */
export const SFC_COVER_ROWS = SFC_COVER_H / SFC_COVER_CHIP; // 30

/**
 * What a chip needs to become pixels: the save's bytes (its own sheets), the
 * ROM's when the parse was given them (the factory sheets), the palettes and
 * the six MAP GROUP tables. Null for a 64 KB dump, which has no sheets.
 */
function art(parsed) {
    const { graphics, groups, palettes, bytes, romBytes } = parsed ?? {};
    if (!graphics || !graphics.present || !groups?.map || !palettes || !bytes) return null;
    return { sram: bytes, rom: romBytes ?? null, groups: groups.map, palettes: palettes.palettes };
}

/**
 * One 16x16 chip as RGBA through palette row `row` (a stage's scenery row
 * is its number), or null when the chip's sheet is not at hand — a ROM chip
 * with no ROM given, or an empty word.
 */
export function chipRgba(art, word, row, { hflip = false, vflip = false } = {}) {
    const px = decodeChipPixels(word, { sram: art.sram, rom: art.rom });
    if (!px) return null;
    return chipThroughRow(flipChip(px, hflip, vflip), art.palettes, row);
}

/**
 * 256 chip indices through one of the 24 palette rows. indexedToRgba takes
 * an 8-bit index (row << 4 | colour), which reaches rows 0-15 only; a row is
 * therefore handed to it on its own, as row 0 of a one-row bank.
 */
export function chipThroughRow(px, palettes, row) {
    return indexedToRgba(withPaletteRow(px, 0), [palettes[row] ?? palettes[0]]);
}

/**
 * How many drawn cells a 30-row window of one stage holds: cells naming a
 * MAP GROUP slot other than 0, the blank one by the editor's convention.
 */
export function windowCells(map, top) {
    let n = 0;
    for (let r = top; r < top + SFC_COVER_ROWS && r < map.rows; r++) {
        for (let c = 0; c < SFC_COVER_COLUMNS; c++) {
            if (map.slots[r * MAP_COLUMNS + c]) n++;
        }
    }
    return n;
}

/**
 * The busiest window across every stage: `{ stage, top, cells }`, or null when
 * no stage has a single drawn cell in the cropped columns.
 *
 * Ties go to the earliest stage and then the lowest row, so the same cart
 * always produces the same cover — the upload ledger compares cover hashes to
 * decide what to re-publish, and a cover that moved on a coin toss would
 * re-upload the whole library.
 */
export function pickSfcCoverWindow(maps, { stage = null } = {}) {
    const list = (maps ?? []).map((m, i) => ({ map: m, stage: i }))
        .filter(({ map, stage: i }) => map && (stage === null || stage === i));
    let best = null;
    for (const { map, stage: i } of list) {
        const last = Math.max(map.rows - SFC_COVER_ROWS, 0);
        for (let top = 0; top <= last; top++) {
            const cells = windowCells(map, top);
            if (best && cells <= best.cells) continue;
            best = { stage: i, top, cells };
        }
    }
    return best && best.cells > 0 ? best : null;
}

/** src-over of one chip's RGBA into the cover canvas. */
function blitChip(canvas, x, y, rgba) {
    for (let r = 0; r < SFC_COVER_CHIP; r++) {
        const ty = y + r;
        if (ty < 0 || ty >= SFC_COVER_H) continue;
        for (let c = 0; c < SFC_COVER_CHIP; c++) {
            const tx = x + c;
            if (tx < 0 || tx >= SFC_COVER_W) continue;
            const s = (r * SFC_COVER_CHIP + c) * 4;
            if (!rgba[s + 3]) continue;
            const d = (ty * SFC_COVER_W + tx) * 4;
            canvas[d] = rgba[s];
            canvas[d + 1] = rgba[s + 1];
            canvas[d + 2] = rgba[s + 2];
            canvas[d + 3] = 255;
        }
    }
}

/**
 * The cover for one parsed SRAM dump, or null when the save holds no picture
 * of itself — a 64 KB dump (no graphics bank), a blank bank, or a cart whose
 * stages are all empty. Null rather than a placeholder on purpose: the shelf
 * draws its own text card for a coverless row, and a grey rectangle published
 * as a cover would be indistinguishable from a real one that failed.
 *
 * @param {import("./index.js").SfcSave} parsed
 * @param {{stage?: number|null}} [options]  pin the stage instead of taking the busiest
 * @returns {{w:number,h:number,rgba:Uint8ClampedArray,stage:number,top:number,cells:number,source:string}|null}
 */
export function composeSfcCover(parsed, { stage = null } = {}) {
    const a = art(parsed);
    if (!a) return null;
    const pick = pickSfcCoverWindow(parsed.maps, { stage });
    if (!pick) return null;

    // Row 0's first word is the SNES backdrop — what the PPU shows wherever no
    // BG tile is drawn, which on a Dezaemon stage is most of the sky. Filling
    // with it is what makes the cover the game's own colour rather than a
    // transparent PNG that the shelf's background shows through. (The rows
    // come laid out as the console draws them, word 0 at colour 1.)
    const back = a.palettes[0]?.colors?.[1] ?? { r: 0, g: 0, b: 0 };
    const canvas = new Uint8ClampedArray(SFC_COVER_W * SFC_COVER_H * 4);
    for (let i = 0; i < SFC_COVER_W * SFC_COVER_H; i++) {
        canvas[i * 4] = back.r;
        canvas[i * 4 + 1] = back.g;
        canvas[i * 4 + 2] = back.b;
        canvas[i * 4 + 3] = 255;
    }

    const map = parsed.maps[pick.stage];
    const group = a.groups[pick.stage].chips;
    let drawn = 0;
    for (let r = 0; r < SFC_COVER_ROWS; r++) {
        const row = pick.top + r;
        if (row >= map.rows) break;
        for (let c = 0; c < SFC_COVER_COLUMNS; c++) {
            const i = row * MAP_COLUMNS + c;
            const slot = map.slots[i];
            if (!slot) continue;
            const chip = group[slot];
            if (!chip || chip.empty) continue;
            const px = decodeChipPixels(chip.word, { sram: a.sram, rom: a.rom });
            if (!px || !px.some((v) => v)) continue; // not at hand, or every pixel transparent
            const rgba = chipThroughRow(flipChip(px, !!map.hflips[i], !!map.vflips[i]), a.palettes, pick.stage);
            blitChip(canvas, c * SFC_COVER_CHIP, r * SFC_COVER_CHIP, rgba);
            drawn++;
        }
    }
    // A cart whose scenery lives in the ROM's sheets, parsed without the ROM,
    // or whose own sheets are blank, has drawn nothing: say so rather than
    // publish a flat backdrop.
    if (!drawn) return null;
    return {
        w: SFC_COVER_W,
        h: SFC_COVER_H,
        rgba: canvas,
        stage: pick.stage,
        top: pick.top,
        cells: pick.cells,
        source: "scenery",
    };
}
