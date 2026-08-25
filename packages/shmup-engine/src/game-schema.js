// Executable schema for the level editor's game.json shape. Zero-dep and
// environment-neutral so the CLI tests, the browser importer, and CI can all
// share it. The canary test validates the shipped assets/game.json, keeping
// this in sync with reality.

// A cell is "<letters><drop digit>", or "00" for empty. One letter is the
// historical form; keys go two letters wide past enemyZ so a save's whole
// roster fits (see lib/map-to-game.js).
const CELL_RE = /^(00|[A-Z]+[0-9])$/;
const ENEMY_KEY_RE = /^enemy[A-Z]+$/;
const BOSS_KEY_RE = /^boss(\d+|Extra)$/;
const STAGE_KEY_RE = /^stage(\d+)$/;
// BootScene plays stage0..stage9 (Dezaemon 2's own maximum).
const MAX_STAGE_ID = 9;
// The widest grid the runtime lays out across the 256px playfield.
const MAX_GRID_COLS = 20;

function isObj(v) {
    return v !== null && typeof v === "object" && !Array.isArray(v);
}

function isTextureArray(v) {
    return Array.isArray(v) && v.length > 0 && v.every((t) => typeof t === "string" && t.length > 0);
}

export function validateGameJson(g) {
    const errors = [];
    const warnings = [];
    const err = (m) => errors.push(m);
    const warn = (m) => warnings.push(m);

    if (!isObj(g)) {
        return { ok: false, errors: ["game.json root must be an object"], warnings };
    }

    // --- enemyData (validated first so stage cells can cross-reference) ---
    const enemyLetters = new Set();
    if (!isObj(g.enemyData)) {
        err("enemyData must be an object");
    } else {
        const keys = Object.keys(g.enemyData);
        for (const k of keys) {
            if (!ENEMY_KEY_RE.test(k)) {
                err(`enemyData key "${k}" must match enemy[A-Z]+`);
                continue;
            }
            enemyLetters.add(k.slice(5));
            const e = g.enemyData[k];
            if (!isObj(e)) { err(`${k} must be an object`); continue; }
            // "infinity" is a runtime sentinel for indestructible enemies.
            if (!Number.isFinite(e.hp) && e.hp !== "infinity") err(`${k}.hp must be a number or "infinity"`);
            if (!Number.isFinite(e.score)) err(`${k}.score must be a number`);
            if (!isTextureArray(e.texture)) err(`${k}.texture must be a non-empty string array`);
        }
    }

    // --- stages ---
    const stageKeys = Object.keys(g).filter((k) => STAGE_KEY_RE.test(k));
    if (!g.stage0) err("stage0 is required");
    for (const k of stageKeys) {
        const num = Number(k.match(STAGE_KEY_RE)[1]);
        if (num > MAX_STAGE_ID) {
            warn(`${k} is unreachable in Phaser (BootScene clamps stages to 0..${MAX_STAGE_ID})`);
        }
        const st = g[k];
        if (!isObj(st) || !Array.isArray(st.enemylist) || st.enemylist.length === 0) {
            err(`${k}.enemylist must be a non-empty array of rows`);
            continue;
        }
        // Rows are as wide as the level says, but every row in a stage has to
        // agree — the runtime spreads one row across the screen and reads the
        // width off it.
        const width = Array.isArray(st.enemylist[0]) ? st.enemylist[0].length : 0;
        if (!(width >= 1 && width <= MAX_GRID_COLS)) {
            err(`${k}.enemylist rows must be 1..${MAX_GRID_COLS} cells wide (got ${width})`);
            continue;
        }
        st.enemylist.forEach((row, r) => {
            if (!Array.isArray(row) || row.length !== width) {
                err(`${k}.enemylist[${r}] must be an array of exactly ${width} cells`);
                return;
            }
            row.forEach((cell, c) => {
                if (typeof cell !== "string" || !CELL_RE.test(cell)) {
                    err(`${k}.enemylist[${r}][${c}] = ${JSON.stringify(cell)} is not "00" or "<A-Z…><0-9>"`);
                } else if (cell !== "00" && !enemyLetters.has(cell.slice(0, -1))) {
                    err(`${k}.enemylist[${r}][${c}] references enemy${cell.slice(0, -1)}, which is not in enemyData`);
                }
            });
        });
        // Pacing, when present, is one scroll row per wave.
        if (st.waveRows !== undefined) {
            if (!Array.isArray(st.waveRows) || st.waveRows.length !== st.enemylist.length) {
                err(`${k}.waveRows must have one entry per wave (${st.enemylist.length})`);
            } else if (!st.waveRows.every((n) => Number.isInteger(n) && n >= 0)) {
                err(`${k}.waveRows entries must be non-negative integers`);
            }
        }
        if (st.waveInterval !== undefined && !(Number.isFinite(st.waveInterval) && st.waveInterval > 0)) {
            err(`${k}.waveInterval must be a positive number`);
        }
        // Imported scenery: a base64 tile grid over backgroundCells.
        if (st.background !== undefined) {
            const bg = st.background;
            if (!isObj(bg) || !Number.isInteger(bg.cols) || !Number.isInteger(bg.rows) ||
                bg.cols < 1 || bg.rows < 1 || typeof bg.tiles !== "string") {
                err(`${k}.background must be {cols, rows, tiles} with a base64 tile grid`);
            } else if (!Array.isArray(g.backgroundCells) || g.backgroundCells.length === 0) {
                err(`${k}.background needs a non-empty top-level backgroundCells list`);
            } else {
                // base64 of rows*cols u16be words
                const expect = Math.ceil((bg.rows * bg.cols * 2) / 3) * 4;
                if (bg.tiles.length !== expect) {
                    err(`${k}.background.tiles is ${bg.tiles.length} chars; ${bg.rows}x${bg.cols} words need ${expect}`);
                }
            }
        }
    }

    // --- playerData ---
    if (!isObj(g.playerData)) {
        err("playerData must be an object");
    } else {
        const p = g.playerData;
        if (!Number.isFinite(p.maxHp)) err("playerData.maxHp must be a number");
        if (!isTextureArray(p.texture)) err("playerData.texture must be a non-empty string array");
        for (const shoot of ["shootNormal", "shootBig", "shoot3way"]) {
            if (!isObj(p[shoot]) || !isTextureArray(p[shoot].texture)) {
                err(`playerData.${shoot} must be an object with a non-empty texture array`);
            }
        }
        if (!isObj(p.barrier) || !isTextureArray(p.barrier.texture)) {
            err("playerData.barrier must be an object with a non-empty texture array");
        }
    }

    // --- bossData ---
    if (!isObj(g.bossData)) {
        err("bossData must be an object");
    } else {
        for (const [k, b] of Object.entries(g.bossData)) {
            if (!BOSS_KEY_RE.test(k)) { err(`bossData key "${k}" must match boss<N>/bossExtra`); continue; }
            if (!isObj(b)) { err(`${k} must be an object`); continue; }
            if (!Number.isFinite(b.hp)) err(`${k}.hp must be a number`);
            if (!isObj(b.anim) || !isTextureArray(b.anim.idle)) err(`${k}.anim.idle must be a non-empty string array`);
        }
        // The runtime spawns bossData["boss"+stageId] after each stage's last wave.
        for (const k of stageKeys) {
            const num = Number(k.match(STAGE_KEY_RE)[1]);
            if (num <= MAX_STAGE_ID && !g.bossData[`boss${num}`]) warn(`${k} has no matching boss${num} — boss spawn will fail`);
        }
    }

    // --- meta ---
    if (!isObj(g.meta) || typeof g.meta.version !== "string") err("meta.version must be a string");

    return { ok: errors.length === 0, errors, warnings };
}
