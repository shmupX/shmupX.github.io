// A level record -> a Dezaemon 3D project: the thirty files a project on a
// 64DD data disk is made of, with the level's art in the texture sheets and
// its enemies in the records.
//
// This is the N64 counterpart of src/write/game-to-save.js and
// src/psx/kids-write.js. The first version laid the art alone, because the
// records were unknown; they are known now — records.js carries the codecs
// read from the 2024 translation's "file formats.txt" — so this one places
// the level, and is honest about which of its choices are measured and
// which are the best reading of a document nobody here has put in front of
// the game:
//
//   CGR, #GR   the level's frames as 64x32 RGBA5551 textures (CONFIRMED
//              format), one texture per frame — a model shows ONE texture,
//              so a frame wider than 64 or taller than 32 is shrunk to fit,
//              aspect kept — laid into the sheet's BLANK textures, never
//              over a painted one, so a template's own art survives
//   #MD        a billboard per placed frame: a flat quad the size of the
//              sprite, textured from its texture (records.js billboardModel;
//              the UV units are the document's as written, OPEN)
//   #BL        an enemy entry per enemy letter (one per drop digit on its
//              cells, as the Saturn writer does, because an entry carries
//              one item), its frames' model numbers, score, HP, speed, a
//              shot when it fires, the item it drops; the boss with the
//              stage-clear flag; the layout of every cell on the map layer
//              at the frame its row scrolls in; no effects; the map carried
//              from a template stage or left unset
//   CMD, CBL   the ship and the item icons as common models 10 and 12..18 —
//              the slots the cartridge's own game uses — with the seven item
//              entries pointing at them; a template's bytes when given
//   GAM        a template's with its final stage set, else the cartridge's
//              initial game (records.js gamDefaults) with the final stage set
//   MUS, ULB   a template's, else blank songs and an empty library
//
// Where a number here is a reading rather than a measurement it is named in
// a constant below with its evidence. The two that matter most: model
// numbers in an entry are 20 + the stage's model slot (the sample game's
// stage entries name 20..148 almost exclusively and its seven items 12..18,
// so the common CMD is read as coming first — LIKELY, on no stronger
// evidence than that); layout x runs
// about -400..400 across the screen and the frame offset counts DOWN from
// the start, entries in descending order (measured on the sample's three
// stages — LIKELY in meaning, CONFIRMED in shape). Nothing this writes has
// been booted: FORMAT-N64.md "What the writer does not write" is the list of
// what is still carried rather than built.
//
// Environment-neutral ESM (Node + browser).

import {
    BOSS_ROW_GAP,
    decodeFrameKey,
    FIRST_SPAWN_ROW,
    fitRgba,
    levelStages,
    MAX_SPAWN_ROW,
    ROW_STEP,
    spreadFrames,
} from "../write/game-to-save.js";
import { ANIM_PERIOD_TABLE, FIRE_INTERVAL_TABLE } from "../decode/decode-enemy.js";
import { decodePlayerArt } from "../player-art.js";
import { DOCUMENTED_SIZES, normalizeProjectName, projectExts, sizeKey, STAGES } from "./directory.js";
import { TILE_BYTES, TILE_HEIGHT, TILE_WIDTH } from "./graphics.js";
import {
    billboardModel,
    BL_ENEMY_COUNT,
    buildCbl,
    buildCmdFile,
    buildMdFile,
    buildMusFile,
    buildStageBl,
    buildUlbFile,
    CBL_ITEMS,
    CMD_MODEL_COUNT,
    encodeGam,
    ENEMY_SCORE_TABLE,
    LAYOUT_MAX_ENEMIES,
    MD_MODEL_COUNT,
    parseStageBl,
} from "./records.js";

/** One texture: a 64x32 RGBA5551 tile, 0x1000 bytes. */
export const N64_TEXTURE_BYTES = TILE_BYTES;

/** Textures in the common sheet and in a stage's. */
export const N64_CGR_TEXTURES = DOCUMENTED_SIZES.CGR / TILE_BYTES; // 40
export const N64_GR_TEXTURES = DOCUMENTED_SIZES.GR / TILE_BYTES; // 260

/** The record counts the documentation gives, from which the file sizes follow. (confirmed by the sizes) */
export const N64_MODEL_BYTES = 0xc20;
export const N64_ENTRY_BYTES = 0x5c;
export const N64_CMD_MODELS = CMD_MODEL_COUNT;
export const N64_MD_MODELS = MD_MODEL_COUNT;
export const N64_ULB_MODELS = 8;
export const N64_ULB_TEXTURES = 8;
export const N64_CBL_ENEMIES = 20;
export const N64_CBL_ITEMS = 7;
export const N64_BL_ENEMIES = BL_ENEMY_COUNT;
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

/**
 * An entry's model number for a stage model slot: 20 + the slot. The sample
 * game's stage entries name models 20..148 almost exclusively (the first
 * stage also 0 and 19, the second 11), its seven items 12..18 only, and its
 * twenty common entries anything from 8 to 80 — so the common CMD's twenty
 * are read as coming first and the stage's 130 after, on the items and the
 * stages' habit alone. (likely)
 */
export const N64_MODEL_NUMBER_BASE = N64_CMD_MODELS;

/** The common model slots the cartridge's own game gives the ship (GAM player.models[0] = 10) and the seven items (CBL's item entries name 12..18). (likely) */
export const N64_PLAYER_MODEL = 10;
export const N64_ITEM_MODELS = Object.freeze([12, 13, 14, 15, 16, 17, 18]);

/** A sprite pixel in model units: 32 px becomes a 128-unit quad, the size of the sample game's ordinary objects. (likely) */
export const N64_UNITS_PER_PIXEL = 4;

/** The layout's x across the screen: the sample's map layers run about -400..430. (likely) */
export const N64_LAYOUT_HALF_WIDTH = 400;
/** Where an enemy is placed on the map plane: the sample's second stage opens its enemies at y 240. (likely) */
export const N64_SPAWN_Y = 240;
/**
 * Where the boss is placed: y 400 is where the sample's second stage puts its
 * one layer-A object — an invincible, scoreless one early in the stage, not a
 * boss. The samples' own bosses are not placed by their layouts at all (the
 * third stage ends by a stage-clear effect), so this is a reading, held
 * because an entry has to go somewhere. (likely)
 */
export const N64_BOSS_Y = 400;
/** A placement row (16 px) in frames at the Saturn's 1 px/frame, so the two consoles pace a level the same way. (likely) */
export const N64_FRAMES_PER_ROW = 16;

/** motion speed 1..3 (0..7) from a runtime px/frame. (likely) */
export const N64_SPEED_TABLE = Object.freeze([0, 0.5, 1, 1.5, 2, 3, 4, 6]);
/** hit size (0..7) from a sprite's larger side in px. (likely) */
export const N64_HIT_SIZE_TABLE = Object.freeze([8, 16, 24, 32, 48, 64, 96, 128]);
/** The web's drop digits -> the item an entry drops (0 shot, 1 laser, 2 bomb, 3 shield, 4 1UP, 5 bonus1, 6 bonus2): the three shot power-ups all become the shot item, 4 (score) bonus1, 5 (bomb) the bomb, 9 (barrier) the shield. (likely) */
export const N64_DROP_ITEMS = Object.freeze({ 1: 0, 2: 0, 3: 0, 4: 5, 5: 2, 9: 3 });
/** The item entries' own settings in the cartridge's game: every one invincible (hp mode 2) with hit size 4, and a scale of its own — shot, laser, bomb, shield, 1UP, bonus1, bonus2. (measured) */
export const N64_ITEM_ENTRY = Object.freeze({ hitMode: 2, hitSize: 4 });
export const N64_ITEM_SCALES = Object.freeze([33, 45, 45, 32, 45, 76, 32]);

/** The documented size of a file by extension, or null for one the format does not name. */
export function fileSizeFor(ext) {
    const key = sizeKey(String(ext).toUpperCase());
    return key in DOCUMENTED_SIZES ? DOCUMENTED_SIZES[key] : null;
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function nearestIndex(table, value) {
    let best = 0, bestD = Infinity;
    table.forEach((v, i) => {
        const d = Math.abs(v - value);
        if (d < bestD) {
            bestD = d;
            best = i;
        }
    });
    return best;
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

/**
 * A frame no larger than maxW x maxH: the frame itself when it fits, else a
 * nearest-neighbour downscale that keeps its aspect, top-left origin.
 * @param {{w: number, h: number, rgba: Uint8Array|Uint8ClampedArray}} frame
 * @returns {{w: number, h: number, rgba: Uint8Array|Uint8ClampedArray, scaled: boolean}}
 */
export function shrinkRgba(frame, maxW = TILE_WIDTH, maxH = TILE_HEIGHT) {
    const scale = Math.min(1, maxW / frame.w, maxH / frame.h);
    if (scale === 1) return { w: frame.w, h: frame.h, rgba: frame.rgba, scaled: false };
    const w = Math.max(1, Math.round(frame.w * scale));
    const h = Math.max(1, Math.round(frame.h * scale));
    const out = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) {
        const sy = Math.min(frame.h - 1, Math.floor((y + 0.5) / scale));
        for (let x = 0; x < w; x++) {
            const sx = Math.min(frame.w - 1, Math.floor((x + 0.5) / scale));
            const s = (sy * frame.w + sx) * 4;
            const d = (y * w + x) * 4;
            out[d] = frame.rgba[s];
            out[d + 1] = frame.rgba[s + 1];
            out[d + 2] = frame.rgba[s + 2];
            out[d + 3] = frame.rgba[s + 3];
        }
    }
    return { w, h, rgba: out, scaled: true };
}

/**
 * One frame as ONE texture — what a model can show — shrunk to 64x32 when it
 * is bigger, top-left aligned: {grid (one tile), w, h (the sprite's pixels in
 * the texture), scaled}.
 * @param {{w: number, h: number, rgba: Uint8Array|Uint8ClampedArray}} frame
 */
export function spriteTexture(frame, options = {}) {
    const small = shrinkRgba(frame);
    return { grid: textureGrid(small, options), w: small.w, h: small.h, scaled: small.scaled };
}

/** The tile power for `px` pixels: the smallest p with 1 << (p + 1) >= px (16 -> 3, 32 -> 4, 64 -> 5). */
export function tilePower(px) {
    let p = 0;
    while ((1 << (p + 1)) < px && p < 7) p++;
    return p;
}

/**
 * The billboard model for a sprite of w x h texture pixels: a quad of
 * N64_UNITS_PER_PIXEL units a pixel, its two faces' UVs over the sprite's own
 * pixel box on tile 1 (the sample models leave tile 0 blank), the tile sized
 * to the next power of two. (likely: the UV units are the document's)
 * @param {{w: number, h: number}} sprite
 * @param {number} [light]
 */
export function spriteModel(sprite, light = 0) {
    const w = Math.max(1, sprite.w), h = Math.max(1, sprite.h);
    const model = billboardModel({
        width: clamp(w * N64_UNITS_PER_PIXEL, 1, 0x7fff),
        height: clamp(h * N64_UNITS_PER_PIXEL, 1, 0x7fff),
        tileWidthPower: tilePower(w),
        tileHeightPower: tilePower(h),
        tile: 1,
        light,
    });
    model.faces[0].uv = [[0, 0], [w, 0], [w, h]];
    model.faces[1].uv = [[0, 0], [w, h], [0, h]];
    return model;
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
        this.placed = []; // {key, index, cols, rows, textures}
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

/** A model table of `count` slots: models and the texture index each shows. */
class ModelTable {
    constructor(count) {
        this.count = count;
        this.models = [];
        this.textures = [];
    }
    /** @returns {number|null} the slot, or null when the table is full */
    add(model, texture) {
        if (this.models.length >= this.count) return null;
        this.models.push(model);
        this.textures.push(texture);
        return this.models.length - 1;
    }
    get used() {
        return this.models.length;
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

/** The four model numbers of an entry's animation from the placed frames' slots (-1 for a frame that got no slot): repeat the last, 0xFF for none. */
function animationModels(slots) {
    const numbers = slots.filter((s) => s >= 0).map((s) => N64_MODEL_NUMBER_BASE + s);
    if (!numbers.length) return [0xff, 0xff, 0xff, 0xff];
    return [0, 1, 2, 3].map((i) => numbers[Math.min(i, numbers.length - 1)]);
}

/**
 * An enemy entry (records.js encodeEnemyEntry's shape) for an editor enemy
 * record: score and HP from the record, the animation over the placed
 * frames, the speed, a shot when the record fires, the item its cells drop,
 * and for a boss the stage-clear and lock-on flags with a fixed motion.
 * Every table here is a reading of the document's ranges (likely).
 *
 * @param {object} rec        enemyData.enemyX (or a boss record)
 * @param {{slots: number[], size: number, frames: number, drop?: number|null, boss?: boolean}} placed
 */
export function enemyEntryFromEditor(rec, { slots, size, frames, drop = null, boss = false }) {
    const r = rec || {};
    const infinite = r.hp === "infinity";
    // A partial hit counts as one: the editor admits any finite hp.
    const hits = infinite ? 16 : Math.max(1, Math.ceil(Number(r.hp)) || (boss ? 16 : 1));
    const speed = Number.isFinite(r.speed) ? r.speed : 1;
    const frameRate = Number(r.frameRate);
    const animated = frames > 1 && Number.isFinite(frameRate) && frameRate > 0;
    const proj = r.projectileData || null;
    const interval = Number(r.interval);
    const fires = !!proj && Number.isFinite(interval) && interval > 0;
    const item = drop !== null && drop in N64_DROP_ITEMS ? N64_DROP_ITEMS[drop] : null;
    const blastScale = size < 24 ? 0 : size < 48 ? 1 : size < 96 ? 2 : 3;
    const entry = {
        score: nearestIndex(ENEMY_SCORE_TABLE, Number(r.score) || (boss ? 10000 : 100)),
        hp: clamp(hits - 1, 0, 15),
        animation: {
            disabled: !animated,
            frameSpeed: animated ? nearestIndex(ANIM_PERIOD_TABLE, 60 / frameRate) : 0x7f,
            models: animationModels(slots),
        },
        scale: 100,
        motion: { type: boss ? 1 : 0, speed1: nearestIndex(N64_SPEED_TABLE, speed) },
        hit: {
            lockOn: boss,
            stageClear: boss,
            hpMode: infinite && !boss ? 2 : 0,
            size: nearestIndex(N64_HIT_SIZE_TABLE, size),
        },
        blast: { particle: true, scale: blastScale },
    };
    if (fires) {
        entry.shots = [{
            type: 0, // bullet 1
            direction: 0,
            variant: 1,
            speed: nearestIndex(N64_SPEED_TABLE, Number(proj.speed) || 2),
            aimAtPlayer: true,
            timing: nearestIndex(FIRE_INTERVAL_TABLE, interval),
        }];
    }
    if (item !== null) entry.item = { enabled: true, value: item };
    return entry;
}

/** The item entry that shows common model `model` (the cartridge's own items' settings). */
function itemEntry(model, scale) {
    return {
        animation: { disabled: true, frameSpeed: 0x7f, models: [model, model, model, model] },
        scale,
        hit: { hpMode: N64_ITEM_ENTRY.hitMode, size: N64_ITEM_ENTRY.hitSize },
    };
}

/**
 * A level record and its RGBA frames -> a project's files.
 *
 * `art` is {frameName: {w, h, rgba}}, what buildSaveFromGame takes. Options:
 *   name      the project's name (normalizeProjectName); default the level's
 *   template  a project's files to start from — [{ext, data}] or a Map of
 *             ext -> bytes, decompressed, as readProjects() + decompress()
 *             give them off a disk; null for none
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

    // --- CGR: the common sheet, and the common models that show it ---
    // A template sheet of the wrong size is left out with a warning, the way
    // a template BL that cannot be read is, rather than refusing the build.
    const sheetFrom = (ext, count) => {
        const t = templateFiles.get(ext) || null;
        if (t && t.length !== count * TILE_BYTES) {
            warn(`template ${ext} is ${t.length} bytes, not the ${count * TILE_BYTES} of ${count} textures; built on a blank sheet instead`);
            templateFiles.delete(ext);
            return new TextureSheet(count, null);
        }
        return new TextureSheet(count, t);
    };
    const cgr = sheetFrom("CGR", N64_CGR_TEXTURES);
    const common = { placed: [], missed: [], models: [], scaled: [] };
    const cmd = new Map(); // common slot -> {model, texture}
    const placeCommon = (key, grid) => {
        const at = cgr.place(key, grid);
        if (at === null) common.missed.push(key);
        return at;
    };
    for (const [key, pic] of [["title1", title1], ["title2", title2]]) {
        const f = asFrame(pic);
        if (!f) continue;
        placeCommon(key, textureGrid(fitRgba(f, N64_TITLE_COLS * TILE_WIDTH, N64_TITLE_ROWS * TILE_HEIGHT)));
    }
    let shipFrames = (((level && level.playerData) || {}).texture || []).map(lookup).filter(Boolean);
    let shipSource = "level";
    if (!shipFrames.length) {
        shipSource = "duke";
        shipFrames = decodePlayerArt().filter((f) => /^duke_\d$/.test(f.key)).slice(0, 2);
    }
    spreadFrames(shipFrames, Math.min(2, shipFrames.length)).forEach((f, i) => {
        const t = spriteTexture(f);
        if (t.scaled) common.scaled.push(`ship:${i}:${f.key}`);
        const at = placeCommon(`ship:${i}:${f.key}`, t.grid);
        if (at !== null && i === 0) cmd.set(N64_PLAYER_MODEL, { model: spriteModel(t), texture: at, key: `ship:${f.key}` });
    });
    const itemFrames = Object.entries(art || {}).filter(([k]) => /item|powerup|speedup|1up/i.test(k)).slice(0, 8);
    itemFrames.forEach(([k], i) => {
        const f = lookup(k);
        if (!f) return;
        const t = spriteTexture(f);
        if (t.scaled) common.scaled.push(`item:${decodeFrameKey(k)}`);
        const at = placeCommon(`item:${decodeFrameKey(k)}`, t.grid);
        if (at !== null && i < N64_ITEM_MODELS.length) {
            cmd.set(N64_ITEM_MODELS[i], { model: spriteModel(t), texture: at, key: `item:${decodeFrameKey(k)}` });
        }
    });
    common.placed = cgr.placed;
    // The report names the common models only when CMD is written here; a
    // template's CMD is carried as it is, and then these show nothing.
    common.models = templateFiles.has("CMD") ? [] : [...cmd.entries()].map(([slot, m]) => ({ slot, texture: m.texture, key: m.key }));

    // --- the stages ---
    const stageReports = [];
    const built = new Map(); // ext -> bytes
    stages.forEach((st, i) => {
        const stage = STAGES[i];
        const grExt = `${stage}GR`, mdExt = `${stage}MD`, blExt = `${stage}BL`;
        const sheet = sheetFrom(grExt, N64_GR_TEXTURES);
        const models = new ModelTable(N64_MD_MODELS);
        const entries = []; // enemy entries, index = enemy number
        const placements = []; // {enemy, x, y, frame}
        const missed = [];
        const scaled = [];

        // A frame -> its texture and model slot; -1 for a frame that found no room.
        const placeFrame = (key, frame) => {
            if (models.used >= models.count) {
                missed.push(key); // no model slot left: the texture would show nothing
                return -1;
            }
            const t = spriteTexture(frame);
            if (t.scaled) scaled.push(key);
            const at = sheet.place(key, t.grid);
            if (at === null) {
                missed.push(key);
                return -1;
            }
            return models.add(spriteModel(t), at);
        };

        // The cells: which letters, how often, with which drop digits.
        const width = Math.max(1, (level && level.width) || 0, ...st.enemylist.map((row) => row.length));
        const spawnRows = st.enemylist.slice().reverse();
        const waveRows = Array.isArray(st.waveRows) && st.waveRows.length === st.enemylist.length ? st.waveRows.slice().reverse() : null;
        const usage = new Map(); // letter -> {count, digits: Map digit -> count}
        const cells = []; // {letter, drop, col, row}
        let lastRow = FIRST_SPAWN_ROW;
        spawnRows.forEach((row, k) => {
            const scrollRow = waveRows ? clamp(Math.round(waveRows[k]), 0, MAX_SPAWN_ROW) : Math.min(MAX_SPAWN_ROW, FIRST_SPAWN_ROW + k * ROW_STEP);
            row.forEach((cell, col) => {
                const parts = cellParts(cell);
                if (!parts) return;
                cells.push({ ...parts, col, row: scrollRow });
                if (!usage.has(parts.letter)) usage.set(parts.letter, { count: 0, digits: new Map() });
                const u = usage.get(parts.letter);
                u.count++;
                u.digits.set(parts.drop, (u.digits.get(parts.drop) || 0) + 1);
                lastRow = Math.max(lastRow, scrollRow);
            });
        });
        const letters = [...usage.keys()].sort((a, b) => usage.get(b).count - usage.get(a).count);
        const gridLetters = []; // the report's order: as the grid reads, top row first
        for (const row of st.enemylist) {
            for (const cell of row) {
                const parts = cellParts(cell);
                if (parts && !gridLetters.includes(parts.letter)) gridLetters.push(parts.letter);
            }
        }

        // An entry per letter and drop digit, most-placed letters first.
        const entryOf = new Map(); // "A1" -> entry index
        const stageEnemies = [];
        for (const letter of letters) {
            const rec = enemyData[`enemy${letter}`];
            if (!rec) {
                warn(`${st.key}: cell ${letter} names no enemyData.enemy${letter}; nothing drawn for it`);
                continue;
            }
            if (entries.length >= N64_BL_ENEMIES) {
                // No entry could name its frames, so they are not placed either:
                // a texture and a model nobody points at would only crowd out
                // the letters after it, and the boss.
                warn(`${st.key}: a stage holds ${N64_BL_ENEMIES} enemy entries and they are all taken — enemy${letter} is left out`);
                continue;
            }
            const frames = (rec.texture || []).map(lookup).filter(Boolean);
            if (!frames.length) warn(`${st.key}: enemy${letter} (${rec.name || "unnamed"}) has no frame in the art`);
            const kept = spreadFrames(frames, Math.min(framesPerEnemy, frames.length));
            const slots = kept.map((f, k) => placeFrame(`enemy${letter}:${k}:${f.key}`, f));
            const size = frames.reduce((a, f) => Math.max(a, f.w, f.h), 16);
            const digits = [...usage.get(letter).digits.entries()].sort((a, b) => b[1] - a[1]).map(([d]) => d);
            let first = null;
            for (const drop of digits) {
                if (entries.length >= N64_BL_ENEMIES) {
                    warn(`${st.key}: no entry left for enemy${letter}'s drop ${drop}; it drops what its first entry does`);
                    entryOf.set(`${letter}${drop}`, first);
                    continue;
                }
                const index = entries.length;
                entries.push(enemyEntryFromEditor(rec, { slots, size, frames: kept.length, drop }));
                entryOf.set(`${letter}${drop}`, index);
                if (first === null) first = index;
            }
            if (first !== null) stageEnemies.push({ letter, name: rec.name || null, entries: digits.map((d) => entryOf.get(`${letter}${d}`)), slots, size });
        }

        // The layout: every cell on the map layer at the frame its row scrolls in, x across the screen.
        for (const c of cells) {
            const index = entryOf.get(`${c.letter}${c.drop}`);
            if (index === undefined) continue;
            const x = width <= 1 ? 0 : Math.round(-N64_LAYOUT_HALF_WIDTH + (c.col * 2 * N64_LAYOUT_HALF_WIDTH) / (width - 1));
            placements.push({ enemy: index, x, y: N64_SPAWN_Y, frame: -(c.row * N64_FRAMES_PER_ROW) });
        }

        // Descending frame order, as the sample stages keep theirs; at most
        // 1000 between the enemies and the boss, which goes last.
        const boss = bossData[`boss${i}`] || null;
        placements.sort((a, b) => b.frame - a.frame);
        const room = LAYOUT_MAX_ENEMIES - (boss ? 1 : 0);
        if (placements.length > room) {
            warn(`${st.key}: a stage's layout holds ${LAYOUT_MAX_ENEMIES} enemies${boss ? " with the boss" : ""}; ${placements.length - room} dropped from the end`);
            placements.length = room;
        }

        // The boss: an entry with the stage-clear flag, after the last wave.
        let bossEntry = null;
        if (boss) {
            const names = (boss.anim && Array.isArray(boss.anim.idle) && boss.anim.idle.length ? boss.anim.idle : boss.texture) || [];
            const frames = names.map(lookup).filter(Boolean);
            if (!frames.length) warn(`${st.key}: boss${i} has no idle frame in the art`);
            const kept = spreadFrames(frames, Math.min(framesPerEnemy, frames.length));
            const slots = kept.map((f, k) => placeFrame(`boss${i}:${k}:${f.key}`, f));
            const size = frames.reduce((a, f) => Math.max(a, f.w, f.h), 64);
            if (entries.length >= N64_BL_ENEMIES) {
                warn(`${st.key}: no enemy entry left for boss${i}; the stage has no end`);
            } else {
                bossEntry = entries.length;
                entries.push(enemyEntryFromEditor(boss, { slots, size, frames: kept.length, boss: true }));
                placements.push({ enemy: bossEntry, x: 0, y: N64_BOSS_Y, frame: -((lastRow + BOSS_ROW_GAP) * N64_FRAMES_PER_ROW) });
            }
        }

        if (missed.length) warn(`${st.key}: the ${grExt} sheet or the ${mdExt} table ran out of room; not drawn: ${missed.join(", ")}`);

        // The map: a template stage's, else unset.
        let mapSettings = {}, map = [];
        const templateBl = templateFiles.get(blExt);
        if (templateBl) {
            try {
                const t = parseStageBl(templateBl);
                mapSettings = t.mapSettings;
                map = t.map;
            } catch (e) {
                warn(`${st.key}: the template's ${blExt} could not be read for its map (${e.message}); the map is unset`);
            }
        }

        built.set(grExt, sheet.bytes);
        built.set(mdExt, buildMdFile(models.models, models.textures));
        built.set(blExt, buildStageBl({ enemies: entries, layout: { map: placements }, mapSettings, map, effects: [] }));
        stageReports.push({
            key: st.key,
            stage,
            ext: grExt,
            enemies: gridLetters,
            boss: boss ? `boss${i}` : null,
            textures: sheet.placed,
            painted: sheet.painted,
            used: sheet.count - sheet.free,
            free: sheet.free,
            missed,
            scaled,
            records: {
                entries: entries.length,
                models: models.used,
                placements: placements.length,
                enemies: stageEnemies,
                bossEntry,
                map: templateBl ? "template" : "unset",
            },
        });
    });
    if (common.missed.length) warn(`the CGR sheet ran out of blank textures; not drawn: ${common.missed.join(", ")}`);

    // --- the common records ---
    const finalStage = STAGES[stages.length - 1];
    if (!templateFiles.has("CMD")) {
        const cmdModels = [], cmdTextures = [];
        for (const [slot, m] of cmd) {
            cmdModels[slot] = m.model;
            cmdTextures[slot] = m.texture;
        }
        for (let s = 0; s < cmdModels.length; s++) if (cmdModels[s] === undefined) cmdModels[s] = null;
        for (let s = 0; s < cmdTextures.length; s++) if (cmdTextures[s] === undefined) cmdTextures[s] = 0;
        built.set("CMD", buildCmdFile(cmdModels, cmdTextures));
    }
    if (!templateFiles.has("CBL")) {
        // The item entries point at the common models written above; when a
        // template's CMD is carried instead, those slots hold its models, not
        // the icons, so the items show nothing rather than something else.
        const items = {};
        if (!templateFiles.has("CMD")) {
            CBL_ITEMS.forEach((item, k) => {
                const slot = N64_ITEM_MODELS[k];
                if (cmd.has(slot)) items[item] = itemEntry(slot, N64_ITEM_SCALES[k]);
            });
        }
        built.set("CBL", buildCbl({ items }));
    }
    if (templateFiles.has("GAM")) {
        const gam = Uint8Array.from(templateFiles.get("GAM"));
        if (gam.length) gam[0] = finalStage;
        built.set("GAM", gam);
    } else {
        built.set("GAM", encodeGam({ finalStage }));
    }
    if (!templateFiles.has("MUS")) built.set("MUS", buildMusFile([]));
    if (!templateFiles.has("ULB")) built.set("ULB", buildUlbFile([], []));

    // --- every file ---
    const files = [];
    const sources = [];
    const sheets = new Set(["CGR", ...stages.map((_, i) => `${STAGES[i]}GR`)]);
    for (const ext of projectExts()) {
        /** @type {Uint8Array} */
        let data;
        /** @type {string} */
        let source;
        const fromTemplate = templateFiles.get(ext);
        if (ext === "CGR") {
            data = cgr.bytes;
            source = fromTemplate ? "art over template" : "art";
        } else if (built.has(ext)) {
            data = built.get(ext);
            if (sheets.has(ext)) source = fromTemplate ? "art over template" : "art";
            else if (ext === "GAM" && fromTemplate) source = "template, final stage set";
            else source = "records";
        } else if (fromTemplate) {
            data = fromTemplate;
            source = "template";
        } else {
            data = new Uint8Array(fileSizeFor(ext) ?? 0);
            source = "blank";
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
        finalStage,
        common: { textures: cgr.placed, painted: cgr.painted, used: cgr.count - cgr.free, free: cgr.free, missed: common.missed, scaled: common.scaled, models: common.models },
        stages: stageReports,
        files: sources,
        bytes: files.reduce((a, f) => a + f.data.length, 0),
    };
    return { name, files, report, warnings };
}
