var exec = require("cordova/exec");

var SERVICE = "ApkForge";

function ensureCordova() {
    if (typeof cordova === "undefined") {
        throw new Error("ApkForge requires Cordova");
    }
}

var ApkForge = {
    isAvailable: function () {
        return typeof cordova !== "undefined"
            && cordova.platformId === "android";
    },

    checkInstallPermission: function (success, error) {
        ensureCordova();
        exec(success, error, SERVICE, "checkInstallPermission", []);
    },

    requestInstallPermission: function (success, error) {
        ensureCordova();
        exec(success, error, SERVICE, "requestInstallPermission", []);
    },

    // opts: { workDir: string }
    // Returns the absolute path of the working dir to receive staged blobs.
    prepareWorkdir: function (opts, success, error) {
        ensureCordova();
        exec(success, error, SERVICE, "prepareWorkdir", [opts || {}]);
    },

    // Write a single staged file (binary) into the workdir, base64-encoded.
    // opts: { relPath: "assets/level-data.json", base64: "..." }
    writeStagedFile: function (opts, success, error) {
        ensureCordova();
        exec(success, error, SERVICE, "writeStagedFile", [opts]);
    },

    // opts: {
    //   workDir, packageId, displayName, slug,
    //   iconBase64,                 // optional override; otherwise hue-shift bundled icon
    //   outFilename: "<slug>.apk"
    // }
    // onProgress receives { phase, percent, message } objects.
    build: function (opts, onProgress, error) {
        ensureCordova();
        var success = function (msg) {
            if (msg && msg.phase === "done") {
                if (onProgress) onProgress(msg);
            } else if (msg && typeof msg === "object") {
                if (onProgress) onProgress(msg);
            }
        };
        exec(success, error, SERVICE, "build", [opts]);
    },

    // opts: { uri: "content://..." }
    install: function (opts, success, error) {
        ensureCordova();
        exec(success, error, SERVICE, "install", [opts]);
    },

    cancel: function (success, error) {
        ensureCordova();
        exec(success, error, SERVICE, "cancel", []);
    }
};

module.exports = ApkForge;
