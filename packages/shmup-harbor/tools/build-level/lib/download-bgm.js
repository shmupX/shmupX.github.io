"use strict";

// Per-level custom BGM downloader. Adapted from scripts/download-custom-bgm.js
// but (a) takes an already-fetched level object, (b) writes into an arbitrary
// output dir, (c) produces the same manifest.json format that BootScene reads.

const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");
const crypto = require("crypto");

function downloadFile(url, dest) {
    return new Promise(function (resolve, reject) {
        let mod = url.startsWith("https") ? https : http;
        function request(requestUrl, redirectCount) {
            if (redirectCount > 5) { reject(new Error("Too many redirects for " + url)); return; }
            mod.get(requestUrl, function (res) {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    const nextUrl = res.headers.location;
                    mod = nextUrl.startsWith("https") ? https : http;
                    res.resume();
                    request(nextUrl, redirectCount + 1);
                    return;
                }
                if (res.statusCode !== 200) {
                    const err = new Error("HTTP " + res.statusCode + " downloading " + url);
                    err.statusCode = res.statusCode;
                    res.resume();
                    reject(err);
                    return;
                }
                const file = fs.createWriteStream(dest);
                res.pipe(file);
                file.on("finish", function () { file.close(function () { resolve(); }); });
                file.on("error", function (e) { fs.unlink(dest, function () {}); reject(e); });
            }).on("error", reject);
        }
        request(url, 0);
    });
}

async function downloadBgmForLevel(levelData, outDir) {
    if (!levelData || !levelData.customAudioURLs) {
        return { manifest: {}, downloaded: 0 };
    }
    fs.mkdirSync(outDir, { recursive: true });
    const urls = levelData.customAudioURLs;
    const keys = Object.keys(urls).filter(k => urls[k] && typeof urls[k] === "string");
    const manifest = {};
    const urlToFile = {};
    let downloaded = 0;
    for (const key of keys) {
        const url = urls[key];
        if (urlToFile[url]) { manifest[key] = urlToFile[url]; continue; }
        const filename = crypto.createHash("sha1").update(url).digest("hex").slice(0, 16) + ".mp3";
        const dest = path.join(outDir, filename);
        if (!fs.existsSync(dest)) {
            try {
                console.log("  fetching " + key + " -> " + filename);
                await downloadFile(url, dest);
                downloaded++;
            } catch (e) {
                console.warn("  skip " + key + ": " + e.message);
                continue;
            }
        }
        urlToFile[url] = filename;
        manifest[key] = filename;
    }
    fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
    return { manifest, downloaded };
}

module.exports = { downloadBgmForLevel };
