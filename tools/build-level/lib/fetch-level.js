"use strict";

const https = require("https");
const http = require("http");

const FIREBASE_DB_URL = "https://evil-invaders-default-rtdb.firebaseio.com";
const LEVELS_PATH = "levels";

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

async function fetchLevel(levelName) {
    const url = FIREBASE_DB_URL + "/" + LEVELS_PATH + "/" + encodeURIComponent(levelName) + ".json";
    const data = await fetchJSON(url);
    if (!data || !data.enemylist) {
        const err = new Error("Level \"" + levelName + "\" not found");
        err.code = "LEVEL_NOT_FOUND";
        throw err;
    }
    return data;
}

module.exports = { fetchLevel, fetchJSON, FIREBASE_DB_URL, LEVELS_PATH };
