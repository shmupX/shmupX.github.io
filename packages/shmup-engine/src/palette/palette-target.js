// Palette TARGETS — how full-colour art is reduced to what a console can show,
// on the way from a cloud level's RGBA atlas into a Dezaemon 2 save.
//
// Both targets produce the same two things a .sav needs (deza2-palette.js):
// indexed frames whose bytes are CG pixel values (palette << 4 | colour, 0 =
// transparent) and the 16 x 16 sec4 palette bank they index. They differ in
// WHICH 15-bit colours are available and how a sprite may use them:
//
//   saturn  Dezaemon 2's own model. Rows 0-11 are the 192 SYSTEM colours
//           every save carries verbatim (the editor never lets them change);
//           rows 12-15 are the 64 USER colours an author mixes. An 8bpp pixel
//           may take any of the 255 opaque entries, so a sprite draws from
//           every row at once. Here the user rows are filled adaptively with
//           the atlas colours the system ramps serve worst, then every pixel
//           snaps to its nearest opaque entry.
//
//   snes    The Super Famicom's model (the pixel editor's declared second
//           palette source): CGRAM is fully programmable 15-bit BGR laid out
//           in 16-colour rows, sprites are 4bpp, so ONE sprite draws from ONE
//           row, whose entry 0 is transparent — 15 colours per sprite. Rows
//           are built adaptively from the sprites assigned to them. In a
//           Dezaemon 2 save those rows can only be the four user palettes (the
//           system rows are the Saturn game's, not the author's), so this
//           target yields up to four 15-colour palettes and keeps every
//           frame's opaque pixels inside a single row — exactly the
//           constraint SNES Dezaemon art lives under.
//
// Saturn RGB555 and SNES BGR555 are the same bit layout (R bits 0-4, G 5-9,
// B 10-14); only the byte order in CGRAM differs (little-endian), which
// snesCgramBytes() writes for a .pal sidecar.
//
// Colour distance is plain squared RGB in the 5-bit domain: the input is
// snapped to 15 bits first, because that is the finest either console shows.
//
// Environment-neutral ESM (Node + browser).

import { rgb555ToRgb } from "../decode/decode-cg.js";
import {
    DEZA2_CG_COLORS,
    DEZA2_PALETTE_COLS,
    DEZA2_PALETTE_WORDS,
    DEZA2_SYSTEM_ROWS,
    DEZA2_USER_ROWS,
} from "./deza2-palette.js";

export const PALETTE_TARGETS = Object.freeze({
    saturn: Object.freeze({
        id: "saturn",
        label: "SATURN · DEZAEMON 2 (192 SYSTEM + 64 USER)",
        console: "Sega Saturn",
        bitsPerPixel: 8,
        rowsPerSprite: 16,
        colorsPerRow: 16,
    }),
    snes: Object.freeze({
        id: "snes",
        label: "SUPER FAMICOM · 15-BIT BGR, 1 ROW PER SPRITE",
        console: "Super Famicom",
        bitsPerPixel: 4,
        rowsPerSprite: 1,
        colorsPerRow: 15,
    }),
});

/** Pixels with alpha below this are transparent (index 0). */
export const ALPHA_CUTOFF = 128;
export const USER_ROW_FIRST = DEZA2_SYSTEM_ROWS; // 12
export const USER_COLOR_COUNT = DEZA2_USER_ROWS * DEZA2_PALETTE_COLS; // 64
/** Every real save stores 0x8000 in sec4 word 0 (the transparent slot). */
export const SEC4_WORD0 = 0x8000;
/** DEZA2.PAL's end-of-row marker in an unused user row's last slot. */
export const DISC_USER_END_MARKER = 0x0021;
/** A user colour is stored with the CRAM flag; 0 = empty slot. */
export const USER_COLOR_FLAG = 0x8000;

const SYSTEM_COLORS = DEZA2_SYSTEM_ROWS * DEZA2_PALETTE_COLS; // 192

// --- small colour helpers ----------------------------------------------------

const to5 = (v) => v >> 3;
const word5 = (r5, g5, b5) => r5 | (g5 << 5) | (b5 << 10);
const r5of = (w) => w & 0x1f;
const g5of = (w) => (w >> 5) & 0x1f;
const b5of = (w) => (w >> 10) & 0x1f;

function dist2(w, r, g, b) {
    const dr = r5of(w) - r, dg = g5of(w) - g, db = b5of(w) - b;
    return dr * dr + dg * dg + db * db;
}

/** Opaque colours of `frames` as a 15-bit histogram: word -> pixel count. */
export function colorHistogram(frames) {
    const hist = new Map();
    for (const f of frames) {
        const px = f.rgba;
        for (let i = 0; i < f.w * f.h; i++) {
            const o = i * 4;
            if (px[o + 3] < ALPHA_CUTOFF) continue;
            const w = word5(to5(px[o]), to5(px[o + 1]), to5(px[o + 2]));
            hist.set(w, (hist.get(w) || 0) + 1);
        }
    }
    return hist;
}

/**
 * Weighted median cut over a 15-bit histogram: at most `maxColors`
 * representative words. Boxes split along their widest channel at the
 * population median until the budget is spent or no box holds two colours.
 */
export function medianCut(hist, maxColors) {
    const entries = [...hist.entries()].map(([w, n]) => ({ r: r5of(w), g: g5of(w), b: b5of(w), n }));
    if (!entries.length || maxColors <= 0) return [];
    if (entries.length <= maxColors) return entries.map((e) => word5(e.r, e.g, e.b));
    const boxes = [entries];
    const range = (box, ch) => {
        let lo = 31, hi = 0;
        for (const e of box) { if (e[ch] < lo) lo = e[ch]; if (e[ch] > hi) hi = e[ch]; }
        return hi - lo;
    };
    while (boxes.length < maxColors) {
        // Split the box with the largest spread (population-weighted so a
        // big flat area does not lose to a few stray pixels).
        let bi = -1, best = -1;
        boxes.forEach((box, i) => {
            if (box.length < 2) return;
            const spread = Math.max(range(box, "r"), range(box, "g"), range(box, "b"));
            const pop = box.reduce((a, e) => a + e.n, 0);
            const score = spread * Math.log2(1 + pop);
            if (score > best) { best = score; bi = i; }
        });
        if (bi < 0) break;
        const box = boxes[bi];
        const ch = ["r", "g", "b"].reduce((a, c) => (range(box, c) > range(box, a) ? c : a), "r");
        box.sort((a, b) => a[ch] - b[ch]);
        const total = box.reduce((a, e) => a + e.n, 0);
        let acc = 0, cut = 0;
        while (cut < box.length - 1 && acc + box[cut].n < total / 2) acc += box[cut++].n;
        if (cut === 0) cut = 1;
        boxes.splice(bi, 1, box.slice(0, cut), box.slice(cut));
    }
    return boxes.map((box) => {
        let r = 0, g = 0, b = 0, n = 0;
        for (const e of box) { r += e.r * e.n; g += e.g * e.n; b += e.b * e.n; n += e.n; }
        return word5(Math.round(r / n), Math.round(g / n), Math.round(b / n));
    });
}

// A candidate set: the opaque entries a pixel may snap to, with a memo
// keyed on the 15-bit input colour (real sprites reuse few colours).
function candidateSet(list) {
    const memo = new Map();
    const wordOf = new Map(list.map((c) => [c.index, c.word]));
    let error = 0, count = 0;
    return {
        list, // [{index, word}]
        wordOf,
        nearest(w) {
            let idx = memo.get(w);
            if (idx !== undefined) return idx;
            const r = r5of(w), g = g5of(w), b = b5of(w);
            let best = -1, bestD = Infinity;
            for (const c of list) {
                const d = dist2(c.word, r, g, b);
                if (d < bestD) { bestD = d; best = c.index; if (d === 0) break; }
            }
            memo.set(w, best);
            return best;
        },
        account(w, idx) {
            error += Math.sqrt(dist2(wordOf.get(idx), r5of(w), g5of(w), b5of(w)) / 3);
            count++;
        },
        meanError() { return count ? (error / count) * 8 : 0; }, // 8-bit units
    };
}

function indexFrame(frame, cands) {
    const out = new Uint8Array(frame.w * frame.h);
    const px = frame.rgba;
    for (let i = 0; i < out.length; i++) {
        const o = i * 4;
        if (px[o + 3] < ALPHA_CUTOFF) continue;
        const w = word5(to5(px[o]), to5(px[o + 1]), to5(px[o + 2]));
        const idx = cands.nearest(w);
        out[i] = idx;
        cands.account(w, idx);
    }
    return out;
}

/** The system rows as candidates (index 0, the transparent slot, excluded). */
function systemCandidates() {
    const list = [];
    for (let i = 1; i < SYSTEM_COLORS; i++) list.push({ index: i, word: DEZA2_PALETTE_WORDS[i] & 0x7fff });
    return list;
}

/** A sec4 bank with the system rows in place and every user slot empty. */
export function emptyBank() {
    const bank = new Uint16Array(DEZA2_CG_COLORS);
    for (let i = 0; i < SYSTEM_COLORS; i++) bank[i] = DEZA2_PALETTE_WORDS[i] & 0x7fff;
    bank[0] = SEC4_WORD0;
    for (let row = USER_ROW_FIRST; row < USER_ROW_FIRST + DEZA2_USER_ROWS; row++) {
        bank[row * DEZA2_PALETTE_COLS + DEZA2_PALETTE_COLS - 1] = DISC_USER_END_MARKER;
    }
    return bank;
}

/** Default group for a frame: its name minus frame digits and extension. */
export function frameGroup(key) {
    return String(key).replace(/\.[a-z0-9]+$/i, "").replace(/[_-]?\d+$/, "").replace(/[_-]?\d+$/, "") || String(key);
}

// --- the two targets -------------------------------------------------------------

function quantizeSaturn(frames, { userColors = USER_COLOR_COUNT, threshold = 12 } = {}) {
    const hist = colorHistogram(frames);
    const system = systemCandidates();
    // Colours the system ramps miss by more than `threshold` (squared 5-bit
    // distance; 12 is ~1 step per channel) compete for the user slots.
    const sys = candidateSet(system);
    const poor = new Map();
    for (const [w, n] of hist) {
        const idx = sys.nearest(w);
        if (dist2(sys.wordOf.get(idx), r5of(w), g5of(w), b5of(w)) > threshold) poor.set(w, n);
    }
    const bank = emptyBank();
    const cands = system.slice();
    const chosen = medianCut(poor, Math.min(userColors, USER_COLOR_COUNT));
    // Skip a user colour the system already has, and duplicates.
    const have = new Set(cands.map((c) => c.word));
    let slot = 0;
    for (const w of chosen) {
        if (have.has(w) || slot >= USER_COLOR_COUNT) continue;
        have.add(w);
        const index = USER_ROW_FIRST * DEZA2_PALETTE_COLS + slot;
        bank[index] = USER_COLOR_FLAG | w;
        cands.push({ index, word: w });
        slot++;
    }
    const set = candidateSet(cands);
    const indexed = frames.map((f) => ({ key: f.key, w: f.w, h: f.h, group: f.group, indexed: indexFrame(f, set), row: null }));
    return {
        bank,
        frames: indexed,
        report: {
            target: "saturn",
            sourceColors: hist.size,
            userColors: slot,
            poorlyServed: poor.size,
            meanError: Math.round(set.meanError() * 100) / 100,
        },
    };
}

function quantizeSnes(frames, { rows = DEZA2_USER_ROWS, colorsPerRow = 15 } = {}) {
    // Frames of one sprite share a row; groups are then packed into at most
    // `rows` palettes, each group going where it costs the least error.
    const groups = new Map();
    for (const f of frames) {
        const g = f.group || frameGroup(f.key);
        if (!groups.has(g)) groups.set(g, { name: g, frames: [], hist: null, pixels: 0 });
        groups.get(g).frames.push(f);
    }
    for (const g of groups.values()) {
        g.hist = colorHistogram(g.frames);
        for (const n of g.hist.values()) g.pixels += n;
    }
    const merge = (a, b) => {
        const m = new Map(a);
        for (const [w, n] of b) m.set(w, (m.get(w) || 0) + n);
        return m;
    };
    const errorOf = (hist, palette) => {
        if (!palette.length) return hist.size ? Infinity : 0;
        let e = 0, n = 0;
        for (const [w, cnt] of hist) {
            let best = Infinity;
            for (const p of palette) { const d = dist2(p, r5of(w), g5of(w), b5of(w)); if (d < best) best = d; }
            e += best * cnt;
            n += cnt;
        }
        return n ? e / n : 0;
    };
    const rowSets = []; // {hist, groups: []}
    const ordered = [...groups.values()].filter((g) => g.hist.size).sort((a, b) => b.pixels - a.pixels);
    for (const g of ordered) {
        const alone = errorOf(g.hist, medianCut(g.hist, colorsPerRow));
        let bestRow = -1, bestErr = Infinity;
        rowSets.forEach((row, i) => {
            const merged = merge(row.hist, g.hist);
            const err = errorOf(merged, medianCut(merged, colorsPerRow));
            if (err < bestErr) { bestErr = err; bestRow = i; }
        });
        if (rowSets.length < rows && (bestRow < 0 || bestErr > alone)) {
            rowSets.push({ hist: new Map(g.hist), groups: [g] });
        } else {
            rowSets[bestRow].hist = merge(rowSets[bestRow].hist, g.hist);
            rowSets[bestRow].groups.push(g);
        }
    }
    const bank = emptyBank();
    const rowOfGroup = new Map();
    const rowCands = [];
    rowSets.forEach((row, i) => {
        const palRow = USER_ROW_FIRST + i;
        // Entry 0 of a SNES palette is transparent: leave it empty (the
        // marker slot at 15 becomes a real colour, as authored saves do).
        bank[palRow * DEZA2_PALETTE_COLS + DEZA2_PALETTE_COLS - 1] = 0;
        const words = medianCut(row.hist, colorsPerRow);
        const cands = [];
        words.forEach((w, k) => {
            const index = palRow * DEZA2_PALETTE_COLS + 1 + k;
            bank[index] = USER_COLOR_FLAG | w;
            cands.push({ index, word: w });
        });
        rowCands.push(candidateSet(cands));
        for (const g of row.groups) rowOfGroup.set(g.name, i);
    });
    let error = 0, count = 0;
    const indexed = frames.map((f) => {
        const g = f.group || frameGroup(f.key);
        const r = rowOfGroup.get(g);
        if (r === undefined) {
            // an all-transparent group
            return { key: f.key, w: f.w, h: f.h, group: g, indexed: new Uint8Array(f.w * f.h), row: null };
        }
        const set = rowCands[r];
        const out = indexFrame(f, set);
        return { key: f.key, w: f.w, h: f.h, group: g, indexed: out, row: USER_ROW_FIRST + r };
    });
    for (const set of rowCands) { error += set.meanError(); count++; }
    return {
        bank,
        frames: indexed,
        report: {
            target: "snes",
            sourceColors: colorHistogram(frames).size,
            rows: rowSets.map((row, i) => ({
                row: USER_ROW_FIRST + i,
                colors: Math.min(colorsPerRow, row.hist.size),
                groups: row.groups.map((g) => g.name),
            })),
            groups: groups.size,
            meanError: count ? Math.round((error / count) * 100) / 100 : 0,
        },
    };
}

/**
 * Reduce RGBA frames to CG pixel bytes under a palette target.
 *
 * `frames`: [{key, w, h, rgba, group?}] — rgba is w*h*4 bytes. Returns
 * {target, bank, frames: [{key, w, h, indexed, row}], report}: `bank` is
 * the 256-word sec4 palette bank (system rows verbatim, user colours
 * 0x8000|rgb555, empty 0), `indexed` a w*h byte raster of CG pixel values.
 */
export function quantizeFrames(frames, target = "saturn", options = {}) {
    const spec = PALETTE_TARGETS[target];
    if (!spec) throw new Error(`unknown palette target ${JSON.stringify(target)} (saturn | snes)`);
    for (const f of frames) {
        if (!f || !f.rgba || f.rgba.length < f.w * f.h * 4) {
            throw new Error(`frame ${f && f.key}: rgba must hold w*h*4 bytes`);
        }
    }
    const out = target === "snes" ? quantizeSnes(frames, options) : quantizeSaturn(frames, options);
    return { target: spec, ...out };
}

/** sec4 bytes (u16be) from a 256-word bank. */
export function bankToSec4(bank) {
    const sec4 = new Uint8Array(512);
    for (let i = 0; i < 256; i++) {
        sec4[i * 2] = bank[i] >> 8;
        sec4[i * 2 + 1] = bank[i] & 0xff;
    }
    return sec4;
}

/** A 256-word bank as decode-cg.js palettes ([{colors: [{r,g,b,raw}]}] x16). */
export function bankToPalettes(bank) {
    const palettes = [];
    for (let p = 0; p < 16; p++) {
        const colors = [];
        for (let c = 0; c < 16; c++) {
            const raw = bank[p * 16 + c];
            colors.push({ raw, ...rgb555ToRgb(raw & 0x7fff), empty: raw === 0 });
        }
        palettes.push({ colors });
    }
    return palettes;
}

/**
 * The bank as Super Famicom CGRAM bytes: 256 little-endian BGR555 words
 * (bit 15 clear) — the .pal layout SNES tools read. Entry 0 is black.
 */
export function snesCgramBytes(bank) {
    const out = new Uint8Array(512);
    for (let i = 0; i < 256; i++) {
        const w = i === 0 ? 0 : bank[i] & 0x7fff;
        out[i * 2] = w & 0xff;
        out[i * 2 + 1] = w >> 8;
    }
    return out;
}
