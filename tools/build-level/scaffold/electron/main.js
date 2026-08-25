const { app, BrowserWindow, screen, protocol, net, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");
const { execSync } = require("child_process");

// ---------------------------------------------------------------------------
// Chromium flags for gamepad / handheld support
// ---------------------------------------------------------------------------
app.commandLine.appendSwitch("enable-gamepad-extensions");
app.commandLine.appendSwitch("enable-features", "WebHID,GamepadAPI");
app.commandLine.appendSwitch("disable-background-timer-throttling");

// ---------------------------------------------------------------------------
// Clear Steam environment variables so the AppImage can launch its own
// Chromium process without conflicting with Steam's runtime libraries.
// ---------------------------------------------------------------------------
var STEAM_ENV_PREFIXES = ["STEAM_", "SteamApp", "PRESSURE_VESSEL_", "LD_PRELOAD"];
for (var key of Object.keys(process.env)) {
    if (STEAM_ENV_PREFIXES.some(function (p) { return key.startsWith(p); })) {
        delete process.env[key];
    }
}

// ---------------------------------------------------------------------------
// Custom protocol — serves www/ files with a real origin so ES module
// imports work (file:// blocks them due to CORS).
// ---------------------------------------------------------------------------
protocol.registerSchemesAsPrivileged([{
    scheme: "app",
    privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
    },
}]);

// ---------------------------------------------------------------------------
// Portrait rotation via xrandr (Linux only)
// On landscape handhelds like the Legion Go the display must be rotated so
// the fullscreen window is portrait.  We rotate before creating the window
// and restore on exit.  When the display is already portrait (or xrandr is
// unavailable) this is a no-op.
// ---------------------------------------------------------------------------
var rotated = false;
var displayOutput = null;

function getDisplayOutput() {
    try {
        var out = execSync("xrandr --query", { timeout: 3000 }).toString();
        var m = out.match(/^(\S+)\s+connected\s+primary/m);
        if (m) return m[1];
        m = out.match(/^(\S+)\s+connected/m);
        return m ? m[1] : null;
    } catch (e) {
        return null;
    }
}

function rotateToPortrait() {
    if (process.platform !== "linux") return;
    displayOutput = getDisplayOutput();
    if (!displayOutput) return;

    var display = screen.getPrimaryDisplay();
    if (display.size.width > display.size.height) {
        try {
            execSync("xrandr --output " + displayOutput + " --rotate right",
                { timeout: 3000 });
            rotated = true;
        } catch (e) {
            // xrandr unavailable (Wayland / Gamescope) — CSS hack is the fallback
        }
    }
}

function restoreRotation() {
    if (!rotated || !displayOutput) return;
    try {
        execSync("xrandr --output " + displayOutput + " --rotate normal",
            { timeout: 3000 });
    } catch (e) {}
    rotated = false;
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------
function createWindow() {
    rotateToPortrait();

    // Register the custom protocol handler for www/ files
    var wwwRoot = path.join(__dirname, "www");
    protocol.handle("app", function (request) {
        var filePath = decodeURIComponent(
            new URL(request.url).pathname
        );
        return net.fetch("file://" + path.join(wwwRoot, filePath));
    });

    var win = new BrowserWindow({
        fullscreen: true,
        autoHideMenuBar: true,
        frame: false,
        icon: path.join(__dirname, "icons", "icon-512.png"),
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, "preload.js"),
        },
    });

    win.loadURL("app://game/phaser-game.html?level=foo");

    win.webContents.on("did-finish-load", function () {
        // When xrandr physically rotated the display, mark <html> so the
        // CSS rotation fallback is skipped (it would double-rotate).
        // When xrandr failed, do NOT add any class — let the CSS rotation
        // hack in phaser-game.html handle portrait layout.
        if (rotated) {
            win.webContents.executeJavaScript(
                "document.documentElement.classList.add('electron-rotated')"
            );
        }
        // Trigger manual canvas scaling (Phaser uses Scale.NONE)
        win.webContents.executeJavaScript(
            "window.__fitCanvas && window.__fitCanvas()"
        );
    });
}

// ---------------------------------------------------------------------------
// Custom audio: read MP3 files from <userData>/custom-audio/ directory.
// Users place files named by audio key (e.g. boss_bison_bgm.mp3) and
// BootScene picks them up via window.electronAudio.loadCustomAudio().
// ---------------------------------------------------------------------------
ipcMain.handle("load-custom-audio", async function () {
    var audioDir = path.join(app.getPath("userData"), "custom-audio");
    var entries = {};

    try {
        fs.mkdirSync(audioDir, { recursive: true });
    } catch (e) {}

    var files;
    try {
        files = fs.readdirSync(audioDir);
    } catch (e) {
        return entries;
    }

    for (var i = 0; i < files.length; i++) {
        var file = files[i];
        if (!file.endsWith(".mp3")) continue;
        var key = file.slice(0, -4); // strip .mp3
        try {
            var buf = fs.readFileSync(path.join(audioDir, file));
            entries[key] = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
        } catch (e) {
            console.warn("Failed to read custom audio file:", file, e);
        }
    }

    return entries;
});

app.whenReady().then(createWindow);

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------
app.on("will-quit", restoreRotation);
app.on("window-all-closed", function () {
    restoreRotation();
    app.quit();
});

process.on("SIGINT", function () { restoreRotation(); process.exit(); });
process.on("SIGTERM", function () { restoreRotation(); process.exit(); });
