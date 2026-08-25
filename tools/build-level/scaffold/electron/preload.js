// Preload script — runs in renderer context before page scripts.
// Exposes a custom audio filesystem API so the AppImage/Steam build
// can load user-provided MP3 overrides from disk without nodeIntegration.

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAudio", {
    // Returns { key: ArrayBuffer } for every .mp3 in the custom-audio dir
    loadCustomAudio: function () {
        return ipcRenderer.invoke("load-custom-audio");
    },
});
