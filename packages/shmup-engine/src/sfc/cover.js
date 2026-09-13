// Compose a 256x480 cover from parseSfcSav() output — the picture a Super
// Famicom cart wears on the shelf.
//
// The Saturn sequel's cover (src/cover/compose-cover.js) is the drawn KUMITATE
// TITLE page over a screenful of scenery, and that shape does not carry over.
// TITLE GROUP here is eight quads, not a page, and rendering them does not
// produce a logo: ALDI Adventure's eight come out as eight unrelated 16x16
// fragments of crate and stripe, while the drawn "ALDI Adventure /
// NOVASQUIRREL.COM" banner that is plainly in the graphics bank goes unclaimed.
// That is consistent with what FORMAT-SFC.md already says — a group's tile
// numbers are read as indices into the FLAT bank, and the bank's real layout is
// still `open`, so quads outside MAP GROUP land on the wrong tiles. Until that
// is pinned down, a title layer would composite garbage over the scenery, so
// the cover is the game's own scenery and only that.
//
// WHY 256x480, WHICH IS NOT A SNES SCREEN
// Every shelf surface — the launcher's coverflow, the editor's LOAD GAME
// drawer, the eShop rows — is laid out for the 256x480 portrait covers the
// Saturn library ships. A cover of a different aspect would be the one row
// that letterboxes, so the geometry is chosen to land on those numbers
// honestly rather than by stretching:
//
//   width   MAP DATA strides 18 chips (288 px) but only columns 1-15 are ever
//           drawn — measured over both dumps, columns 0 and 16 hold no non-zero
//           cell in any of their twelve stages and 17 is sparse. Columns 0-15
//           are therefore the whole drawn field plus the 16 px left margin the
//           Saturn composer also leaves (BG_X), and they are exactly 256 px.
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

import { assemble2x2, flipTile, withPaletteRow } from "./tiles.js";
import { indexedToRgba } from "../decode/decode-cg.js";
import { MAP_COLUMNS } from "./map.js";

export const SFC_COVER_W = 256;
export const SFC_COVER_H = 480;
export const SFC_COVER_CHIP = 16;
/** Map columns the cover crops to: 0..15, the drawn field plus its left margin. */
export const SFC_COVER_COLUMNS = SFC_COVER_W / SFC_COVER_CHIP; // 16
/** Map rows one cover shows. */
export const SFC_COVER_ROWS = SFC_COVER_H / SFC_COVER_CHIP; // 30

/**
 * The three things a chip needs to become pixels. Null when any is missing —
 * a 64 KB dump has no GRAPIC DATA at all, and a cart whose graphics bank is
 * blank has nothing to draw either.
 */
function art(parsed) {
    const { graphics, groups, palettes } = parsed ?? {};
    if (!graphics || graphics.blank || !groups?.map || !palettes) return null;
    return { tiles: graphics.tiles, chips: groups.map, palettes: palettes.palettes };
}

/**
 * One 16x16 background chip as RGBA, through its OWN palette row.
 *
 * tools/sfc-sav renders every quad through one row chosen on the command line,
 * which is right for a probe comparing rows and wrong for a picture: the row
 * is in the tilemap word (bits 10-12), and `classifyQuad` only calls a quad a
 * chip when all four words agree on it, so the first non-empty entry speaks
 * for the quad.
 */
export function chipRgba(art, entries) {
    const blank = new Uint8Array(64);
    const pieces = entries.map((e) =>
        e.empty || e.tile >= art.tiles.length ? blank : flipTile(art.tiles[e.tile], e.hflip, e.vflip)
    );
    const row = entries.find((e) => !e.empty)?.palette ?? 0;
    return indexedToRgba(withPaletteRow(assemble2x2(pieces), row), art.palettes);
}

/**
 * How many drawn cells a 30-row window of one stage holds, counting only the
 * columns the cover shows. Bit 7 of a cell is not the chip index (FORMAT-SFC
 * "MAP DATA"), so it is masked off before a cell counts as used.
 */
export function windowCells(map, top) {
    let n = 0;
    for (let r = top; r < top + SFC_COVER_ROWS && r < map.rows; r++) {
        for (let c = 0; c < SFC_COVER_COLUMNS; c++) {
            if (map.cells[r * MAP_COLUMNS + c] & 0x7f) n++;
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

    // Colour 0 of row 0 is the SNES backdrop — what the PPU shows wherever no
    // BG tile is drawn, which on a Dezaemon stage is most of the sky. Filling
    // with it is what makes the cover the game's own colour rather than a
    // transparent PNG that the shelf's background shows through.
    const back = a.palettes[0]?.colors?.[0] ?? { r: 0, g: 0, b: 0 };
    const canvas = new Uint8ClampedArray(SFC_COVER_W * SFC_COVER_H * 4);
    for (let i = 0; i < SFC_COVER_W * SFC_COVER_H; i++) {
        canvas[i * 4] = back.r;
        canvas[i * 4 + 1] = back.g;
        canvas[i * 4 + 2] = back.b;
        canvas[i * 4 + 3] = 255;
    }

    const map = parsed.maps[pick.stage];
    for (let r = 0; r < SFC_COVER_ROWS; r++) {
        const row = pick.top + r;
        if (row >= map.rows) break;
        for (let c = 0; c < SFC_COVER_COLUMNS; c++) {
            const cell = map.cells[row * MAP_COLUMNS + c] & 0x7f;
            if (!cell) continue;
            const chip = a.chips[cell];
            if (!chip) continue;
            blitChip(canvas, c * SFC_COVER_CHIP, r * SFC_COVER_CHIP, chipRgba(a, chip.entries));
        }
    }
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
