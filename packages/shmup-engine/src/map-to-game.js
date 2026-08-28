// Single source of truth for turning decoded Dezaemon 2 data into the level
// editor's game.json shape — used by both the CLI (--out) and the browser
// import flow, so their output is identical.
//
// Also owns buildBlankGame(), the editor's "New Game" seed: a minimal valid
// game whose enemy and boss records reference the shipped atlas, so they play
// in Phaser immediately. Its player is Duke (lib/player-art.js), whose frames
// are NOT in that atlas — a caller that seeds a game from here must also add
// decodePlayerArt() to the atlas, exactly as an import does with `sprites`.
//
// Schema facts this module enforces (see src/phaser/ for the runtime side):
//   - grid cells are "<UppercaseLetters><digit>" ("00" = empty). One letter is
//     the historical form (enemyA..enemyZ); keys spill into two letters
//     (enemyAA, enemyAB, ...) past 26, which is what lets a save keep all of
//     its enemy types instead of the first 26
//   - a stage's rows all have the same width; 8 is the historical width and
//     an import uses the Saturn playfield's own 14 columns
//   - the runtime reverses stage rows at load (the LAST json row spawns
//     first), so decoded spawn-order rows are written reversed — `waveRows`
//     is reversed in lockstep so a wave keeps the scroll row it came from
//   - BootScene plays stage0..stage9

import { DUKE_PLAYER, decodePlayerArt } from "./player-art.js";
import { ITEM_TYPE_DROPS } from "./decode/decode-stage.js";

export { decodePlayerArt, DUKE_PLAYER };

export const GRID_COLS = 8;          // blank-game / legacy grid width
export const MAX_STAGES = 10;        // Dezaemon's own maximum, and the runtime's
export const SINGLE_LETTER_ENEMIES = 26; // enemyA..enemyZ before keys go two-wide
export const BLANK_WAVES = 8;
// Frames of play per Dezaemon scroll row. The Saturn stage is 768 rows of
// 16px scrolled at ~2px/frame, so a row is ~8 frames; at that rate an imported
// stage runs about as long as it did on hardware.
export const FRAMES_PER_SOURCE_ROW = 8;

// The engine keeps every object's durability in one shared unit space, and
// the player's main shot carries its damage in the same per-object slot the
// zako keep their hp in (0x6090630). The shot's value is TRACED, not
// calibrated: the spawn at GAME.CMP +0x10bbe writes it from the five-entry
// power-level table at +0x6085e14 —
export const PLAYER_SHOT_DAMAGE_BY_LEVEL = [9, 12, 15, 18, 21];
// — so a full-power main shot is worth 21 units. Enemy LIFE decodes in the
// same units ([60,30,15,10,5,3,2,1]); the Phaser runtime's shots do 1 damage
// each, so LIFE maps to ceil(units / 21) hits: max-LIFE zako die in 3, like
// on hardware. (Big/pierce shots use other tables and carry power in the
// scale slot instead — see FORMAT.md "Player weapons".)
export const ENGINE_SHOT_DAMAGE =
    PLAYER_SHOT_DAMAGE_BY_LEVEL[PLAYER_SHOT_DAMAGE_BY_LEVEL.length - 1];
// A save picks its own weapon (settings +0x0F low nibble, decode-settings.js);
// decoded.settings.shotDamage carries that weapon's traced full-power value,
// falling back to ENGINE_SHOT_DAMAGE for weapons whose spawns are untraced.

// Saturn zako bullets cross the playfield in a couple of seconds; the
// runtime default of 1 px/frame takes eight, and slow bullets accumulate
// into the wall you cannot dodge. Global bullet-type speeds are not decoded
// yet, so imports use one Saturn-typical speed.
export const ENEMY_BULLET_SPEED = 2.5;

// Bijective base-26: 0 -> A, 25 -> Z, 26 -> AA, 27 -> AB, 701 -> ZZ, 702 -> AAA.
// Single letters first, so a small roster is byte-for-byte what it always was.
export function enemyLetters(index) {
    let n = index;
    let out = "";
    do {
        out = String.fromCharCode(65 + (n % 26)) + out;
        n = Math.floor(n / 26) - 1;
    } while (n >= 0);
    return out;
}

// The historical "New Game" player: the stock Evil Invaders ship, exactly as
// the Phaser 4 runtime draws it — player00..player05 are the idle animation
// Player.js builds, shot*/shotBig* are the bullet frames Bullet.js fires for
// each shoot mode, and barrier0..3 is the shield. Every one of these frames
// ships in assets/game_asset, so a game seeded with this record needs no extra
// art at all.
//
// Nothing here seeds it any more — a blank game and an import both fly
// DUKE_PLAYER (see BUILTIN_DEFAULTS below and the playerData assignment in
// mapSaveToGame). It stays exported because it is the one player record that is
// pure atlas references, which makes it the fallback for anywhere that cannot
// ship pixels alongside the record.
export const EVIL_INVADERS_PLAYER = {
    name: "G",
    maxHp: 3,
    spDamage: 50,
    defaultShootName: "normal",
    defaultShootSpeed: "speed_normal",
    texture: ["player00.gif", "player01.gif", "player02.gif", "player03.gif", "player04.gif", "player05.gif"],
    shootNormal: {
        name: "normal", damage: 1, hp: 1, interval: 23,
        texture: ["shot00.gif", "shot01.gif", "shot02.gif", "shot03.gif"],
    },
    shootBig: {
        name: "big", damage: 2, hp: 100, interval: 39,
        texture: ["shotBig00.gif", "shotBig01.gif", "shotBig02.gif", "shotBig03.gif"],
    },
    shoot3way: {
        name: "3way", damage: 1, hp: 1, interval: 31,
        texture: ["shot00.gif", "shot01.gif", "shot02.gif", "shot03.gif"],
    },
    barrier: {
        time: 4,
        texture: ["barrier0.gif", "barrier1.gif", "barrier2.gif", "barrier3.gif"],
    },
};

// Enemy and boss records copied from the shipped assets/game.json — every
// texture on those two exists in the stock game_asset atlas. The player is
// Duke, and his frames do not: they ride along in decodePlayerArt().
export const BUILTIN_DEFAULTS = {
    playerData: DUKE_PLAYER,
    starterEnemy: {
        name: "soliderA",
        score: 100,
        spgage: 4,
        hp: 1,
        speed: 0.8,
        interval: 300,
        texture: ["soliderA0.gif", "soliderA1.gif", "soliderA2.gif"],
        shadowReverse: true,
        shadowOffsetY: 10,
        bulletData: {
            score: 100, spgage: 2, hp: 1, speed: 1, damage: 1,
            texture: ["normalProjectile0.gif", "normalProjectile1.gif", "normalProjectile2.gif"],
        },
    },
    starterBoss: {
        name: "bison",
        score: 2200,
        spgage: 30,
        hp: 150,
        interval: 100,
        shadowReverse: true,
        shadowOffsetY: 50,
        anim: {
            idle: ["bison_idle0.gif", "bison_idle1.gif", "bison_idle2.gif", "bison_idle3.gif"],
            attack: ["bison_attack0.gif", "bison_attack1.gif"],
        },
        bulletData: {},
    },
};

const clone = (o) => JSON.parse(JSON.stringify(o));

export function emptyWave(cols = GRID_COLS) {
    return new Array(cols).fill("00");
}

// Minimal valid game: one stage of empty waves, the starter player/enemy/boss.
export function buildBlankGame(defaults = BUILTIN_DEFAULTS) {
    return {
        stage0: { enemylist: Array.from({ length: BLANK_WAVES }, emptyWave) },
        playerData: clone(defaults.playerData),
        enemyData: { enemyA: clone(defaults.starterEnemy) },
        bossData: { boss0: clone(defaults.starterBoss) },
        meta: { version: "1.0" },
        continueComment: "",
        continueCommentEn: "",
    };
}

function sanitizeSpriteKey(raw, used) {
    let base = String(raw || "sprite").replace(/\.(gif|png)$/i, "").replace(/[^A-Za-z0-9_-]/g, "_");
    if (!base) base = "sprite";
    let key = `${base}.gif`;
    for (let n = 2; used.has(key); n++) key = `${base}_${n}.gif`;
    used.add(key);
    return key;
}

const NUMERIC_ENEMY_FIELDS = ["score", "spgage", "hp", "speed", "interval", "shadowOffsetY"];

const toHex = (bytes) =>
    bytes ? Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("") : null;

// Environment-neutral base64 (Node has no btoa on old versions, browsers no
// Buffer). Used for the background tile grids.
const B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function bytesToBase64(bytes) {
    let out = "";
    for (let i = 0; i < bytes.length; i += 3) {
        const a = bytes[i];
        const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
        const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
        out += B64_ALPHABET[a >> 2] + B64_ALPHABET[((a & 3) << 4) | (b >> 4)] +
            (i + 1 < bytes.length ? B64_ALPHABET[((b & 15) << 2) | (c >> 6)] : "=") +
            (i + 2 < bytes.length ? B64_ALPHABET[c & 63] : "=");
    }
    return out;
}

// Map a decodeSave() result onto the editor's game.json shape.
// Returns { gameJson, sprites, warnings }; sprites is the (key-sanitized)
// list of {key, w, h, rgba} to add to the atlas.
//
// `defaults` supplies the enemy and boss records that decoded data is layered
// onto (starterEnemy / starterBoss); the player is not taken from it — see the
// DUKE_PLAYER assignment below.
export function mapSaveToGame(decoded, { defaults = BUILTIN_DEFAULTS, sourceEntry = null, importedAt = null } = {}) {
    const warnings = [];
    const usedKeys = new Set();

    // Sprites: sanitize + dedupe keys, keep .gif suffix (legacy atlas naming).
    const spriteKeyByIndex = [];
    const sprites = (decoded.sprites || []).map((s, i) => {
        const key = sanitizeSpriteKey(s.key || `deza_cg${i}`, usedKeys);
        spriteKeyByIndex[i] = key;
        return { key, w: s.w, h: s.h, rgba: s.rgba };
    });

    // Background tiles, appended after the save's sprites so decoded sprite
    // indices stay valid. backgroundCells maps each grid ordinal to its atlas
    // frame name.
    const backgroundCells = (decoded.bgCells || []).map((cell) => {
        const key = sanitizeSpriteKey(cell.key, usedKeys);
        sprites.push({ key, w: cell.w, h: cell.h, rgba: cell.rgba });
        return key;
    });

    // The player's own frames, appended so the save's sprite indices above stay
    // valid. They keep their real names (duke_0, bigProjectile_0.png, ...): the
    // record below references them by name, and none of them collide with a
    // frame in the stock game_asset atlas.
    const playerArt = decodePlayerArt();
    for (const frame of playerArt) {
        usedKeys.add(frame.key);
        sprites.push(frame);
    }

    // Enemies: one key per decoded type, enemyA..enemyZ then enemyAA onwards.
    // Nothing is rationed — a save's whole roster comes across.
    // Per-save shot damage: the save's own main weapon where decoded.
    const shotDamage = (decoded.settings && decoded.settings.shotDamage) || ENGINE_SHOT_DAMAGE;
    const decodedEnemies = decoded.enemies || [];
    const enemyData = {};
    const enemyLetterByIndex = [];
    decodedEnemies.forEach((e, i) => {
        const letters = enemyLetters(i);
        enemyLetterByIndex[i] = letters;
        const rec = clone(defaults.starterEnemy);
        if (e.name != null) rec.name = String(e.name);
        for (const f of NUMERIC_ENEMY_FIELDS) {
            if (Number.isFinite(e[f])) rec[f] = e[f];
        }
        // The save's own attributes, decoded from the 18-byte record
        // (decode-enemy.js). hp/score/speed/interval land on the fields the
        // runtime already reads; the full behavior record — fire config and
        // the speed/rotation/scale/direction change channels — rides on
        // dezaemon.behavior for the runtime's behavior driver.
        if (e.behavior) {
            // LIFE decodes in engine damage units; the runtime's shots do 1
            // damage, so convert to full-power-shot hits
            // ([60,30,15,10,5,3,2,1] -> [3,2,1,1,1,1,1,1]).
            rec.hp = Math.max(1, Math.ceil(e.behavior.hp / shotDamage));
            rec.score = e.behavior.score;
            // px/frame relative to the scrolling map; near-zero means the
            // enemy rides the scroll, which the runtime adds on top.
            rec.speed = Math.round(e.behavior.speed * 100) / 100;
            // Whether an enemy fires is the APPEARANCE's call (decode-enemy
            // .js); the runtime skips interval <= 0. Every fire type is a
            // volley pattern, including 0.
            rec.interval = e.behavior.fire.enabled ? e.behavior.fire.interval : -1;
            if (e.behavior.fire.enabled && rec.bulletData) {
                // The save's own global bullet config (byte4 & 3 picks one of
                // the three at settings +0x25; decode-settings.js). Hardware
                // px/frame = (4*rank + speedAdd*512)/512 with rank ~8+8*stage
                // at normal difficulty; the runtime playfield is twice the
                // Saturn's 240 visible px, so speeds double to keep crossing
                // times. Falls back to the legacy constant when undecoded.
                const cfg = decoded.settings && decoded.settings.bullets &&
                    decoded.settings.bullets.configs[e.behavior.fire.mode];
                rec.bulletData.speed = cfg
                    ? Math.round(((8 + 8 * e.stage) * 4 / 512 + cfg.speedAdd) * 2 * 100) / 100
                    : ENEMY_BULLET_SPEED;
            }
        }
        if (Array.isArray(e.spriteKeys) && e.spriteKeys.length) {
            rec.texture = e.spriteKeys.map((idx) =>
                typeof idx === "number" ? (spriteKeyByIndex[idx] || rec.texture[0]) : String(idx)
            );
        }
        // The save's own definition, verbatim. hp/speed/interval above still
        // come from the defaults because the 18-byte record's fields are not
        // named yet (FORMAT.md) — but the bytes are here rather than gone, so
        // the attributes can be filled in later without re-importing, and two
        // enemies that differ only in their attributes stay distinguishable.
        if (e.bytes || e.stage !== undefined) {
            rec.dezaemon = {
                stage: e.stage,
                record: e.record,
                placements: e.placements,
                attributes: toHex(e.bytes),
            };
            if (e.behavior) rec.dezaemon.behavior = clone(e.behavior);
        }
        enemyData[`enemy${letters}`] = rec;
    });
    if (Object.keys(enemyData).length === 0) {
        enemyData.enemyA = clone(defaults.starterEnemy);
    }

    // Stages: decoded spawn-order rows -> reversed json rows. Every stage the
    // save defines is emitted; the runtime plays stage0..stage9.
    const decodedStages = decoded.stages || [];
    if (decodedStages.length > MAX_STAGES) {
        warnings.push(
            `save has ${decodedStages.length} stages; the runtime plays ${MAX_STAGES} (stage0..stage${MAX_STAGES - 1}) — dropped ${decodedStages.length - MAX_STAGES}`
        );
    }
    const gameJson = {};
    const stageCount = Math.max(1, Math.min(decodedStages.length, MAX_STAGES));
    for (let s = 0; s < stageCount; s++) {
        const decodedStage = decodedStages[s] || {};
        const rows = decodedStage.rows || [];
        const cols = decodedStage.cols || (rows[0] ? rows[0].length : GRID_COLS);
        const enemylist = rows.map((row) => {
            const out = emptyWave(cols);
            for (let c = 0; c < Math.min(cols, row.length); c++) {
                const cell = row[c];
                if (!cell) continue;
                const letters = enemyLetterByIndex[cell.enemy];
                if (letters === undefined) continue;
                const drop = Number.isInteger(cell.drop) && cell.drop >= 0 && cell.drop <= 9 ? cell.drop : 0;
                out[c] = `${letters}${drop}`;
            }
            return out;
        });
        // Runtime spawns the LAST json row first — decoders emit spawn order.
        enemylist.reverse();
        const stage = {
            enemylist: enemylist.length ? enemylist : Array.from({ length: BLANK_WAVES }, () => emptyWave(cols)),
        };
        // Pacing: the scroll row each wave came from, reversed in lockstep with
        // enemylist. Without it every wave is evenly spaced and a stage's
        // rhythm — gaps of anywhere from 1 to 177 rows — is lost.
        if (Array.isArray(decodedStage.waveRows) && decodedStage.waveRows.length === rows.length && rows.length) {
            stage.waveRows = decodedStage.waveRows.slice().reverse();
            stage.waveInterval = FRAMES_PER_SOURCE_ROW;
        }
        if (decodedStage.items && decodedStage.items.length) stage.items = decodedStage.items;
        // The save's own scroll pacing: 192 curve bytes (one per 4 map rows;
        // bits 0-2 speed, bits 3-5 wave amplitude, bits 6-7 wave type — see
        // decode-stage.js "Scroll curve") plus the settings block's
        // (loop-start, end) extent pair in 256-px parts. The runtime scrolls
        // the background at the curve's own speeds, stops one screen short of
        // endPart in normal play and loops loopPart..endPart during the boss.
        // gameMode 2 saves override every byte with 0x02 on hardware; the
        // mode rides in meta.dezaemonSettings for the runtime to honor.
        if (decodedStage.scrollCurve && decodedStage.scrollCurve.length) {
            stage.scroll = { curve: bytesToBase64(decodedStage.scrollCurve) };
            const extent = decoded.settings && decoded.settings.stageExtents &&
                decoded.settings.stageExtents[s];
            if (extent) {
                stage.scroll.loopPart = extent.loopPart;
                stage.scroll.endPart = extent.endPart;
            }
            // NOTE the engine byte 0x060840C5==2 that substitutes a constant
            // 0x02 curve is a PLAY-STATE (demo/attract — the same byte holds
            // 6 in another engine state), not the settings game mode: mode-2
            // saves like DAIOH visibly ride their authored curves on
            // hardware. Normal play always consumes the curve.
        }
        // The save's own scenery: a compact tile grid (u16be words, base64;
        // bits 0-9 index backgroundCells, bit15/14 = h/v flip, 0xFFFF empty).
        // The runtime composes and scrolls it in place of the stock backdrop.
        const bgStage = (decoded.bgStages || [])[s];
        if (bgStage && bgStage.words) {
            const bytes = new Uint8Array(bgStage.words.length * 2);
            bgStage.words.forEach((w, i) => {
                bytes[i * 2] = w >> 8;
                bytes[i * 2 + 1] = w & 0xff;
            });
            stage.background = {
                cols: bgStage.cols,
                rows: bgStage.rows,
                tiles: bytesToBase64(bytes),
            };
        }
        gameJson[`stage${s}`] = stage;
    }

    // One boss per stage (runtime spawns bossData["boss" + stageId]). Stages
    // whose save places a boss get its own art; the rest keep the default so
    // the stage still ends.
    //
    // Every one of them is named dezaBoss<stage>, art or not: the slot keys
    // boss0..boss4 are also the STOCK game's bosses, and both the editor and
    // the boss viewer label a slot from that stock roster (Bison, Barlog,
    // Sagat, Vega, Fang) unless the record's own name says otherwise. Leaving
    // an art-less stage on the starter record's name would file it under
    // whichever stock boss shares its slot.
    const bossData = {};
    const bossByStage = new Map((decoded.bosses || []).map((b) => [b.stage, b]));
    for (let s = 0; s < stageCount; s++) {
        const rec = clone(defaults.starterBoss);
        rec.name = `dezaBoss${s}`;
        const decodedBoss = bossByStage.get(s);
        if (decodedBoss) {
            rec.dezaemon = { sizeClass: decodedBoss.sizeClass, row: decodedBoss.row, col: decodedBoss.col };
            if (decodedBoss.behavior) {
                // The save's own boss record (decode-boss.js): HP and score
                // land on the fields the runtime reads, and the full record
                // (HP-stage playlist, patterns, fire points, part spawns)
                // rides on dezaemon.boss for a future parts-aware runtime.
                // Boss HP sits in a different damage regime than the zako
                // (millions of units; how player shots scale against it is
                // untraced), so /1024 normalizes the 8-step ladder onto hit
                // counts around the stock bosses' 100-500 — still scaled by
                // the save's own weapon like the zako are.
                rec.dezaemon.boss = decodedBoss.behavior;
                rec.hp = Math.max(1, Math.ceil(decodedBoss.behavior.hp / (shotDamage * 1024)));
                rec.score = decodedBoss.behavior.score;
            }
            if (decodedBoss.partArt) {
                // Fire-point part art (types 3/4): record -> atlas frame
                // names, so the runtime can dress the destructible parts the
                // boss record spawns.
                const partArt = {};
                for (const [record, keys] of Object.entries(decodedBoss.partArt)) {
                    const frames = keys.map((i) => spriteKeyByIndex[i]).filter(Boolean);
                    if (frames.length) partArt[record] = frames;
                }
                if (Object.keys(partArt).length) rec.dezaemon.partArt = partArt;
            }
            if (Array.isArray(decodedBoss.spriteKeys) && decodedBoss.spriteKeys.length) {
                const frames = decodedBoss.spriteKeys
                    .map((idx) => spriteKeyByIndex[idx])
                    .filter(Boolean);
                if (frames.length) {
                    // Core frames are the boss's real animation loop. Fallback
                    // figure pieces (unpainted core) are separate forms, so
                    // idle holds only the first and attack the second — they
                    // must not flicker through as one animation.
                    rec.anim = decodedBoss.coreArt
                        ? { idle: frames, attack: frames }
                        : { idle: [frames[0]], attack: [frames[1] || frames[0]] };
                    // The runtime needs to know WHICH it got: an unpainted
                    // core fights invisible over the chamber scenery (the
                    // wall painting is the boss), so it hides the core sprite
                    // when this is false. Only written when art exists at all
                    // — a boss with no frames keeps the default starter art
                    // and must stay visible.
                    rec.dezaemon.coreArt = decodedBoss.coreArt === true;
                }
            }
        }
        bossData[`boss${s}`] = rec;
    }

    // A Dezaemon game has no adventure interludes — the Saturn goes straight
    // from stage to stage — so imports default to skipping AdvScene. The
    // editor's NO STORY toggle can flip it back.
    gameJson.noStory = true;

    // The save's own DRAWN title screen (TITLE 1/2 + credit strips from the
    // global sprite bank): atlas frame names for the runtime's title scene.
    if (decoded.titleArt) {
        const dezaemonTitle = {};
        for (const [role, idx] of Object.entries(decoded.titleArt)) {
            const key = spriteKeyByIndex[idx];
            if (key) dezaemonTitle[role] = key;
        }
        if (Object.keys(dezaemonTitle).length) gameJson.dezaemonTitle = dezaemonTitle;
    }

    // Player + bullets always come from the Duke character, never from
    // `defaults`. The editor derives `defaults` from whatever game is currently
    // open, and its player may be a custom one whose frames live only in that
    // level's atlas — which the import drops when it resets the atlas to make
    // room for the save's sprites. Seeding from it would leave the imported
    // game pointing at frames that no longer exist: an invisible ship firing
    // invisible shots. This character's frames travel with it, in `sprites`.
    gameJson.playerData = clone(DUKE_PLAYER);
    if (backgroundCells.length) gameJson.backgroundCells = backgroundCells;
    gameJson.enemyData = enemyData;
    gameJson.bossData = bossData;
    // The save's own soundtrack. The settings BGM table is three special
    // tracks then (main, boss) pairs per stage, every entry indexing sec6's
    // 24 song slots; only the songs the table references (and that hold any
    // notes) ship, as base64 of their raw 4228-byte slot. The runtime
    // (dezaemon-runtime.js) sequences them through WebAudio, and sfxSet picks
    // the synthesized effect bank (1 REAL / 2 COMIC / 3 SF).
    const sec6 = decoded.sections && decoded.sections[6] && decoded.sections[6].decompressed;
    if (decoded.settings && sec6 && decoded.songs) {
        const table = decoded.settings.bgmTable;
        const special = table.slice(0, 3);
        const stagePairs = [];
        for (let s2 = 0; s2 * 2 + 4 < table.length && s2 < stageCount; s2++) {
            stagePairs.push([table[3 + s2 * 2], table[4 + s2 * 2]]);
        }
        const used = new Set([...special, ...stagePairs.flat()]);
        const songs = {};
        for (const idx of used) {
            if (idx == null || idx < 0 || idx >= 24) continue;
            const song = decoded.songs[idx];
            if (!song || !song.noteCount) continue;
            songs[idx] = bytesToBase64(sec6.subarray(idx * 4228, (idx + 1) * 4228));
        }
        if (Object.keys(songs).length) {
            // Song timing is engine-traced (decode-song.js): header byte 3
            // indexes the kernel's divisor table, header byte 2 is the echo
            // send. Both live inside the raw song bytes the runtime parses,
            // so `tempos` here is informational (step seconds per song).
            const tempos = {};
            for (const idx of Object.keys(songs)) tempos[idx] = decoded.songs[idx].stepSeconds;
            gameJson.dezaemonBgm = {
                sfxSet: decoded.settings.sfxSet,
                special,
                stages: stagePairs,
                songs,
                tempos,
            };
        }
    }

    // The save's three global bullet configs + blast anims, one record for
    // the whole game (decode-settings.js `bullets`): per config the damage
    // in durability units, the speed add in px/frame, and the editor flag.
    // The runtime reads configs[fire.mode] to pace and arm enemy volleys.
    if (decoded.settings && decoded.settings.bullets) {
        gameJson.dezaemonBullets = clone(decoded.settings.bullets);
    }

    // Item data the runtime needs beyond the per-cell drop digits: the
    // game-wide score-item value (settings +0x24) and the decoded slot table.
    if (decoded.settings && decoded.settings.itemSlots) {
        gameJson.dezaemonItems = {
            score: decoded.settings.scoreItemValue,
            slots: clone(decoded.settings.itemSlots),
        };
    }

    // The save's own global art (bank refs 0-143, decode-sprites.js
    // extractGlobalArt): the player ship replaces Duke's frames, the item
    // icons dress the drops, and each global bullet type gets its 4-frame
    // anim. Duke's frames still ride along as the fallback art.
    if (decoded.globalArt) {
        const art = decoded.globalArt;
        const keysOf = (indices) =>
            (indices || []).map((i) => (i != null ? spriteKeyByIndex[i] : null));
        if (art.player && art.player.idle) {
            const idle = keysOf(art.player.idle).filter(Boolean);
            if (idle.length) {
                gameJson.playerData.texture = idle;
                gameJson.playerData.name = "dezaShip";
            }
        }
        if (gameJson.dezaemonBullets && art.bullets) {
            gameJson.dezaemonBullets.art = art.bullets.map((frames) => {
                const keys = keysOf(frames).filter(Boolean);
                return keys.length ? keys : null;
            });
        }
        if (gameJson.dezaemonBullets && (art.blastA || art.blastB)) {
            gameJson.dezaemonBullets.blastArt = {};
            if (art.blastA) gameJson.dezaemonBullets.blastArt.a = keysOf(art.blastA).filter(Boolean);
            if (art.blastB) gameJson.dezaemonBullets.blastArt.b = keysOf(art.blastB).filter(Boolean);
        }
        if (gameJson.dezaemonItems && art.items) {
            const icons = keysOf(art.items);
            gameJson.dezaemonItems.icons = icons;
            // drop digit -> icon: the first configured slot of each type wins
            const iconByDrop = {};
            decoded.settings.itemSlots.forEach((slot, s) => {
                const drop = ITEM_TYPE_DROPS[slot.type];
                if (drop != null && icons[s] && iconByDrop[drop] === undefined) {
                    iconByDrop[drop] = icons[s];
                }
            });
            if (Object.keys(iconByDrop).length) gameJson.dezaemonItems.iconByDrop = iconByDrop;
        }
    }

    gameJson.meta = { version: "1.0", source: "dezaemon2" };
    if (decoded.settings) {
        gameJson.meta.dezaemonSettings = {
            gameMode: decoded.settings.gameMode,
            // gameMode decoded (2026-08-28): bit0 = horizontal scroller,
            // bit1 = two players
            horizontal: (decoded.settings.gameMode & 1) !== 0,
            twoPlayer: (decoded.settings.gameMode & 2) !== 0,
            staffRoles: decoded.settings.staffRoles,
            mainWeapon: decoded.settings.mainWeapon,
            mainWeapon2P: decoded.settings.loadouts
                ? decoded.settings.loadouts[decoded.settings.ships[1].startLoadout].main
                : undefined,
            shotDamage,
            sfxSet: decoded.settings.sfxSet,
        };
    }
    if (decoded.title) gameJson.meta.sourceTitle = decoded.title;
    if (sourceEntry) {
        gameJson.meta.sourceComment = sourceEntry.comment;
        gameJson.meta.sourceFilename = sourceEntry.filename;
    }
    if (importedAt) gameJson.meta.importedAt = importedAt;
    gameJson.continueComment = "";
    gameJson.continueCommentEn = "";

    // A save can parse perfectly — container, block chain, section table,
    // decompression — and still yield less than the whole game, because parts
    // of the section *meaning* are still being reverse-engineered (FORMAT.md,
    // "sec5 region map"). Falling back to engine defaults without saying so
    // looks like a successful import right up until you press play, so name
    // each gap.
    // Counted from the save, not from `sprites` — that list always carries the
    // player's own frames, so it is never empty.
    const savedSprites = (decoded.sprites || []).length;
    if (!savedSprites) {
        warnings.push(
            decodedEnemies.length
                ? "no CG/sprite data decoded for these enemies — using the default art " +
                  "(their identity and placement are real)"
                : "no CG/sprite data decoded from this save — using the default art"
        );
    }
    {
        const decodedAttrs = decodedEnemies.filter((e) => e.behavior).length;
        if (decodedEnemies.length && !decodedAttrs) {
            warnings.push(
                "enemy attribute records did not decode — every imported enemy uses the default stats"
            );
        }
    }
    if (!decodedEnemies.length) {
        warnings.push("no enemy table decoded from this save — using the default starter enemy");
    }
    if (!decodedStages.length) {
        warnings.push(
            "no stage layout decoded from this save — every wave is empty, so nothing will spawn"
        );
    }
    if (decoded.settings && (decoded.settings.gameMode & 1)) {
        warnings.push(
            "this is a HORIZONTAL-scroll save (game mode bit 0) — the runtime still " +
            "plays it as a vertical scroller, so its stages will read sideways"
        );
    }
    if (!savedSprites && !decodedEnemies.length && !decodedStages.length) {
        warnings.push(
            "this import carries the save's identity but none of its content yet; " +
            "decoding the section contents is still open work (see FORMAT.md)"
        );
    }

    return { gameJson, sprites, warnings };
}
