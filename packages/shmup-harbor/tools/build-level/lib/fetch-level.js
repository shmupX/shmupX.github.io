"use strict";

const https = require("https");
const http = require("http");
const { rtdbPath } = require("./rtdb-root");

// The database base. shmupX's own games are not at its root: the root-level
// levels and levelAliases are cmg's catalog (the database is shared with the
// sibling app), and shmupX's live under shmupX/ beside them — see
// lib/rtdb-root.js. So the base stays the database, and the root goes on the
// two paths below, the only ones this tool reads. A build must never fall
// back to the root copy: that would package cmg's version of a game, or one
// shmupX does not ship, with nothing in the log to say so.
const FIREBASE_DB_URL = "https://evil-invaders-default-rtdb.firebaseio.com";
const LEVELS_PATH = rtdbPath("levels");
const ALIASES_PATH = rtdbPath("levelAliases");

function fetchJSON(url) {
    return new Promise(function (resolve, reject) {
        const mod = url.startsWith("https") ? https : http;
        mod.get(url, function (res) {
            if (res.statusCode !== 200) {
                res.resume();
                reject(new Error("HTTP " + res.statusCode + " for " + url));
                return;
            }
            const chunks = [];
            res.on("data", function (c) { chunks.push(c); });
            res.on("end", function () {
                try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
                catch (e) { reject(e); }
            });
            res.on("error", reject);
        }).on("error", reject);
    });
}

function levelUrl(name) {
    return FIREBASE_DB_URL + "/" + LEVELS_PATH + "/" + encodeURIComponent(name) + ".json";
}

// The alias index is kept in lowercase (the editor and scripts/level-alias.ts
// write it that way); a level KEY is never lowercased, because "Ramsie" and
// "ramsie" have been two different records.
function aliasUrl(name) {
    return FIREBASE_DB_URL + "/" + ALIASES_PATH + "/" +
        encodeURIComponent(String(name).toLowerCase()) + ".json";
}

// The level a typed name means: shmupX/levels/<name>, else the key
// shmupX/levelAliases/<name lowercased> names — the runtime level-loader's
// steps (static/phaser-plugins/level-loader.js fetchLevel), so "2019" builds
// 2019-PS2 here exactly as ?level=2019 plays it on the site. This is the
// CommonJS twin of packages/shmup-harbor/lib/cloud-level.ts
// resolveCloudLevel; tests/cloud_level_test.ts drives both against one fake
// database and compares the URLs they ask for.
//
// A failed read of the level is thrown (a database that is down is not a
// missing level, and index.js exits 1 rather than 3 for it). A failed read of
// the alias index is a miss, as it is in the runtime. `get` is the reader,
// fetchJSON unless a test hands in its own.
async function resolveLevel(levelName, get) {
    const read = get || fetchJSON;
    const name = String(levelName == null ? "" : levelName);
    const data = name ? await read(levelUrl(name)) : null;
    if (data && data.enemylist) return { key: name, alias: null, data: data };
    let key = null;
    try {
        key = name ? await read(aliasUrl(name)) : null;
    } catch (_e) {
        key = null;
    }
    if (typeof key === "string" && key && key !== name) {
        const aliased = await read(levelUrl(key));
        if (aliased && aliased.enemylist) return { key: key, alias: name, data: aliased };
    }
    const err = new Error("Level \"" + name + "\" not found");
    err.code = "LEVEL_NOT_FOUND";
    throw err;
}

async function fetchLevel(levelName) {
    return (await resolveLevel(levelName)).data;
}

module.exports = {
    fetchLevel,
    resolveLevel,
    fetchJSON,
    levelUrl,
    aliasUrl,
    FIREBASE_DB_URL,
    LEVELS_PATH,
    ALIASES_PATH,
};
