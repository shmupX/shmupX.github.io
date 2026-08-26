// fs.js — local-file access for the CMG Desktop.
//
// Thin, promise-based wrapper over the File System Access API plus an
// IndexedDB pocket for the picked directory handle, so returning to
// /desktop/ can re-offer the same workspace with one permission click
// instead of a fresh directory picker. Chromium-only (Firefox/Safari have
// no showDirectoryPicker); callers check `supported` and degrade to
// read-only drag-drop imports.

export const supported = "showDirectoryPicker" in globalThis;

const DB_NAME = "cmg-desktop";
const STORE = "handles";
const WORKSPACE_KEY = "workspace";

function db() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(key, value) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbGet(key) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Ask the user for a directory and remember it as the workspace. */
export async function pickWorkspace() {
  const handle = await globalThis.showDirectoryPicker({ mode: "readwrite" });
  try {
    await idbPut(WORKSPACE_KEY, handle);
  } catch (_e) { /* persistence is best-effort */ }
  return handle;
}

/**
 * The workspace from a previous visit, if its handle survived in IndexedDB.
 * Returns { handle, granted } — when granted is false the caller must call
 * requestPermission(handle) from a user gesture before touching files.
 */
export async function restoreWorkspace() {
  let handle;
  try {
    handle = await idbGet(WORKSPACE_KEY);
  } catch (_e) {
    return null;
  }
  if (!handle) return null;
  try {
    const state = await handle.queryPermission({ mode: "readwrite" });
    return { handle, granted: state === "granted" };
  } catch (_e) {
    return null;
  }
}

export async function requestPermission(handle) {
  const state = await handle.requestPermission({ mode: "readwrite" });
  return state === "granted";
}

/** Directory listing, folders first, each name-sorted. */
export async function listDir(dirHandle) {
  const dirs = [], files = [];
  for await (const entry of dirHandle.values()) {
    (entry.kind === "directory" ? dirs : files).push(entry);
  }
  const byName = (a, b) => a.name.localeCompare(b.name);
  return [...dirs.sort(byName), ...files.sort(byName)];
}

export async function readFileText(fileHandle) {
  const file = await fileHandle.getFile();
  return { text: await file.text(), size: file.size, lastModified: file.lastModified };
}

export async function readFileBlob(fileHandle) {
  return await fileHandle.getFile();
}

export async function writeFileText(fileHandle, text) {
  const w = await fileHandle.createWritable();
  await w.write(text);
  await w.close();
}

export async function writeFileBlob(fileHandle, blob) {
  const w = await fileHandle.createWritable();
  await w.write(blob);
  await w.close();
}

export async function createFile(dirHandle, name) {
  return await dirHandle.getFileHandle(name, { create: true });
}

export async function createDir(dirHandle, name) {
  return await dirHandle.getDirectoryHandle(name, { create: true });
}

export async function removeEntry(dirHandle, name, isDir) {
  await dirHandle.removeEntry(name, isDir ? { recursive: true } : undefined);
}

/** True if `name` is taken in `dirHandle`, by a file or a directory. */
export async function exists(dirHandle, name) {
  for (const get of ["getFileHandle", "getDirectoryHandle"]) {
    try {
      await dirHandle[get](name);
      return true;
    } catch (e) {
      // TypeMismatchError means the name exists as the *other* kind.
      if (e?.name === "TypeMismatchError") return true;
    }
  }
  return false;
}

/**
 * Rename via handle.move() where the browser has it; files fall back to
 * copy + delete. Directory renames have no fallback (deep copy is not worth
 * the foot-gun) — callers surface the returned error string.
 */
export async function renameEntry(dirHandle, entry, newName) {
  // Both paths below overwrite an existing target silently — check first so a
  // rename can't destroy another file.
  if (await exists(dirHandle, newName)) {
    return `"${newName}" already exists in this folder.`;
  }
  if (typeof entry.move === "function") {
    try {
      await entry.move(dirHandle, newName);
      return null;
    } catch (e) {
      if (entry.kind === "directory") return String(e.message || e);
      // fall through to copy for files
    }
  }
  if (entry.kind === "directory") {
    return "This browser cannot rename folders — make a new one and move files over.";
  }
  const blob = await entry.getFile();
  const fresh = await dirHandle.getFileHandle(newName, { create: true });
  await writeFileBlob(fresh, blob);
  await dirHandle.removeEntry(entry.name);
  return null;
}

const TEXT_EXT = new Set([
  "js", "mjs", "cjs", "ts", "tsx", "jsx", "json", "html", "htm", "css",
  "svg", "md", "txt", "xml", "yml", "yaml", "toml", "ini", "csv", "tsv",
  "sh", "bash", "py", "rb", "go", "rs", "c", "h", "cpp", "hpp", "java",
  "svelte", "vue", "astro", "glsl", "vert", "frag", "tmx", "tsx", "gitignore",
  "env", "lock", "map", "log", "conf", "cfg", "atlas", "fnt",
]);
const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "avif", "svg"]);
const AUDIO_EXT = new Set(["mp3", "ogg", "wav", "m4a", "flac"]);

export function ext(name) {
  const i = name.lastIndexOf(".");
  return i === -1 ? "" : name.slice(i + 1).toLowerCase();
}

export function kindOf(name) {
  const e = ext(name);
  if (IMAGE_EXT.has(e)) return "image";
  if (AUDIO_EXT.has(e)) return "audio";
  if (TEXT_EXT.has(e) || !e) return "text";
  return "binary";
}

export function fmtSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
