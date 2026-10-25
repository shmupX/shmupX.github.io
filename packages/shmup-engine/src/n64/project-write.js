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
//   #MD        a billboard per placed frame: a quad the size of the sprite
//              lying on the ground plane, its texels from its texture,
//              numbered from 40 as the game counts them (records.js
//              billboardModel; booted, CONFIRMED)
//   #BL        an enemy entry per enemy letter (one per drop digit on its
//              cells, as the Saturn writer does, because an entry carries
//              one item), its frames' model numbers, score, HP, speed, a
//              shot when it fires, the item it drops; the boss with the
//              stage-clear flag; the layout of every cell on the map layer
//              at the scroll its row comes on at, in the ship's plane (its
//              height, N64_PLANE_Y), entries numbered from 20;
//              the opening scene (N64_STAGE_SCENE) and the stage's story as
//              portrait effects (storyEffects), no other effect; the map
//              carried from a template stage or left unset
//   CMD, CBL   the ship and the item icons as common models 10 and 12..18 —
//              the slots the cartridge's own game uses — with the seven item
//              entries pointing at them; over a template's CMD in those
//              slots, its CBL carried (the sample's items name 12..18)
//   GAM        a template's in the cartridge's layout (the prototype's is
//              nine bytes short: records.js repairPrototypeGam), else the
//              cartridge's initial game (gamDefaults); the final stage set,
//              the player on model 10, and the HUD's stock ship — a sprite
//              in the CGR sheet where the GAM points — the level's ship
//   MUS, ULB   a template's, else blank songs and an empty library
//
// Where a number here is a reading rather than a measurement it is named in
// a constant below with its evidence. The two that matter most: model
// numbers in an entry are 20 + the stage's model slot (the sample game's
// stage entries name 20..148 almost exclusively and its seven items 12..18,
// so the common CMD is read as coming first — booted, a sprite's entry
// shows its model); a layout entry's y is its height, and only an enemy at
// the ship's (800 under the stage's opening altitude) can be shot, its x
// within the ship's reach (booted 2026-10-25), and the frame offset is a
// scroll distance counting DOWN from the start, entries in descending order
// (measured on the sample's three stages, the scroll booted). Booted in
// mupen64plus-next 2026-10-20/21/25: FORMAT-N64.md "What the writer does not
// write" is the list of what is still carried rather than built.
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
    EFFECT_ENTRIES,
    encodeGam,
    ENEMY_SCORE_TABLE,
    GAM_OFFSETS,
    GAM_SPRITES,
    LAYOUT_MAX_ENEMIES,
    MAP_TEXTURE_UNSET,
    MD_MODEL_COUNT,
    parseCmdFile,
    parseStageBl,
    repairPrototypeGam,
} from "./records.js";
import { bossBodyFrames, bossWeapons, splitBossStage2, weaponTextures } from "../boss-stage2.js";
import { foldToAscii, renderText } from "../story/bitmap-font.js";

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

/** The common model slots the cartridge's own game gives the ship (GAM player.models[0] = 10) and the seven items (CBL's item entries name 12..18; so do the sample's). (likely) */
export const N64_PLAYER_MODEL = 10;
export const N64_ITEM_MODELS = Object.freeze([12, 13, 14, 15, 16, 17, 18]);

/**
 * The scale every sprite flies at in the ship's plane (N64_PLANE_Y): the
 * ship's in GAM and every enemy entry's. A sprite is a billboard of
 * N64_UNITS_PER_PIXEL units a pixel, and the ship's plane is near the
 * camera: booted 2026-10-25, gs's 32 x 50 ship at 100 drew about 82 px
 * across and an invader at the ship's height about as much over, so 40 draws
 * either near its own size. The cartridge's own 66 and the sample's 61 are
 * for their 3D ships. (measured)
 */
export const N64_SPRITE_SCALE = 40;

/**
 * GAM's sprite tables (shots, blasts, the HUD's stock icons …) address the
 * CGR sheet as an atlas 128 px wide: a band of 32 px is two textures side
 * by side, texture 2k on the left and 2k + 1 on the right. The cartridge's
 * default coordinates (y 0x1C0..0x260) fall on textures 28..39, which is
 * where the sample's sheet keeps its shots and blasts, and its 16 x 16 stock
 * ship and bomb sit at (0, 0x260) and (16, 0x260): the top left of texture
 * 38. (confirmed by the sample's art)
 */
export const N64_SPRITE_ATLAS_WIDTH = 2 * TILE_WIDTH;
/** The HUD's stock icons, one per life and per bomb: 16 x 16. (confirmed by the sample's art) */
export const N64_STOCK_ICON = 16;

/**
 * A sprite-atlas pixel -> the texture it lies in and where in it, or null
 * outside the atlas's `textures`.
 * @param {number} x
 * @param {number} y
 * @param {number} [textures]
 * @returns {{texture: number, x: number, y: number}|null}
 */
export function spriteAtlasTexel(x, y, textures = N64_CGR_TEXTURES) {
    if (x < 0 || y < 0 || x >= N64_SPRITE_ATLAS_WIDTH) return null;
    const texture = Math.floor(y / TILE_HEIGHT) * 2 + Math.floor(x / TILE_WIDTH);
    if (texture >= textures) return null;
    return { texture, x: x % TILE_WIDTH, y: y % TILE_HEIGHT };
}

/**
 * The title's atlas goes on past the CGR sheet's 20 bands into stage 0's
 * #GR sheet, laid out the same way: GAM's title pictures (their "image UL
 * ypos"), its title backdrop and ending pictures (in "128x32 blocks"), and a
 * stage map's texture byte all count 128 x 32 bands in it, stage band
 * b - 20 being that stage's textures 2(b - 20) and 2(b - 20) + 1. Booted
 * 2026-10-25: the sample's colour and silver "SOLID GEAR" logos sit at its
 * title y 928 and 992, stage 0's bands 9 and 11, and its title backdrop 20
 * is a 128 x 128 picture from stage 0's band 0, its sky and clouds; story
 * art laid over bands 1-3 showed through the backdrop. (confirmed)
 */
export const N64_CGR_BANDS = N64_CGR_TEXTURES / 2;
/** A title picture: 128 x 64, two bands. (confirmed by the sample's logos) */
export const N64_TITLE_W = N64_SPRITE_ATLAS_WIDTH;
export const N64_TITLE_H = 2 * TILE_HEIGHT;

/** A band of the title atlas -> the two stage textures it is, or null for a CGR band or one past the sheet. */
export function stageBandTextures(band) {
    const k = band - N64_CGR_BANDS;
    if (!(k >= 0) || 2 * k + 1 >= N64_GR_TEXTURES) return null;
    return [2 * k, 2 * k + 1];
}

/**
 * Words as a title picture, 128 x 64: in `font`, scaled up as far as they
 * fit on one line or two (split at a space), gold to orange with a dark
 * edge and a drop shadow, the way a cartridge logo reads.
 * @param {{glyphW: number, glyphH: number, glyphs: Uint8Array[]}} font  src/story/bitmap-font.js
 * @param {string} words
 * @returns {{w: number, h: number, rgba: Uint8Array}}
 */
export function titleWordsPicture(font, words) {
    const W = N64_TITLE_W, H = N64_TITLE_H, margin = 3, gap = 2;
    const text = foldToAscii(String(words || "")).trim().replace(/\s+/g, " ");
    const layouts = [[text]];
    const spaces = [...text.matchAll(/ /g)].map((m) => m.index);
    if (spaces.length) {
        // two lines, split at the space that balances them best
        const at = spaces.reduce((a, b) => (Math.abs(2 * b - text.length) < Math.abs(2 * a - text.length) ? b : a));
        layouts.push([text.slice(0, at), text.slice(at + 1)]);
    }
    let best = null;
    for (const lines of layouts) {
        const widest = Math.max(...lines.map((l) => l.length)) * font.glyphW;
        const tall = lines.length * font.glyphH;
        const scale = Math.floor(Math.min((W - 2 * margin) / widest, (H - 2 * margin - gap * (lines.length - 1)) / tall));
        if (scale >= 1 && (!best || scale > best.scale)) best = { lines, scale };
    }
    const out = { w: W, h: H, rgba: new Uint8Array(W * H * 4) };
    if (!best || !text) return out;
    const { lines, scale } = best;
    const ink = new Uint8Array(W * H); // 1 where a letter is
    const row = new Int16Array(W * H).fill(-1); // the pixel's height within its line, for the gradient
    const lineH = font.glyphH * scale;
    const blockH = lines.length * lineH + gap * (lines.length - 1);
    lines.forEach((line, n) => {
        const mask = renderText(font, line, line.length * font.glyphW, font.glyphH);
        const x0 = Math.floor((W - line.length * font.glyphW * scale) / 2);
        const y0 = Math.floor((H - blockH) / 2) + n * (lineH + gap);
        for (let y = 0; y < lineH; y++) {
            for (let x = 0; x < line.length * font.glyphW * scale; x++) {
                if (!mask.data[(Math.floor(y / scale) * mask.width + Math.floor(x / scale)) * 4 + 3]) continue;
                const at = (y0 + y) * W + x0 + x;
                ink[at] = 1;
                row[at] = y;
            }
        }
    });
    const put = (at, rgb) => out.rgba.set([rgb[0], rgb[1], rgb[2], 255], at * 4);
    const shadow = Math.max(1, scale >> 1);
    const near = (x, y, d) => {
        for (let dy = -d; dy <= d; dy++) {
            for (let dx = -d; dx <= d; dx++) {
                const X = x + dx, Y = y + dy;
                if (X >= 0 && Y >= 0 && X < W && Y < H && ink[Y * W + X]) return true;
            }
        }
        return false;
    };
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            const at = y * W + x;
            if (ink[at]) {
                const t = row[at] / Math.max(1, lineH - 1); // gold at the top, orange-red at the foot
                put(at, [255, Math.round(232 - 150 * t), Math.round(96 - 80 * t)]);
            } else if (near(x, y, 1)) {
                put(at, [48, 16, 0]); // the edge
            } else if (x >= shadow && y >= shadow && near(x - shadow, y - shadow, 1)) {
                put(at, [0, 0, 0]); // the shadow, down and right
            }
        }
    }
    return out;
}

/**
 * Whether an art frame is an item icon. The writer lays the first eight it
 * meets, in the art's own order, into the CGR sheet, and the first seven
 * become the item models; no record names them, so a caller hands them over
 * beside the frames the records ask for — the editor's art is the whole base
 * atlas, build:ddd asks the base atlas for every frame this takes.
 * @param {string} key
 * @returns {boolean}
 */
export function isN64ItemFrame(key) {
    return /item|powerup|speedup|1up/i.test(key);
}

/**
 * A sprite pixel in model units: 32 px becomes a 320-unit quad, about the
 * sample's ordinary enemies, and at N64_SPRITE_SCALE in the ship's plane a
 * sprite draws near its own size (booted). (likely)
 */
export const N64_UNITS_PER_PIXEL = 10;

/**
 * The layout's x across the screen: the ship's own reach, x -223..223
 * (booted 2026-10-25), less a little. The sample's map layers run about
 * -400..430, but their enemies fly below the ship, where the view is wider;
 * in the ship's plane an enemy past its reach could not be shot. (measured)
 */
export const N64_LAYOUT_HALF_WIDTH = 220;
/**
 * Where every enemy and the boss are placed: in the ship's plane. A layout
 * entry's y is its height over the ground, and the ship and its shots fly
 * at the height the stage's altitude effect sets — 800 under
 * N64_STAGE_SCENE's altitude 10 (booted 2026-10-25: altitude 5 put the ship
 * at 0, 8 at 400, 10 at 800). An enemy at 240, where this writer placed them
 * before, passed under the shot and under the ship; at 800 it is shot down.
 * The entry's own altitude byte (0, 4 or 8) made no difference at either
 * height. (measured)
 */
export const N64_PLANE_Y = 800;
/**
 * A placement row (16 px) in scroll units. A layout's "frame" is how far its
 * layer has scrolled, and a stage scrolls 20 a frame at 30 frames a second
 * (booted), 600 a second; the Saturn scrolls 60 px a second, so a row is
 * 160 and the two consoles pace a level the same way. (confirmed rate,
 * likely pairing)
 */
export const N64_SCROLL_PER_ROW = 160;

/**
 * The opening scene every stage gets at frame 0: the sample's city stage's
 * own first camera — altitude 10, its fog, the camera neutral (angle and
 * zoom 0, rotation 10). Booted 2026-10-21: without a scene effect a stage
 * shows nothing on its ground, sprites included; with these the sprites
 * draw. (confirmed)
 */
export const N64_STAGE_SCENE = Object.freeze([
    Object.freeze({ frame: 0, command: "altitude", values: Object.freeze([10, 7, 0, 0]) }),
    Object.freeze({ frame: 0, command: "fog", values: Object.freeze([56, 24, 0, 0]) }),
    Object.freeze({ frame: 0, command: "cameraZoom", values: Object.freeze([0, 0, 3, 0]) }),
    Object.freeze({ frame: 0, command: "cameraAngle", values: Object.freeze([0, 0, 3, 0]) }),
    Object.freeze({ frame: 0, command: "cameraRotation", values: Object.freeze([0, 10, 1, 0]) }),
]);

/**
 * One texture numbering for models and portraits: 0-39 the CGR sheet, 40-299
 * a stage's #GR tiles, tile = number - 40. Booted 2026-10-20: a portrait
 * naming 140 drew #GR tile 100; the sample's stage models name 103-299, which
 * only a numbering from 40 keeps inside 260 tiles. (confirmed)
 */
export const N64_GR_TEXTURE_BASE = N64_CGR_TEXTURES;

/**
 * A layout's enemy numbers: 0-19 the common CBL enemies, 20 on the stage's
 * own entries. The sample's layouts name 20..173 only and its third stage
 * places its stage-clear entry, 51, as 71; booted 2026-10-20, a stage entry
 * placed as 20 + k came on with its model. (confirmed)
 */
export const N64_ENEMY_NUMBER_BASE = N64_CBL_ENEMIES;

// --- a stage's story -------------------------------------------------------------------------
// A cart opens a stage on its story painted into its first map rows; this
// disk's scenery is a 3D ground, so its story is what the sample game's
// boss briefings are: forty `portrait` layout effects in one frame, a 64x32
// texture a cell, covering the screen, then one effect clearing them all.
// Booted 2026-10-20 in mupen64plus-next (FORMAT-N64.md "A level's story"):
// portraits set at frame 0 show from the stage's first frame, over the 3D
// scene and the HUD; the clear takes them all down; the clock is 30 Hz.

/** The portrait grid: 5 x 8 cells of 64x32, 320x256, of which the screen shows 320x240. */
export const N64_STORY_COLS = 5;
export const N64_STORY_ROWS = 8;
export const N64_STORY_W = N64_STORY_COLS * TILE_WIDTH;
export const N64_STORY_H = 240;

/** A portrait names its texture in one byte: #GR tiles 0..215 only. */
export const N64_PORTRAIT_MAX_TEXTURE = 0xff;

/** A cell's portrait position: row * 10 + column, the columns 32 px apart, so a 64-px texture takes every other one. (confirmed by the boot) */
export function portraitPosition(row, col) {
    return row * 10 + col * 2;
}

/** Portrait flags (file formats.txt): 1 set, 2 composite (else opaque), 4 wipe, 8 clear all. The story sets opaque and instant; the clear is the sample briefings' own, all with a wipe. */
export const N64_PORTRAIT_SET = 1;
export const N64_PORTRAIT_CLEAR = Object.freeze([0xff, 0xff, 0, 12]);

/** Effect frames count at 30 a second: the stage clock the effects run on advanced 30 a second in the boot. (confirmed) */
export const N64_EFFECT_FPS = 30;

/**
 * How long a story stays up, in effect frames: four seconds and a frame for
 * every two characters of its words (about the pace the web's typewriter
 * shows them), between six and fifteen seconds. The stage's own fade in from
 * white takes the first second and a half of it (booted).
 */
export const N64_STORY_BASE_FRAMES = 4 * N64_EFFECT_FPS;
export const N64_STORY_MIN_FRAMES = 6 * N64_EFFECT_FPS;
export const N64_STORY_MAX_FRAMES = 15 * N64_EFFECT_FPS;

/**
 * The map layer's scroll rate once a story has gone. A stage with no scroll
 * effect advances every layer 20 a frame, and so does rate 3 (both booted),
 * so the stage goes on as it would have; `[0, 7]` holds it while the story
 * is up. (confirmed)
 */
export const N64_SCROLL_RATE = 3;

/**
 * Where a layer's scroll stands as its stage starts: the map held from frame
 * 0 stood at 404 (booted). A placement comes on once its layer's scroll
 * passes -frame (likely), so a story stage's layout is moved this much
 * further on: nothing comes on behind the story, the first wave after it.
 */
export const N64_SCROLL_START = 404;

/** A story's frames for the words it carries. */
export function storyFrames(parts = []) {
    const chars = parts.join(" ").length;
    return clamp(N64_STORY_BASE_FRAMES + Math.ceil(chars / 2), N64_STORY_MIN_FRAMES, N64_STORY_MAX_FRAMES);
}

/**
 * A story variant (src/story/story-panels.js: {w <= 320, h <= 240, rgba})
 * as the portrait grid: centred on an opaque black 320x240, cut into the
 * forty 64x32 textures row-major. Identical cells (the black border, mostly)
 * share one texture: `cells[k]` is the index into `textures` of cell k.
 * @param {{w: number, h: number, rgba: Uint8Array|Uint8ClampedArray}} variant
 * @returns {{cells: number[], textures: Uint8Array[]}}
 */
export function storyScreen(variant) {
    const w = N64_STORY_W, h = N64_STORY_ROWS * TILE_HEIGHT;
    const rgba = new Uint8Array(w * h * 4);
    for (let i = 3; i < rgba.length; i += 4) rgba[i] = 0xff;
    const x0 = Math.floor((w - variant.w) / 2), y0 = Math.floor((N64_STORY_H - variant.h) / 2);
    for (let y = 0; y < variant.h; y++) {
        for (let x = 0; x < variant.w; x++) {
            const s = (y * variant.w + x) * 4;
            if (variant.rgba[s + 3] < 128) continue;
            rgba.set([variant.rgba[s], variant.rgba[s + 1], variant.rgba[s + 2], 0xff], ((y0 + y) * w + x0 + x) * 4);
        }
    }
    const { tiles } = textureGrid({ w, h, rgba });
    const textures = [], seen = new Map(), cells = [];
    for (const t of tiles) {
        const key = t.join(",");
        if (!seen.has(key)) {
            seen.set(key, textures.length);
            textures.push(t);
        }
        cells.push(seen.get(key));
    }
    return { cells, textures };
}

/**
 * The effects that show a story: at frame 0 the ship hidden, the map's
 * scroll held and the forty portraits; at `frames` the portraits cleared,
 * the ship back and the scroll going again.
 * @param {number[]} textureNumbers  each cell's texture number, row-major
 * @param {number} frames
 */
export function storyEffects(textureNumbers, frames) {
    const effects = [
        { frame: 0, command: "playerVisibility", values: [0, 0, 0, 0] },
        { frame: 0, command: "mapScrollRate", values: [0, 7, 0, 0] },
    ];
    textureNumbers.forEach((texture, k) => {
        const row = Math.floor(k / N64_STORY_COLS), col = k % N64_STORY_COLS;
        effects.push({ frame: 0, command: "portrait", values: [0, texture, portraitPosition(row, col), N64_PORTRAIT_SET] });
    });
    effects.push(
        { frame: frames, command: "portrait", values: [...N64_PORTRAIT_CLEAR] },
        { frame: frames, command: "playerVisibility", values: [1, 0, 0, 0] },
        { frame: frames, command: "mapScrollRate", values: [N64_SCROLL_RATE, 7, 0, 0] },
    );
    return effects;
}

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

/**
 * The billboard model for a sprite of w x h texture pixels, top-left in its
 * 64x32 texture: a quad lying on the ground plane, N64_UNITS_PER_PIXEL units
 * a pixel of the frame it was cut from (`shown`: a frame shrunk to fit its
 * texture keeps its size on screen, at the texture's resolution), on tile 1
 * (the sample models leave tile 0 blank) set to the whole texture (width
 * power 5, height power 6: 64 x 32), its UVs — texels — over the sprite's
 * own pixel box, the top row at the far edge. Booted 2026-10-21 (records.js
 * billboardModel). (confirmed)
 * @param {{w: number, h: number}} sprite
 * @param {number} [light]
 * @param {{w: number, h: number}} [shown]  the frame's own size; the sprite's by default
 */
export function spriteModel(sprite, light = 0, shown = sprite) {
    const w = Math.max(1, sprite.w), h = Math.max(1, sprite.h);
    const model = billboardModel({
        width: clamp(Math.max(1, shown.w) * N64_UNITS_PER_PIXEL, 1, 0x7fff),
        height: clamp(Math.max(1, shown.h) * N64_UNITS_PER_PIXEL, 1, 0x7fff),
        tileWidthPower: 5,
        tileHeightPower: 6,
        tile: 1,
        light,
    });
    model.faces[0].uv = [[0, h], [w, h], [w, 0]];
    model.faces[1].uv = [[0, h], [w, 0], [0, 0]];
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

    /**
     * Single textures for art that need not lie in a run — a portrait names
     * each cell's texture by itself, a model its one texture: blank ones
     * first, then painted ones `reclaim(index)` allows (a template's art
     * nothing this project writes points at), from the bottom up or, with
     * `fromTop`, from the top down; none past `max`. The textures this sheet
     * placed are never taken back.
     * @param {string} key
     * @param {Uint8Array[]} textures
     * @param {{max?: number, reclaim?: ((index: number) => boolean)|null, fromTop?: boolean}} [options]
     * @returns {{indices: number[], reclaimed: number}|null}  null when too few are left
     */
    claim(key, textures, { max = this.count - 1, reclaim = null, fromTop = false } = {}) {
        const ours = new Set();
        for (const p of this.placed) {
            for (const i of p.indices ?? Array.from({ length: p.textures }, (_, k) => p.index + k)) ours.add(i);
        }
        const blank = [], painted = [];
        for (let i = 0; i <= Math.min(max, this.count - 1); i++) {
            if (this.blank[i]) blank.push(i);
            else if (reclaim && !ours.has(i) && reclaim(i)) painted.push(i);
        }
        if (fromTop) painted.reverse();
        if (blank.length + painted.length < textures.length) return null;
        const indices = [...blank, ...painted].slice(0, textures.length);
        indices.forEach((i, k) => {
            this.bytes.set(textures[k], i * TILE_BYTES);
            this.blank[i] = false;
        });
        const reclaimed = Math.max(0, textures.length - blank.length);
        this.placed.push({ key, index: indices[0] ?? 0, cols: textures.length, rows: 1, textures: textures.length, indices, reclaimed });
        return { indices, reclaimed };
    }

    /**
     * A sprite painted at (x, y) of the sheet read as GAM's sprite atlas
     * (spriteAtlasTexel), over whatever is there, its clear pixels clearing
     * it: a HUD icon belongs where the GAM points, not where room is. The
     * textures it touches are no longer blank, so no frame is placed over it.
     * @param {{w: number, h: number, rgba: Uint8Array|Uint8ClampedArray}} sprite
     * @returns {number[]|null}  the textures painted, or null when the sprite runs off the atlas
     */
    paintAtlas(x, y, sprite) {
        const words = encodeRgba5551(sprite);
        const spots = [];
        for (let py = 0; py < sprite.h; py++) {
            for (let px = 0; px < sprite.w; px++) {
                const t = spriteAtlasTexel(x + px, y + py, this.count);
                if (!t) return null;
                spots.push([t, (py * sprite.w + px) * 2]);
            }
        }
        const touched = new Set();
        for (const [t, w] of spots) {
            const at = t.texture * TILE_BYTES + (t.y * TILE_WIDTH + t.x) * 2;
            this.bytes[at] = words[w];
            this.bytes[at + 1] = words[w + 1];
            this.blank[t.texture] = false;
            touched.add(t.texture);
        }
        return [...touched];
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
 * and for a boss the stage-clear and lock-on flags with a fixed motion. A
 * boss's shot is its projectileData, else its first weapon slot that names
 * art (bulletDataA, bulletData …, as the runtime's bossWeaponSlots reads
 * them), so a web boss armed only with those fires too.
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
    const armed = boss ? bossWeapons(r).find((w) => weaponTextures(w.weapon).length) : null;
    const proj = r.projectileData || (armed ? armed.weapon : null);
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
        scale: N64_SPRITE_SCALE,
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
 *             title (its app label), else its name
 *   template  a project's files to start from — [{ext, data}] or a Map of
 *             ext -> bytes, decompressed, as readProjects() + decompress()
 *             give them off a disk; null for none
 *   title1, title2  the title pictures as RGBA frames, each fitted to 128x64
 *             and painted where the GAM points (N64_CGR_BANDS)
 *   font      src/story/bitmap-font.js's face: with no title1, title 1 is
 *             `titleWords` (default the level's title, else its name) in it
 *             (titleWordsPicture) and title 2 is cleared
 *   titleWords  the words for a level with no logo
 *   framesPerEnemy  frames kept per enemy animation (4)
 *   storyBackdrops  [{stage, parts, variants: [{label, w, h, rgba}]}],
 *             src/story/story-panels.js: each stage's story, largest size first;
 *             stage <N> opens on the first size whose textures fit, as a
 *             full-screen portrait briefing (storyScreen, storyEffects)
 *
 * Returns {name, files: [{ext, data}], report, warnings}; the report's shape
 * is the literal at the end of this function, which is what a caller's type
 * checker sees.
 *
 * @param {object} level
 * @param {Record<string, {w: number, h: number, rgba: Uint8Array|Uint8ClampedArray}>} art
 * @param {{name?: string|null, template?: Array<{ext: string, data: Uint8Array}>|Map<string, Uint8Array>|null,
 *          title1?: object|null, title2?: object|null, framesPerEnemy?: number,
 *          font?: {glyphW: number, glyphH: number, glyphs: Uint8Array[]}|null, titleWords?: string|null,
 *          storyBackdrops?: Array<{stage: number, parts?: string[], variants: Array<{label: string, w: number, h: number, rgba: Uint8Array}>}>|null}} [options]
 */
export function buildN64ProjectFromLevel(level, art, options = {}) {
    const { template = null, title1 = null, title2 = null, framesPerEnemy = N64_FRAMES_PER_ENEMY, storyBackdrops = null, font = null, titleWords = null } = options;
    const warnings = [];
    const warn = (m) => warnings.push(m);
    const name = normalizeProjectName(options.name ?? ((level && (level.title || level.name)) || "SHMUPX"));

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
    /** @type {{stockShip: {x: number, y: number, textures: number[], key: string}}|null} */
    let hud = null; // the HUD sprites painted where the GAM points
    const cmd = new Map(); // common slot -> {model, texture}
    const placeCommon = (key, grid) => {
        const at = cgr.place(key, grid);
        if (at === null) common.missed.push(key);
        return at;
    };
    const frameNames = (v) => (Array.isArray(v) ? v : []); // a hand-edited record may carry a string here; the schema says a list
    let shipFrames = frameNames(((level && level.playerData) || {}).texture).map(lookup).filter(Boolean);
    let shipSource = "level";
    if (!shipFrames.length) {
        shipSource = "duke";
        shipFrames = decodePlayerArt().filter((f) => /^duke_\d$/.test(f.key)).slice(0, 2);
    }

    // --- GAM, first for where its sprites are ---
    // A template's in the cartridge's layout (the prototype's is nine bytes
    // short and read as it is would misplace everything after item 2's
    // score: repairPrototypeGam), else the cartridge's initial game. A
    // template GAM of a length neither layout explains is carried as it is
    // with only its final stage set.
    const templateGam = templateFiles.get("GAM") || null;
    const repaired = templateGam ? repairPrototypeGam(templateGam) : null;
    if (templateGam && !repaired) warn(`template GAM is ${templateGam.length} bytes, neither the cartridge's ${DOCUMENTED_SIZES.GAM} nor the prototype's; carried as it is, its ship and sprites unread`);
    const gam = Uint8Array.from(templateGam ? repaired ?? templateGam : encodeGam({}));
    const gamRepaired = !!repaired && repaired !== templateGam;
    const gamKnown = gam.length === DOCUMENTED_SIZES.GAM;
    const u16 = (b, at) => (b[at] << 8) | b[at + 1];

    // The HUD's stock ship — one per life — is the level's ship, at the
    // sprite the GAM names for it, before any frame is placed so none lands
    // under it.
    if (gamKnown && shipFrames.length) {
        const k = GAM_SPRITES.indexOf("playerStockShip");
        const x = u16(gam, GAM_OFFSETS.spriteX + k * 2), y = u16(gam, GAM_OFFSETS.spriteY + k * 2);
        const textures = cgr.paintAtlas(x, y, fitRgba(shipFrames[0], N64_STOCK_ICON, N64_STOCK_ICON));
        if (textures) hud = { stockShip: { x, y, textures, key: shipFrames[0].key } };
        else warn(`the GAM puts the stock ship at (${x}, ${y}), off the CGR sheet's sprite atlas; the HUD keeps what is there`);
    }

    // --- the title ---
    // The GAM points at its two title pictures in the title atlas (the CGR
    // sheet's bands, then stage 0's). The level's logo goes to title 1 and
    // its subtitle to title 2; a level with no logo has words for title 1
    // when a font is given (`titleWords`, else its own title or name) — a
    // donor's logo would otherwise name the donor's game ("SOLID GEAR" on
    // the prototype) — and title 2 is cleared so a donor's second logo does
    // not show through. With neither, the template's own title stays.
    const titleBands = []; // the bands the title's pictures and backdrop are read from, kept from reclaim
    const titleJobs = []; // {key, y, picture, source}: what to paint, and where
    /** @typedef {{source: string, sheet: string, y: number, textures: number[]}} TitlePicture */
    /** @type {{words: string|null, title1: TitlePicture|null, title2: TitlePicture|null}} */
    const title = { words: null, title1: null, title2: null };
    if (gamKnown) {
        const y1 = u16(gam, GAM_OFFSETS.title1Y), y2 = u16(gam, GAM_OFFSETS.title2Y);
        for (const y of [y1, y2]) titleBands.push(Math.floor(y / TILE_HEIGHT), Math.floor(y / TILE_HEIGHT) + 1);
        // The backdrop is a 128×128 picture from its band down: four bands.
        const backdrop = (gam[GAM_OFFSETS.titleBackgroundTexture] << 24 >> 16) | gam[GAM_OFFSETS.titleBackgroundTexture + 1];
        if (backdrop >= 0) for (let b = backdrop; b < backdrop + 4; b++) titleBands.push(b);
        if (gam[GAM_OFFSETS.ending] === 1) { // an ending of pictures: bands start..end
            for (let b = gam[GAM_OFFSETS.ending + 1]; b <= gam[GAM_OFFSETS.ending + 2]; b++) titleBands.push(b);
        }
        const logo = asFrame(title1), sub = asFrame(title2);
        const words = !logo && font ? String(titleWords ?? ((level && (level.title || level.name)) || "")).trim() : "";
        const pic1 = logo ? fitRgba(logo, N64_TITLE_W, N64_TITLE_H) : words ? titleWordsPicture(font, words) : null;
        if (pic1) {
            title.words = logo ? null : words;
            titleJobs.push({ key: "title1", y: y1, picture: pic1, source: logo ? "logo" : "words" });
            // The cartridge's own GAM puts both pictures on one band; title 1 is the one kept.
            if (y2 !== y1) {
                const pic2 = sub ? fitRgba(sub, N64_TITLE_W, N64_TITLE_H) : { w: N64_TITLE_W, h: N64_TITLE_H, rgba: new Uint8Array(N64_TITLE_W * N64_TITLE_H * 4) };
                titleJobs.push({ key: "title2", y: y2, picture: pic2, source: sub ? "subtitle" : "cleared" });
            }
        }
    }
    const cgrTitleRows = N64_CGR_BANDS * TILE_HEIGHT;
    for (const job of titleJobs) {
        if (job.y + N64_TITLE_H <= cgrTitleRows) {
            const textures = cgr.paintAtlas(0, job.y, job.picture);
            title[job.key] = { source: job.source, sheet: "CGR", y: job.y, textures };
            job.done = true;
        } else if (job.y < cgrTitleRows) {
            warn(`the GAM puts ${job.key} across the CGR sheet's foot (y ${job.y}); not drawn`);
            job.done = true;
        }
    }
    spreadFrames(shipFrames, Math.min(2, shipFrames.length)).forEach((f, i) => {
        const t = spriteTexture(f);
        if (t.scaled) common.scaled.push(`ship:${i}:${f.key}`);
        const at = placeCommon(`ship:${i}:${f.key}`, t.grid);
        if (at !== null && i === 0) cmd.set(N64_PLAYER_MODEL, { model: spriteModel(t, 0, f), texture: at, key: `ship:${f.key}` });
    });
    const itemFrames = Object.entries(art || {}).filter(([k]) => isN64ItemFrame(k)).slice(0, 8);
    itemFrames.forEach(([k], i) => {
        const f = lookup(k);
        if (!f) return;
        const t = spriteTexture(f);
        if (t.scaled) common.scaled.push(`item:${decodeFrameKey(k)}`);
        const at = placeCommon(`item:${decodeFrameKey(k)}`, t.grid);
        if (at !== null && i < N64_ITEM_MODELS.length) {
            cmd.set(N64_ITEM_MODELS[i], { model: spriteModel(t, 0, f), texture: at, key: `item:${decodeFrameKey(k)}` });
        }
    });
    common.placed = cgr.placed;

    // --- a boss's second stage ---
    // A boss here is an enemy entry with the stage-clear flag: one set of
    // four animation models, no hit-point gate, no form, no part (FORMAT-N64.md
    // "A boss's second stage"). So a boss with a stage2 block becomes two
    // bosses either side of a stage break: its stage's boss is the first form
    // with the top of the bar, and a stage put in after it, with no waves,
    // has the second form for its boss with the rest, carrying the block's
    // weapons. The level's own stages come first: a split with no stage left
    // to go in stays one boss, and says so.
    const stagePlan = [];
    const splits = [];
    let spare = N64_STAGE_COUNT - stages.length;
    stages.forEach((st, i) => {
        const rec = bossData[`boss${i}`] || null;
        const split = rec ? splitBossStage2(rec) : null;
        if (split && spare <= 0) {
            warn(`${st.key}: boss${i} has a second stage, but the project's ${N64_STAGE_COUNT} stages are full — it flies its first form alone, the whole bar`);
        }
        if (!split || spare <= 0) {
            stagePlan.push({ st, boss: rec, bossKey: `boss${i}`, form: 0 });
            return;
        }
        spare--;
        const key = `${st.key}:stage2`;
        stagePlan.push({ st, boss: split.first, bossKey: `boss${i}`, form: 1 });
        stagePlan.push({ st: { key, enemylist: [] }, boss: split.second, bossKey: `boss${i}:stage2`, form: 2 });
        splits.push({ stage: st.key, into: key, name: rec.name || `boss${i}`, second: bossBodyFrames(split.second)[0] || "?", hp: [split.first.hp, split.second.hp] });
    });

    // --- the stages ---
    const stageReports = [];
    const built = new Map(); // ext -> bytes
    stagePlan.forEach(({ st, boss, bossKey, form }, i) => {
        const stage = STAGES[i];
        const grExt = `${stage}GR`, mdExt = `${stage}MD`, blExt = `${stage}BL`;
        const sheet = sheetFrom(grExt, N64_GR_TEXTURES);
        const models = new ModelTable(N64_MD_MODELS);
        const entries = []; // enemy entries, index = enemy number
        const placements = []; // {enemy, x, y, frame}
        const missed = [];
        const scaled = [];

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
        // A template's art this project can take back: it writes its own
        // models and carries none of the template's effects, so what stays in
        // use is the map's — a map byte names a band of the title atlas, two
        // textures (stageBandTextures) — and, on stage 0, the title's
        // pictures, backdrop and ending pictures, which are painted here
        // first.
        const mapTextures = new Set();
        for (const m of map) {
            if (m.texture === MAP_TEXTURE_UNSET) continue;
            for (const t of stageBandTextures(m.texture) ?? []) mapTextures.add(t);
        }
        if (i === 0) {
            for (const b of titleBands) for (const t of stageBandTextures(b) ?? []) mapTextures.add(t);
            for (const job of titleJobs) {
                if (job.done) continue;
                const textures = sheet.paintAtlas(0, job.y - N64_CGR_BANDS * TILE_HEIGHT, job.picture);
                if (!textures) {
                    warn(`the GAM puts ${job.key} at y ${job.y}, past stage 0's ${grExt} sheet; not drawn`);
                    continue;
                }
                title[job.key] = { source: job.source, sheet: grExt, y: job.y, textures };
                for (const t of textures) mapTextures.add(t);
            }
        }
        const unnamedByMap = (index) => !mapTextures.has(index);

        // A frame -> its texture and model slot; -1 for a frame that found no
        // room. Blank textures first, then a template's art the map does not
        // name, from the top of the sheet down so the tiles a story can name
        // (0-215) are the last taken.
        const placeFrame = (key, frame) => {
            if (models.used >= models.count) {
                missed.push(key); // no model slot left: the texture would show nothing
                return -1;
            }
            const t = spriteTexture(frame);
            if (t.scaled) scaled.push(key);
            let at = sheet.place(key, t.grid);
            if (at === null) {
                const got = sheet.claim(key, t.grid.tiles, { reclaim: unnamedByMap, fromTop: true });
                at = got ? got.indices[0] : null;
            }
            if (at === null) {
                missed.push(key);
                return -1;
            }
            return models.add(spriteModel(t, 0, frame), N64_GR_TEXTURE_BASE + at);
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
            const frames = frameNames(rec.texture).map(lookup).filter(Boolean);
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
            placements.push({ enemy: N64_ENEMY_NUMBER_BASE + index, x, y: N64_PLANE_Y, frame: -(c.row * N64_SCROLL_PER_ROW) });
        }

        // Descending frame order, as the sample stages keep theirs; at most
        // 1000 between the enemies and the boss, which goes last.
        placements.sort((a, b) => b.frame - a.frame);
        const room = LAYOUT_MAX_ENEMIES - (boss ? 1 : 0);
        if (placements.length > room) {
            warn(`${st.key}: a stage's layout holds ${LAYOUT_MAX_ENEMIES} enemies${boss ? " with the boss" : ""}; ${placements.length - room} dropped from the end`);
            placements.length = room;
        }

        // The boss: an entry with the stage-clear flag, after the last wave.
        let bossEntry = null;
        if (boss) {
            const names = boss.anim && Array.isArray(boss.anim.idle) && boss.anim.idle.length ? boss.anim.idle : frameNames(boss.texture);
            const frames = names.map(lookup).filter(Boolean);
            if (!frames.length) warn(`${st.key}: ${bossKey} has no idle frame in the art`);
            const kept = spreadFrames(frames, Math.min(framesPerEnemy, frames.length));
            const slots = kept.map((f, k) => placeFrame(`${bossKey}:${k}:${f.key}`, f));
            const size = frames.reduce((a, f) => Math.max(a, f.w, f.h), 64);
            if (entries.length >= N64_BL_ENEMIES) {
                warn(`${st.key}: no enemy entry left for ${bossKey}; the stage has no end`);
            } else {
                bossEntry = entries.length;
                entries.push(enemyEntryFromEditor(boss, { slots, size, frames: kept.length, boss: true }));
                placements.push({ enemy: N64_ENEMY_NUMBER_BASE + bossEntry, x: 0, y: N64_PLANE_Y, frame: -((lastRow + BOSS_ROW_GAP) * N64_SCROLL_PER_ROW) });
            }
        }

        if (missed.length) warn(`${st.key}: the ${grExt} sheet or the ${mdExt} table ran out of room; not drawn: ${missed.join(", ")}`);

        // The story: the stage's own (`stage<N>`, never a boss's split second
        // stage), at the largest size whose textures the sheet still has —
        // its blank textures, then a template's art the map does not name.
        let story = null;
        // Every stage opens on the scene its sprites need (N64_STAGE_SCENE).
        let effects = N64_STAGE_SCENE.map((e) => ({ frame: e.frame, command: e.command, values: [...e.values] }));
        const backdrop = /^stage\d+$/.test(st.key) && Array.isArray(storyBackdrops)
            ? storyBackdrops.find((b) => `stage${b.stage}` === st.key) || null
            : null;
        if (backdrop) {
            const max = N64_PORTRAIT_MAX_TEXTURE - N64_GR_TEXTURE_BASE;
            const tried = [];
            for (const v of backdrop.variants || []) {
                if (!(v.w <= N64_STORY_W && v.h <= N64_STORY_H)) {
                    tried.push(`${v.label} is ${v.w}x${v.h}, over the screen's ${N64_STORY_W}x${N64_STORY_H}`);
                    continue;
                }
                const screen = storyScreen(v);
                const got = sheet.claim(`${st.key}:story`, screen.textures, { max, reclaim: unnamedByMap });
                if (!got) {
                    tried.push(`${v.label} needs ${screen.textures.length} textures`);
                    continue;
                }
                const frames = storyFrames(backdrop.parts || []);
                // The scene's and the story's are the only effects this writer lays: 50 of a stage's 500.
                effects = [...effects, ...storyEffects(screen.cells.map((c) => N64_GR_TEXTURE_BASE + got.indices[c]), frames)].slice(0, EFFECT_ENTRIES);
                story = { size: v.label, textures: screen.textures.length, reclaimed: got.reclaimed, frames, seconds: Math.round(frames / N64_EFFECT_FPS) };
                break;
            }
            if (story) {
                // Nothing comes on behind the story: the scroll is held where
                // a stage starts, so the layout moves on past that.
                for (const p of placements) p.frame -= N64_SCROLL_START;
            } else {
                warn(`${st.key}: no size of its story fits the ${grExt} sheet's textures up to tile ${max} (${tried.join("; ") || "no sizes"}) — not drawn`);
            }
        }

        built.set(grExt, sheet.bytes);
        built.set(mdExt, buildMdFile(models.models, models.textures));
        built.set(blExt, buildStageBl({ enemies: entries, layout: { map: placements }, mapSettings, map, effects }));
        stageReports.push({
            key: st.key,
            stage,
            ext: grExt,
            enemies: gridLetters,
            boss: boss ? bossKey : null,
            ...(boss && form ? { form } : {}),
            textures: sheet.placed,
            painted: sheet.painted,
            used: sheet.count - sheet.free,
            free: sheet.free,
            missed,
            scaled,
            // the template's textures taken back, the story's among them
            reclaimed: sheet.placed.reduce((a, p) => a + (p.reclaimed ?? 0), 0),
            story,
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
    // The final stage as the files number it (8 for the eighth, since 7 is
    // skipped). The one sample — final stage 2 with stages 0, 1, 2 — cannot
    // tell a stage number from an index; they part only at the eighth. (likely)
    const finalStage = STAGES[stagePlan.length - 1];
    // The ship and the item icons are the level's: on their own in a CMD
    // written here, or over a template's in its slots 10 and 12..18 — its
    // other models, the shield's among them, kept. A template CMD that cannot
    // be read is carried as it is, and then the ship and the items show its
    // models.
    let cmdOverTemplate = false;
    const templateCmd = templateFiles.get("CMD") || null;
    if (!templateCmd) {
        const cmdModels = [], cmdTextures = [];
        for (const [slot, m] of cmd) {
            cmdModels[slot] = m.model;
            cmdTextures[slot] = m.texture;
        }
        for (let s = 0; s < cmdModels.length; s++) if (cmdModels[s] === undefined) cmdModels[s] = null;
        for (let s = 0; s < cmdTextures.length; s++) if (cmdTextures[s] === undefined) cmdTextures[s] = 0;
        built.set("CMD", buildCmdFile(cmdModels, cmdTextures));
    } else if (cmd.size) {
        try {
            const t = parseCmdFile(templateCmd);
            for (const [slot, m] of cmd) {
                t.models[slot] = m.model;
                t.textureIndices[slot] = m.texture;
            }
            built.set("CMD", buildCmdFile(t.models, t.textureIndices));
            cmdOverTemplate = true;
        } catch (e) {
            warn(`the template's CMD could not be read (${e.message}); carried as it is, so the ship and the items show its models`);
        }
    }
    const cmdOurs = !templateCmd || cmdOverTemplate;
    common.models = cmdOurs ? [...cmd.entries()].map(([slot, m]) => ({ slot, texture: m.texture, key: m.key })) : [];
    if (!templateFiles.has("CBL")) {
        // The item entries point at the common models written above; when a
        // template's CMD is carried as it is, those slots hold its models,
        // not the icons, so the items show nothing rather than something
        // else. A template's CBL is carried: the sample's items name 12..18.
        const items = {};
        if (cmdOurs) {
            CBL_ITEMS.forEach((item, k) => {
                const slot = N64_ITEM_MODELS[k];
                if (cmd.has(slot)) items[item] = itemEntry(slot, N64_ITEM_SCALES[k]);
            });
        }
        built.set("CBL", buildCbl({ items }));
    }
    // The GAM read above, its final stage set and — when the ship's model is
    // the level's — the player's four frames on it at N64_SPRITE_SCALE (the
    // cartridge's own [10, 0, 0, 0] would show model 0 for three frames, the
    // sample's 149 a stage model this project does not write). What it still
    // names and this does not write — the shield's models, the title
    // settings' textures — is in FORMAT-N64.md's list.
    const shipOurs = cmdOurs && cmd.has(N64_PLAYER_MODEL);
    if (gam.length) gam[GAM_OFFSETS.finalStage] = finalStage;
    if (gamKnown && shipOurs) {
        gam[GAM_OFFSETS.playerScale] = N64_SPRITE_SCALE >> 8;
        gam[GAM_OFFSETS.playerScale + 1] = N64_SPRITE_SCALE & 0xff;
        gam.fill(N64_PLAYER_MODEL, GAM_OFFSETS.playerModels, GAM_OFFSETS.playerModels + 4);
    }
    built.set("GAM", gam);
    if (!templateFiles.has("MUS")) built.set("MUS", buildMusFile([]));
    if (!templateFiles.has("ULB")) built.set("ULB", buildUlbFile([], []));

    // --- every file ---
    const files = [];
    const sources = [];
    const sheets = new Set(["CGR", ...stagePlan.map((_, i) => `${STAGES[i]}GR`)]);
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
            else if (ext === "GAM" && fromTemplate) {
                source = `template${gamRepaired ? " in the cartridge's layout" : ""}, final stage${gamKnown && shipOurs ? " and ship" : ""} set`;
            } else if (ext === "CMD" && fromTemplate) source = "template, ship and items set";
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
        common: { textures: cgr.placed, painted: cgr.painted, used: cgr.count - cgr.free, free: cgr.free, missed: common.missed, scaled: common.scaled, models: common.models, hud },
        gam: { repaired: gamRepaired, ship: gamKnown && shipOurs },
        // the title's pictures: {source: logo | words | subtitle | cleared, sheet, y, textures}, or null where the template's stays
        title,
        stages: stageReports,
        // How the project's bosses carry their second stages (boss-stage2.js).
        transform: splits.length
            ? `approximated: two chained bosses across a stage break (${splits.map((x) => `${x.stage} ${x.name}, then ${x.into} its second form ${x.second}`).join("; ")}); the bullets are the project's own two, not the weapons' art`
            : "none",
        splits,
        files: sources,
        bytes: files.reduce((a, f) => a + f.data.length, 0),
    };
    return { name, files, report, warnings };
}
