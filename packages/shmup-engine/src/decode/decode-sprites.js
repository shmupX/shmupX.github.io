// Dezaemon 2 enemy sprite extraction.
//
// Each stage's sprite composition bank (sec5 + 0x5D660 + stage*0x580) holds
// 704 u16be cell refs. The layout is engine-traced, not guessed: GAME.CMP's
// stage-art upload routine (file +0x4000, loads at 0x06068000) walks a flat
// 221-entry char-slot table (0x0608C070) of (geometry index, bank byte
// offset) pairs, with per-slot pixel sizes in a geometry table (0x06089CFC).
// Those tables pin the whole bank:
//
//   records  frames  frame size  bank bytes
//   0-15     4       16x16       0x000-0x07F
//   16-23    4       32x16       0x080-0x0FF
//   24-31    4       16x32       0x100-0x17F
//   32-47    4       32x32       0x180-0x37F
//   48-51    2       64x32       0x380-0x3FF
//   52-55    2       32x64       0x400-0x47F
//   56-59    1       64x64       0x480-0x4FF
//   boss     (class) see below   0x500-0x57F
//
// The last 64 refs are the boss core, and the placement id's size class
// (0xF0-0xF3) picks its geometry via the engine's (start,end) pair table
// (slots 212-220): F0 = four 64x64 frames, F1 = two 128x64, F2 = two 64x128,
// F3 = one 128x128. A frame's cells are read row-major at its fixed width.
//
// Composition words: bits 0-9 = CG cell index, bit14 = H-flip, bit15 =
// V-flip, 0xFFFF = empty — the SAME convention as the background tilemap.
// Verified by rendering: the sprite banks' pervasive mirror pairs only
// compose under bit14 = H, and the background's mirror-symmetric chambers
// (Ramsie stages 0/3/4) only compose under bit14 = H as well.
//
// Environment-neutral ESM (Node + browser).

import { cellIndexed, indexedToRgba, CG_CELL_DIM } from "./decode-cg.js";
import { SEC5_REGIONS } from "./decode-stage.js";

// Per-record art bands: `first` record, id `count`, animation `frames`, and
// frame size in cells. Byte offsets follow from the running total.
export const RECORD_ART = [
    { first: 0, count: 16, frames: 4, w: 1, h: 1, base: 0x000 },
    { first: 16, count: 8, frames: 4, w: 2, h: 1, base: 0x080 },
    { first: 24, count: 8, frames: 4, w: 1, h: 2, base: 0x100 },
    { first: 32, count: 16, frames: 4, w: 2, h: 2, base: 0x180 },
    { first: 48, count: 4, frames: 2, w: 4, h: 2, base: 0x380 },
    { first: 52, count: 4, frames: 2, w: 2, h: 4, base: 0x400 },
    { first: 56, count: 4, frames: 1, w: 4, h: 4, base: 0x480 },
];

// Boss core geometry per placement size class (0xF0 + class).
export const BOSS_CORE_OFFSET = 0x500;
export const BOSS_CORE_GEOM = [
    { frames: 4, w: 4, h: 4 }, // F0: four 64x64
    { frames: 2, w: 8, h: 4 }, // F1: two 128x64
    { frames: 2, w: 4, h: 8 }, // F2: two 64x128
    { frames: 1, w: 8, h: 8 }, // F3: one 128x128
];

export const EMPTY_REF = 0xffff;

// Record index -> its art band, or null past the 60 zako records.
export function recordArt(record) {
    for (const band of RECORD_ART) {
        if (record >= band.first && record < band.first + band.count) return band;
    }
    return null;
}

// Kept for callers that still think in (class, slot): the class is the art
// band index, the slot the record's position inside it.
export function recordToClassSlot(record) {
    const band = recordArt(record);
    if (!band) return null;
    return { cls: RECORD_ART.indexOf(band), slot: record - band.first };
}

function decodeWord(word) {
    return {
        empty: word === EMPTY_REF,
        cell: word & 0x3ff,
        hflip: (word & 0x4000) !== 0,
        vflip: (word & 0x8000) !== 0,
    };
}

function readWords(sec5, stage, byteOffset, count) {
    const { offset, stride } = SEC5_REGIONS.spriteStages;
    const base = offset + stage * stride + byteOffset;
    const words = [];
    for (let k = 0; k < count; k++) {
        const at = base + k * 2;
        words.push((sec5[at] << 8) | sec5[at + 1]);
    }
    return words;
}

// Read one enemy's frames out of a stage's composition bank.
// Returns null when the record holds no art there.
export function readEnemyFrames(sec5, stage, record) {
    const band = recordArt(record);
    if (!band) return null;
    const cellsPerFrame = band.w * band.h;
    const byteOffset = band.base + (record - band.first) * band.frames * cellsPerFrame * 2;
    const words = readWords(sec5, stage, byteOffset, band.frames * cellsPerFrame);
    if (words.every((w) => w === EMPTY_REF)) return null;

    const frames = [];
    for (let f = 0; f < band.frames; f++) {
        const cells = words.slice(f * cellsPerFrame, (f + 1) * cellsPerFrame).map(decodeWord);
        if (cells.every((c) => c.empty)) continue;
        frames.push({ w: band.w, h: band.h, cells });
    }
    return frames.length ? { record, w: band.w, h: band.h, frames } : null;
}

// A core frame's refs are stored as 4x4-cell (64x64 px) sub-blocks in
// reading order, cells row-major inside each block — for class 1 a frame is
// [left block][right block], for class 3 the four quadrants. Classes 0 and 2
// are one block wide, where block order coincides with plain row-major
// (which is why single-save evidence never exposed the difference; the
// corpus's class 1/3 cores only compose this way).
export function coreCellOrder(w, h) {
    const order = [];
    const blocksPerRow = w / 4;
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const block = (y >> 2) * blocksPerRow + (x >> 2);
            order.push(block * 16 + (y & 3) * 4 + (x & 3));
        }
    }
    return order;
}

// Read one stage's boss core for a given size class, or null when unpainted.
export function readBossCore(sec5, stage, sizeClass) {
    const geom = BOSS_CORE_GEOM[sizeClass & 3];
    const cellsPerFrame = geom.w * geom.h;
    const words = readWords(sec5, stage, BOSS_CORE_OFFSET, geom.frames * cellsPerFrame);
    if (words.every((w) => w === EMPTY_REF)) return null;
    const order = coreCellOrder(geom.w, geom.h);
    const frames = [];
    for (let f = 0; f < geom.frames; f++) {
        const frameWords = words.slice(f * cellsPerFrame, (f + 1) * cellsPerFrame);
        const cells = order.map((i) => decodeWord(frameWords[i]));
        if (cells.every((c) => c.empty)) continue;
        frames.push({ w: geom.w, h: geom.h, cells });
    }
    return frames.length ? { stage, sizeClass, w: geom.w, h: geom.h, frames } : null;
}

// Rasterise one frame to RGBA using the CG pages and palette bank.
export function renderFrame(sections, palettes, frame) {
    const pxW = frame.w * CG_CELL_DIM;
    const pxH = frame.h * CG_CELL_DIM;
    const indexed = new Uint8Array(pxW * pxH);
    frame.cells.forEach((c, i) => {
        if (c.empty) return;
        const cell = cellIndexed(sections, c.cell);
        const ox = (i % frame.w) * CG_CELL_DIM;
        const oy = ((i / frame.w) | 0) * CG_CELL_DIM;
        for (let y = 0; y < CG_CELL_DIM; y++) {
            for (let x = 0; x < CG_CELL_DIM; x++) {
                const sx = c.hflip ? CG_CELL_DIM - 1 - x : x;
                const sy = c.vflip ? CG_CELL_DIM - 1 - y : y;
                indexed[(oy + y) * pxW + ox + x] = cell[sy * CG_CELL_DIM + sx];
            }
        }
    });
    return { w: pxW, h: pxH, rgba: indexedToRgba(indexed, palettes) };
}

// The CG editor fills never-drawn cells with a placeholder glyph, and unused
// sprite slots point every ref at it. Find it as the most-referenced cell
// across the whole bank — in the sample games it is referenced hundreds of
// times, an order of magnitude more than any real sprite cell.
export function findPlaceholderCell(sec5, stageCount = 10) {
    const { offset, stride } = SEC5_REGIONS.spriteStages;
    const freq = new Map();
    for (let st = 0; st < stageCount; st++) {
        for (let i = 0; i < stride / 2; i++) {
            const at = offset + st * stride + i * 2;
            const word = ((sec5[at] << 8) | sec5[at + 1]) & 0xffff;
            if (word === EMPTY_REF) continue;
            const cell = word & 0x3ff;
            freq.set(cell, (freq.get(cell) || 0) + 1);
        }
    }
    let best = null;
    let bestN = 0;
    for (const [cell, n] of freq) if (n > bestN) { best = cell; bestN = n; }
    return { cell: best, count: bestN };
}

// A slot is "unpainted" when every one of its refs is the placeholder.
function isUnpainted(art, placeholder) {
    if (placeholder === null) return false;
    return art.frames.every((f) => f.cells.every((c) => c.empty || c.cell === placeholder));
}

// A composition's identity: the cell refs (with flips) of every frame. Two
// (stage, record) pairs that share one render to the same pixels, so they can
// share atlas frames instead of packing the same art twice — DAIOH's 327
// painted pairs collapse onto 160 distinct compositions this way.
function artSignature(art) {
    return art.frames
        .map((f) => f.cells.map((c) => (c.empty ? "-" : `${c.cell}${c.hflip ? "h" : ""}${c.vflip ? "v" : ""}`)).join(","))
        .join("|");
}

// Build the sprite list + per-enemy frame keys for the editor.
//
// `enemies` is the roster from projectForEditor() — one entry per placed
// (stage, record) pair, each carrying its own stage, so each enemy is drawn
// with the art ITS stage defines rather than whichever stage happened to come
// first. `stagesPlacing` maps a record to every stage that places it, so a
// pair whose own stage left the sprite slot unpainted still falls back to a
// stage that drew it.
//
// Returns {sprites, spriteKeysByEnemy} keyed by enemy.key ("stage:record").
export function extractEnemySprites(sec5, sections, palettes, enemies, stagesPlacing) {
    const sprites = [];
    const spriteKeysByEnemy = new Map();
    const bySignature = new Map(); // composition -> sprite indices already packed
    const placeholder = findPlaceholderCell(sec5).cell;
    for (const enemy of enemies) {
        // The enemy's own stage first; only then any other stage that places
        // the same record (art is per stage, and slots can be left unpainted).
        const fallbacks = stagesPlacing.get(enemy.record) || [];
        const candidates = [enemy.stage, ...fallbacks.filter((s) => s !== enemy.stage)];
        let art = null;
        for (const stage of candidates) {
            if (stage === undefined) continue;
            const a = readEnemyFrames(sec5, stage, enemy.record);
            if (!a) continue;
            if (!isUnpainted(a, placeholder)) { art = a; break; }
            if (!art) art = a; // remember the placeholder art as a last resort
        }
        if (!art || isUnpainted(art, placeholder)) continue;

        const sig = artSignature(art);
        const shared = bySignature.get(sig);
        if (shared) {
            spriteKeysByEnemy.set(enemy.key, shared);
            continue;
        }
        const keys = [];
        art.frames.forEach((frame, i) => {
            const { w, h, rgba } = renderFrame(sections, palettes, frame);
            // fully transparent frames add nothing to the atlas
            let opaque = false;
            for (let p = 3; p < rgba.length; p += 4) if (rgba[p]) { opaque = true; break; }
            if (!opaque) return;
            keys.push(sprites.length);
            sprites.push({ key: `${enemy.name}_${i}`, w, h, rgba });
        });
        if (!keys.length) continue;
        bySignature.set(sig, keys);
        spriteKeysByEnemy.set(enemy.key, keys);
    }
    return { sprites, spriteKeysByEnemy };
}


// --- Stage backgrounds -------------------------------------------------
//
// Each stage's background is 14x768 tiles of 16x16 CG cells (decode-stage.js).
// For the editor/runtime the tilemap is exported as (a) one RGBA sprite per
// DISTINCT cell any used stage references, and (b) a compact per-stage grid of
// words that index that list (bits 0-9 ordinal, bit15 hflip, bit14 vflip,
// 0xFFFF empty). Flips stay in the grid, so a cell mirrored both ways still
// costs one sprite. (This projected word format is the runtime's own — its
// bit15 = hflip regardless of how the raw save encodes flips.)
//
// Returns {cells: [{key,w,h,rgba}], stages: [{rows, words: Uint16Array}|null]}
// where words is rows*14 long and `rows` is trimmed to the last non-empty row.
export function extractBackgroundCells(backgrounds, sections, palettes, stageCount) {
    const ordinalByCell = new Map();
    const cells = [];
    const stages = [];
    for (let s = 0; s < stageCount; s++) {
        const bg = backgrounds[s];
        if (!bg || bg.empty) { stages.push(null); continue; }
        // trim to the used extent — most stages stop well short of row 768
        let lastRow = -1;
        for (let i = 0; i < bg.tiles.length; i++) {
            if (bg.tiles[i]) lastRow = Math.max(lastRow, (i / bg.cols) | 0);
        }
        if (lastRow < 0) { stages.push(null); continue; }
        const rows = lastRow + 1;
        const words = new Uint16Array(rows * bg.cols).fill(0xffff);
        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < bg.cols; c++) {
                const t = bg.tiles[r * bg.cols + c];
                if (!t) continue;
                if (!ordinalByCell.has(t.cell)) {
                    ordinalByCell.set(t.cell, cells.length);
                    const indexed = cellIndexed(sections, t.cell);
                    cells.push({
                        key: `dezaBgCell${t.cell}`,
                        w: CG_CELL_DIM,
                        h: CG_CELL_DIM,
                        rgba: indexedToRgba(indexed, palettes),
                    });
                }
                words[r * bg.cols + c] = ordinalByCell.get(t.cell) |
                    (t.hflip ? 0x8000 : 0) | (t.vflip ? 0x4000 : 0);
            }
        }
        stages.push({ rows, cols: bg.cols, words });
    }
    return { cells, stages };
}

// --- Title art --------------------------------------------------------
//
// The KUMITATE editor's TITLE page: a save's title screen is DRAWN — no
// title text exists anywhere in the data (FORMAT.md). The compositions live
// in the tail of the global sprite bank (+0x5D490, 232 u16be refs), laid out
// row-major at 8 cells wide. Verified by rendering: Ramsie's script + winged
// emblem and DEVIL BLADE 2's logo pieces compose cleanly at these slots:
//
//   refs 144-167   TITLE 1, 8x3 cells (128x48 px)
//   refs 168-207   TITLE 2, 8x5 cells (128x80 px)
//   refs 208-231   3 credit strips, 8x1 cells (128x16 px) each
export const TITLE_SLOTS = {
    title1: { first: 144, w: 8, h: 3 },
    title2: { first: 168, w: 8, h: 5 },
    credits: [{ first: 208, w: 8, h: 1 }, { first: 216, w: 8, h: 1 }, { first: 224, w: 8, h: 1 }],
};

function readBankComposition(sec5, slot) {
    const { offset } = SEC5_REGIONS.spriteBank;
    const cells = [];
    for (let i = 0; i < slot.w * slot.h; i++) {
        const at = offset + (slot.first + i) * 2;
        cells.push(decodeWord((sec5[at] << 8) | sec5[at + 1]));
    }
    if (cells.every((c) => c.empty)) return null;
    return { w: slot.w, h: slot.h, cells };
}

// Crop a rendered RGBA to its opaque bounding box so a logo drawn in a
// corner of its slot still centers cleanly on the title screen.
function trimRgba(img) {
    let minX = img.w, minY = img.h, maxX = -1, maxY = -1;
    for (let y = 0; y < img.h; y++) {
        for (let x = 0; x < img.w; x++) {
            if (img.rgba[(y * img.w + x) * 4 + 3]) {
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;
            }
        }
    }
    if (maxX < 0) return null;
    const w = maxX - minX + 1;
    const h = maxY - minY + 1;
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
        const src = ((minY + y) * img.w + minX) * 4;
        rgba.set(img.rgba.subarray(src, src + w * 4), y * w * 4);
    }
    return { w, h, rgba };
}

// Extract the drawn title compositions. Returns {sprites, roles} where roles
// maps title1/title2/credit onto indices into `sprites` (absolute once the
// caller adds `baseIndex`). The credit is the save's distinct non-empty
// credit strips stacked vertically (Ramsie repeats one author line three
// times; stacking distinct lines keeps a multi-line staff block intact).
export function extractTitleArt(sec5, sections, palettes, baseIndex) {
    const sprites = [];
    const roles = {};
    const placeholder = findPlaceholderCell(sec5).cell;
    const renderSlot = (slot) => {
        const comp = readBankComposition(sec5, slot);
        if (!comp || isUnpainted({ frames: [comp] }, placeholder)) return null;
        return trimRgba(renderFrame(sections, palettes, comp));
    };
    const title1 = renderSlot(TITLE_SLOTS.title1);
    if (title1) {
        roles.title1 = baseIndex + sprites.length;
        sprites.push({ key: "dezaTitle1", ...title1 });
    }
    const title2 = renderSlot(TITLE_SLOTS.title2);
    if (title2) {
        roles.title2 = baseIndex + sprites.length;
        sprites.push({ key: "dezaTitle2", ...title2 });
    }
    const lines = [];
    const seen = new Set();
    for (const slot of TITLE_SLOTS.credits) {
        const line = renderSlot(slot);
        if (!line) continue;
        const sig = line.rgba.join();
        if (seen.has(sig)) continue;
        seen.add(sig);
        lines.push(line);
    }
    if (lines.length) {
        const w = Math.max(...lines.map((l) => l.w));
        const h = lines.reduce((sum, l) => sum + l.h, 0);
        const rgba = new Uint8ClampedArray(w * h * 4);
        let y = 0;
        for (const line of lines) {
            const x0 = (w - line.w) >> 1;
            for (let ly = 0; ly < line.h; ly++) {
                rgba.set(
                    line.rgba.subarray(ly * line.w * 4, (ly + 1) * line.w * 4),
                    ((y + ly) * w + x0) * 4
                );
            }
            y += line.h;
        }
        roles.credit = baseIndex + sprites.length;
        sprites.push({ key: "dezaCredit", w, h, rgba });
    }
    return { sprites, roles };
}

// --- Bosses -----------------------------------------------------------

// Sprites for every stage that places a boss: the class-sized core frames.
// A stage whose author left the core unpainted (Ramsie stage 0) fights with
// trailer-attached parts over the chamber scenery instead; the runtime's boss
// is a single sprite, so such a stage falls back to its 64x64 figure pieces
// (records 56-59) — the boss's own late-phase forms — one frame per piece,
// capped at two so the sprite doesn't cycle through unrelated parts.
// `bosses` is [{stage, sizeClass}]; returns {sprites, spriteKeysByStage}.
export function extractBossSprites(sec5, sections, palettes, bosses) {
    const sprites = [];
    const spriteKeysByStage = new Map();
    const placeholder = findPlaceholderCell(sec5).cell;
    const emit = (stage, frames, core) => {
        const keys = [];
        frames.forEach((frame) => {
            const { w, h, rgba } = renderFrame(sections, palettes, frame);
            let opaque = false;
            for (let p = 3; p < rgba.length; p += 4) if (rgba[p]) { opaque = true; break; }
            if (!opaque) return;
            keys.push(sprites.length);
            sprites.push({ key: `dezaBoss${stage}_${keys.length - 1}`, w, h, rgba });
        });
        if (keys.length) spriteKeysByStage.set(stage, { keys, core });
    };
    for (const { stage, sizeClass } of bosses) {
        const core = readBossCore(sec5, stage, sizeClass);
        if (core && !isUnpainted(core, placeholder)) {
            emit(stage, core.frames, true);
            continue;
        }
        const pieces = [];
        for (let record = 56; record <= 59 && pieces.length < 2; record++) {
            const art = readEnemyFrames(sec5, stage, record);
            if (!art || isUnpainted(art, placeholder)) continue;
            pieces.push(art.frames[0]);
        }
        emit(stage, pieces, false);
    }
    return { sprites, spriteKeysByStage };
}

// Art for the parts a boss's fire points spawn (trailer types 3/4). A part
// names its art as (group, piece) — a (stage, record) pair that reaches the
// atlas only when that piece also happens to be placed as a zako. Pieces the
// enemy roster already extracted are referenced by their existing indices;
// the rest are rendered here from the boss's own stage bank. `baseIndex` is
// where this function's sprites land in the caller's shared list, so every
// returned key is an absolute index into it.
// Returns {sprites, partKeysByStage: Map<stage, {record: keys[]}>}.
export function extractBossPartSprites(sec5, sections, palettes, bosses, enemies, baseIndex) {
    const sprites = [];
    const partKeysByStage = new Map();
    const placeholder = findPlaceholderCell(sec5).cell;
    const byPair = new Map();
    for (const e of enemies || []) {
        if (e.spriteKeys && e.spriteKeys.length) byPair.set(`${e.stage}:${e.record}`, e.spriteKeys);
    }
    const bySignature = new Map(); // CG cells are global, so parts dedupe across stages too
    for (const boss of bosses) {
        if (!boss.behavior) continue;
        const records = new Set();
        for (const pattern of boss.behavior.patterns) {
            for (const fp of pattern.firePoints) {
                if (fp.spawn && fp.spawn.record != null) records.add(fp.spawn.record);
            }
        }
        const art = {};
        for (const record of records) {
            const existing = byPair.get(`${boss.stage}:${record}`);
            if (existing) { art[record] = existing; continue; }
            const a = readEnemyFrames(sec5, boss.stage, record);
            if (!a || isUnpainted(a, placeholder)) continue;
            const sig = artSignature(a);
            const shared = bySignature.get(sig);
            if (shared) { art[record] = shared; continue; }
            const keys = [];
            a.frames.forEach((frame, i) => {
                const { w, h, rgba } = renderFrame(sections, palettes, frame);
                let opaque = false;
                for (let p = 3; p < rgba.length; p += 4) if (rgba[p]) { opaque = true; break; }
                if (!opaque) return;
                keys.push(baseIndex + sprites.length);
                sprites.push({ key: `dezaPart${boss.stage}_${record}_${i}`, w, h, rgba });
            });
            if (!keys.length) continue;
            bySignature.set(sig, keys);
            art[record] = keys;
        }
        if (Object.keys(art).length) partKeysByStage.set(boss.stage, art);
    }
    return { sprites, partKeysByStage };
}
