// A level record -> a Dezaemon 3D project: the thirty files a project on a
// 64DD data disk is made of, with the level's art in the texture sheets.
//
// This is the N64 counterpart of src/write/game-to-save.js and
// src/psx/kids-write.js, and it is honest about how far it reaches. What is
// known about a project's files is on static/dezaemon-parity-n64.html: the
// two graphics types are CONFIRMED (RGBA5551 on 64x32 tiles, 40 in CGR and
// 260 in each stage's GR), the sizes of every file are confirmed by the
// prototype disk's own extraction, and the records inside the other seven
// types — enemy entries, placement, model tables, songs, the global settings
// — are LIKELY in layout and OPEN in meaning. A writer that painted bytes it
// cannot name would be guessing, so this one does not:
//
//   CGR, #GR   the level's frames, each cut into 64x32 textures (a frame
//              wider or taller than one is a grid of them), laid into the
//              sheet's BLANK textures — never over a painted one, so a
//              template's own art survives — in a fixed order the report
//              names tile by tile: the title pictures, the ship and the
//              item icons in CGR; a stage's enemies, their projectiles and
//              its boss in that stage's GR
//   the rest   a TEMPLATE's bytes when one is given (a project off a real
//              disk — the sample SAMPLEZ1 is the one this repo has), else
//              zero bytes at the documented size
//
// So a project this builds from the sample is the sample with the level's
// art added in its free texture slots, and one built from nothing is the
// art and empty records. Neither places the level's enemies: nothing on the
// disk refers to the textures this lays, and FORMAT-N64.md "What the writer
// does not write" is the list of what has to be traced before it can.
//
// Environment-neutral ESM (Node + browser).

import { decodeFrameKey, fitRgba, levelStages, spreadFrames } from "../write/game-to-save.js";
import { decodePlayerArt } from "../player-art.js";
import { DOCUMENTED_SIZES, normalizeProjectName, projectExts, sizeKey, STAGES } from "./directory.js";
import { TILE_BYTES, TILE_HEIGHT, TILE_WIDTH } from "./graphics.js";

/** One texture: a 64x32 RGBA5551 tile, 0x1000 bytes. */
export const N64_TEXTURE_BYTES = TILE_BYTES;

/** Textures in the common sheet and in a stage's. */
export const N64_CGR_TEXTURES = DOCUMENTED_SIZES.CGR / TILE_BYTES; // 40
export const N64_GR_TEXTURES = DOCUMENTED_SIZES.GR / TILE_BYTES; // 260

/** The record counts the documentation gives, from which the file sizes follow. (likely) */
export const N64_MODEL_BYTES = 0xc20;
export const N64_ENTRY_BYTES = 0x5c;
export const N64_CMD_MODELS = 20;
export const N64_MD_MODELS = 130;
export const N64_ULB_MODELS = 8;
export const N64_ULB_TEXTURES = 8;
export const N64_CBL_ENEMIES = 20;
export const N64_CBL_ITEMS = 7;
export const N64_BL_ENEMIES = 180;
export const N64_SONGS = 24;
export const N64_SONG_BYTES = 0x2c9a;
export const N64_SONG_HEADER_BYTES = 0x1a;

/** How many stages a project holds, and their numbers (7 is skipped). */
export const N64_STAGE_COUNT = STAGES.length;

/** The box the two title pictures are fitted into: 2 x 2 textures. */
export const N64_TITLE_COLS = 2;
export const N64_TITLE_ROWS = 2;

/** Frames per enemy kept in a stage sheet; the rest of an animation is dropped. */
export const N64_FRAMES_PER_ENEMY = 4;

/** The documented size of a file by extension, or null for one the format does not name. */
export function fileSizeFor(ext) {
    const key = sizeKey(String(ext).toUpperCase());
    return key in DOCUMENTED_SIZES ? DOCUMENTED_SIZES[key] : null;
}

/**
 * RGBA8888 -> big-endian RGBA5551, the inverse of graphics.js decodeRgba5551:
 * five bits a channel, rounded, and alpha in bit 0 from the alpha byte
 * against `alphaCutoff` (128: half-transparent and up is opaque).
 * @param {{w: number, h: number, rgba: Uint8Array|Uint8ClampedArray}} frame
 * @param {{alphaCutoff?: number}} [options]
 * @returns {Uint8Array}
 */
export function encodeRgba5551(frame, { alphaCutoff = 128 } = {}) {
    const n = frame.w * frame.h;
    const out = new Uint8Array(n * 2);
    for (let i = 0; i < n; i++) {
        const o = i * 4;
        const a = frame.rgba[o + 3] >= alphaCutoff;
        const r = a ? Math.round(frame.rgba[o] * 31 / 255) : 0;
        const g = a ? Math.round(frame.rgba[o + 1] * 31 / 255) : 0;
        const b = a ? Math.round(frame.rgba[o + 2] * 31 / 255) : 0;
        const v = (r << 11) | (g << 6) | (b << 1) | (a ? 1 : 0);
        out[i * 2] = v >> 8;
        out[i * 2 + 1] = v & 0xff;
    }
    return out;
}

/**
 * A frame as a grid of 64x32 textures, top-left aligned, pixels 1:1 — a
 * 32x32 sprite takes one texture with its right half clear, a 128x128 boss
 * takes 2 x 4. Transparent pixels are zero words, which is what the
 * prototype's own sheets use for nothing.
 * @param {{w: number, h: number, rgba: Uint8Array|Uint8ClampedArray}} frame
 * @param {{alphaCutoff?: number}} [options]
 * @returns {{cols: number, rows: number, tiles: Uint8Array[]}}  tiles row-major
 */
export function textureGrid(frame, options = {}) {
    const cols = Math.max(1, Math.ceil(frame.w / TILE_WIDTH));
    const rows = Math.max(1, Math.ceil(frame.h / TILE_HEIGHT));
    const tiles = [];
    for (let ty = 0; ty < rows; ty++) {
        for (let tx = 0; tx < cols; tx++) {
            const cut = { w: TILE_WIDTH, h: TILE_HEIGHT, rgba: new Uint8Array(TILE_WIDTH * TILE_HEIGHT * 4) };
            for (let y = 0; y < TILE_HEIGHT; y++) {
                const sy = ty * TILE_HEIGHT + y;
                if (sy >= frame.h) break;
                for (let x = 0; x < TILE_WIDTH; x++) {
                    const sx = tx * TILE_WIDTH + x;
                    if (sx >= frame.w) break;
                    const s = (sy * frame.w + sx) * 4;
                    const d = (y * TILE_WIDTH + x) * 4;
                    cut.rgba[d] = frame.rgba[s];
                    cut.rgba[d + 1] = frame.rgba[s + 1];
                    cut.rgba[d + 2] = frame.rgba[s + 2];
                    cut.rgba[d + 3] = frame.rgba[s + 3];
                }
            }
            tiles.push(encodeRgba5551(cut, options));
        }
    }
    return { cols, rows, tiles };
}

/** Whether a texture is every word zero: nothing drawn, so free for the taking. */
export function isBlankTexture(bytes) {
    for (let i = 0; i < bytes.length; i++) if (bytes[i] !== 0) return false;
    return true;
}

/**
 * A sheet of `count` textures, pre-painted from a template's bytes when
 * given. place() lays a frame's grid into the first run of blank textures
 * long enough — consecutive, so a model could one day index them as one
 * run — and refuses, returning null, when no run fits.
 */
export class TextureSheet {
    /**
     * @param {number} count
     * @param {Uint8Array|null} [template]  `count` x 0x1000 bytes, or null for an empty sheet
     */
    constructor(count, template = null) {
        this.count = count;
        this.bytes = new Uint8Array(count * TILE_BYTES);
        if (template) {
            if (template.length !== this.bytes.length) throw new Error(`a sheet of ${count} textures is ${this.bytes.length} bytes; the template is ${template.length}`);
            this.bytes.set(template);
        }
        this.blank = Array.from({ length: count }, (_, i) => isBlankTexture(this.bytes.subarray(i * TILE_BYTES, (i + 1) * TILE_BYTES)));
        this.painted = this.blank.filter((b) => !b).length; // the template's own art
        this.placed = []; // {key, index, cols, rows}
    }

    /** Textures still blank. */
    get free() {
        return this.blank.filter(Boolean).length;
    }

    /**
     * @param {string} key   what the report calls the frame
     * @param {{cols: number, rows: number, tiles: Uint8Array[]}} grid
     * @returns {number|null}  the first texture's index, or null when no run of blanks fits
     */
    place(key, grid) {
        const need = grid.tiles.length;
        let run = 0;
        for (let i = 0; i < this.count; i++) {
            run = this.blank[i] ? run + 1 : 0;
            if (run === need) {
                const first = i - need + 1;
                grid.tiles.forEach((t, k) => {
                    this.bytes.set(t, (first + k) * TILE_BYTES);
                    this.blank[first + k] = false;
                });
                this.placed.push({ key, index: first, cols: grid.cols, rows: grid.rows, textures: need });
                return first;
            }
        }
        return null;
    }
}

/** The letter and drop digit of a grid cell, or null for an empty one. */
function cellParts(cell) {
    if (typeof cell !== "string" || cell.length < 2 || cell === "00") return null;
    const m = /^([A-Za-z]+)(\d)$/.exec(cell);
    return m ? { letter: m[1].toUpperCase(), drop: Number(m[2]) } : null;
}

/** A frame's bytes as Uint8Array whatever the caller sliced them as. */
function asFrame(f) {
    if (!f || !f.rgba || !(f.w > 0) || !(f.h > 0)) return null;
    return { w: f.w, h: f.h, rgba: f.rgba };
}

/**
 * A level record and its RGBA frames -> a project's files.
 *
 * `art` is {frameName: {w, h, rgba}}, what buildSaveFromGame takes. Options:
 *   name      the project's name (normalizeProjectName); default the level's
 *   template  a project's files to start from — [{ext, data}] or a Map of
 *             ext -> bytes, decompressed, as readProjects() + decompress()
 *             give them off a disk; null for zeros
 *   title1, title2  the title pictures as RGBA frames, each fitted to 128x64
 *   framesPerEnemy  frames kept per enemy animation (4)
 *
 * Returns {name, files: [{ext, data}], report, warnings}; the report's shape
 * is the literal at the end of this function, which is what a caller's type
 * checker sees.
 *
 * @param {object} level
 * @param {Record<string, {w: number, h: number, rgba: Uint8Array|Uint8ClampedArray}>} art
 * @param {{name?: string|null, template?: Array<{ext: string, data: Uint8Array}>|Map<string, Uint8Array>|null,
 *          title1?: object|null, title2?: object|null, framesPerEnemy?: number}} [options]
 */
export function buildN64ProjectFromLevel(level, art, options = {}) {
    const { template = null, title1 = null, title2 = null, framesPerEnemy = N64_FRAMES_PER_ENEMY } = options;
    const warnings = [];
    const warn = (m) => warnings.push(m);
    const name = normalizeProjectName(options.name ?? (level && level.name) ?? "SHMUPX");

    const templateFiles = new Map();
    if (template) {
        const list = template instanceof Map ? [...template.entries()].map(([ext, data]) => ({ ext, data })) : template;
        for (const f of list) {
            const ext = String(f.ext).toUpperCase();
            if (!(f.data instanceof Uint8Array)) throw new Error(`template ${ext}: a file is a Uint8Array`);
            templateFiles.set(ext, f.data);
        }
    }

    const artMap = new Map();
    for (const [k, v] of Object.entries(art || {})) {
        const f = asFrame(v);
        if (f) artMap.set(decodeFrameKey(k), { key: decodeFrameKey(k), ...f });
    }
    const lookup = (n) => (n ? artMap.get(decodeFrameKey(n)) || null : null);

    let stages = levelStages(level || {});
    if (!stages.length) throw new Error("the level has no stage with an enemylist");
    if (stages.length > N64_STAGE_COUNT) {
        warn(`level has ${stages.length} stages; a project holds ${N64_STAGE_COUNT} — dropped the rest`);
        stages = stages.slice(0, N64_STAGE_COUNT);
    }
    const enemyData = (level && level.enemyData) || {};
    const bossData = (level && level.bossData) || {};

    // --- CGR: the common sheet ---
    const cgr = new TextureSheet(N64_CGR_TEXTURES, templateFiles.get("CGR") || null);
    const common = { placed: [], missed: [] };
    const placeCommon = (key, frame) => {
        if (!frame) return;
        const at = cgr.place(key, textureGrid(frame));
        if (at === null) common.missed.push(key);
    };
    for (const [key, pic] of [["title1", title1], ["title2", title2]]) {
        const f = asFrame(pic);
        if (!f) continue;
        placeCommon(key, fitRgba(f, N64_TITLE_COLS * TILE_WIDTH, N64_TITLE_ROWS * TILE_HEIGHT));
    }
    let shipFrames = (((level && level.playerData) || {}).texture || []).map(lookup).filter(Boolean);
    let shipSource = "level";
    if (!shipFrames.length) {
        shipSource = "duke";
        shipFrames = decodePlayerArt().filter((f) => /^duke_\d$/.test(f.key)).slice(0, 2);
    }
    spreadFrames(shipFrames, Math.min(2, shipFrames.length)).forEach((f, i) => placeCommon(`ship:${i}:${f.key}`, f));
    const itemFrames = Object.entries(art || {}).filter(([k]) => /item|powerup|speedup|1up/i.test(k)).slice(0, 8);
    for (const [k] of itemFrames) placeCommon(`item:${decodeFrameKey(k)}`, lookup(k));
    common.placed = cgr.placed;

    // --- the stages ---
    const stageReports = [];
    const sheets = new Map(); // ext -> bytes
    stages.forEach((st, i) => {
        const stage = STAGES[i];
        const ext = `${stage}GR`;
        const sheet = new TextureSheet(N64_GR_TEXTURES, templateFiles.get(ext) || null);
        const missed = [];
        const place = (key, frame) => {
            if (!frame) return;
            if (sheet.place(key, textureGrid(frame)) === null) missed.push(key);
        };
        const letters = [];
        for (const row of st.enemylist) {
            for (const cell of row) {
                const parts = cellParts(cell);
                if (parts && !letters.includes(parts.letter)) letters.push(parts.letter);
            }
        }
        for (const letter of letters) {
            const rec = enemyData[`enemy${letter}`];
            if (!rec) {
                warn(`${st.key}: cell ${letter} names no enemyData.enemy${letter}; nothing drawn for it`);
                continue;
            }
            const frames = (rec.texture || []).map(lookup).filter(Boolean);
            if (!frames.length) warn(`${st.key}: enemy${letter} (${rec.name || "unnamed"}) has no frame in the art`);
            spreadFrames(frames, Math.min(framesPerEnemy, frames.length)).forEach((f, k) => place(`enemy${letter}:${k}:${f.key}`, f));
            const shot = rec.projectileData && rec.projectileData.texture ? lookup(rec.projectileData.texture[0]) : null;
            if (shot) place(`enemy${letter}:shot:${shot.key}`, shot);
        }
        const boss = bossData[`boss${i}`] || null;
        if (boss) {
            const idle = (boss.anim && boss.anim.idle && boss.anim.idle[0]) || (boss.texture && boss.texture[0]) || null;
            const f = lookup(idle);
            if (f) place(`boss${i}:${f.key}`, f);
            else warn(`${st.key}: boss${i} has no idle frame in the art`);
        }
        if (missed.length) warn(`${st.key}: the ${ext} sheet ran out of blank textures; not drawn: ${missed.join(", ")}`);
        sheets.set(ext, sheet.bytes);
        stageReports.push({
            key: st.key,
            stage,
            ext,
            enemies: letters,
            boss: boss ? `boss${i}` : null,
            textures: sheet.placed,
            painted: sheet.painted,
            used: sheet.count - sheet.free,
            free: sheet.free,
            missed,
        });
    });
    if (common.missed.length) warn(`the CGR sheet ran out of blank textures; not drawn: ${common.missed.join(", ")}`);

    // --- every file ---
    const files = [];
    const sources = [];
    for (const ext of projectExts()) {
        /** @type {Uint8Array} */
        let data;
        /** @type {string} */
        let source;
        const sheet = sheets.get(ext);
        const fromTemplate = templateFiles.get(ext);
        if (ext === "CGR") {
            data = cgr.bytes;
            source = "art";
        } else if (sheet) {
            data = sheet;
            source = "art";
        } else if (fromTemplate) {
            data = fromTemplate;
            source = "template";
        } else {
            data = new Uint8Array(fileSizeFor(ext) ?? 0);
            source = "blank";
        }
        if (templateFiles.has(ext) && source !== "template") {
            // a template sheet underlies the art; say so
            source = "art over template";
        }
        files.push({ ext, data });
        sources.push({ ext, bytes: data.length, source });
    }
    for (const ext of templateFiles.keys()) {
        if (!projectExts().includes(ext)) warn(`template file ${ext} is not one of a project's thirty and was not written`);
    }

    const report = {
        name,
        template: templateFiles.size ? [...templateFiles.keys()] : null,
        ship: shipSource,
        common: { textures: cgr.placed, painted: cgr.painted, used: cgr.count - cgr.free, free: cgr.free, missed: common.missed },
        stages: stageReports,
        files: sources,
        bytes: files.reduce((a, f) => a + f.data.length, 0),
    };
    return { name, files, report, warnings };
}
