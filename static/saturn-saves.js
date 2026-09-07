// The Saturn player's save memory, reached from outside the emulator.
//
// The launcher's Sega Saturn section is EmulatorJS running the yabause
// libretro core. That core has one backup memory — the console's internal
// 32 KB (its only cartridge options are DRAM expansions; there is no backup
// cart) — and the frontend persists it as "<content name>.srm": the 64 KB
// 0xFF-interleaved image FormatBackupRam() lays out, kept in an Emscripten
// IDBFS mounted at /data/saves. IDBFS is an ordinary IndexedDB database:
// its name is the mount point, its one object store FILE_DATA is keyed by
// absolute path, and a file is a { timestamp, mode, contents } record. So the
// save is reachable from any same-origin page while the emulator is closed,
// which is how the editor exports a level straight into it.
//
// WHY THE FILE, NOT THE CORE
// yabause only reads its backup RAM at boot (the frontend copies the .srm
// into it) and writes it back on its own schedule. Editing the file between
// runs is the one hand-off that cannot race the core: the next boot loads
// what is here. A running player would eventually overwrite it with its
// in-memory copy, which is why callers tell the user to close one first.
//
// WHY THIS IS MOSTLY A DEAD END FOR GAMES — AND STILL HERE
// A Dezaemon 2 game payload is never smaller than ~90 KB (eight sections at
// the LZSS floor; the engine's MIN_GAME_PAYLOAD_BYTES), and the empty
// internal memory holds 29,550 bytes (INTERNAL_RAM_PAYLOAD_CAPACITY). Staging
// a game therefore always ends in PartitionFullError, with the numbers a
// message needs; game saves belong on a cartridge (Mednafen locally, the
// MiSTer .sav). The path stays so that verdict is computed, not asserted,
// and so smaller records — DEZA2___SYS, custom payloads — can be placed.
//
// Dependency-free apart from the engine, imported lazily so the editor can
// pull this module in without paying for the engine until a save is staged.

export const SATURN_IDBFS_DB = '/data/saves';
export const SATURN_IDBFS_STORE = 'FILE_DATA';
// Emscripten's IDBFS.DB_VERSION. Opening with the same number never triggers
// an upgrade on a database the emulator made; on a fresh one the upgrade
// below builds the store the way IDBFS would, so the emulator adopts it.
export const SATURN_IDBFS_VERSION = 21;
// The cue inside the dev disc zip is "Dezaemon 2.cue"; the content name
// EmulatorJS derives from it is what names the core's save file.
export const DEZAEMON_CONTENT_NAME = 'Dezaemon 2';
// 0o100666: a regular file, rw for everyone — what Emscripten stamps on the
// files IDBFS itself creates.
const FILE_MODE = 33206;

/** "/data/saves/<name>.srm" — the core's save for that content name. */
export function dezaemonSrmPath(name = DEZAEMON_CONTENT_NAME) {
  return `${SATURN_IDBFS_DB}/${name}.srm`;
}

function toBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  throw new Error('expected bytes (Uint8Array or ArrayBuffer)');
}

function settle(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB request failed'));
  });
}

// One connection per operation, closed afterwards: a connection left open
// would block any future IDBFS upgrade the emulator attempts.
function openFs() {
  if (typeof indexedDB === 'undefined') return Promise.reject(new Error('IndexedDB is not available here'));
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(SATURN_IDBFS_DB, SATURN_IDBFS_VERSION);
    req.onupgradeneeded = (e) => {
      // Exactly IDBFS's own upgrade: a keyless store (keys are the paths)
      // with a non-unique timestamp index.
      const db = req.result;
      const store = db.objectStoreNames.contains(SATURN_IDBFS_STORE)
        ? e.target.transaction.objectStore(SATURN_IDBFS_STORE)
        : db.createObjectStore(SATURN_IDBFS_STORE);
      if (!store.indexNames.contains('timestamp')) store.createIndex('timestamp', 'timestamp', { unique: false });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      const err = req.error;
      reject(err && err.name === 'VersionError'
        ? new Error(`the Saturn save store is a newer IDBFS version than ${SATURN_IDBFS_VERSION}; update saturn-saves.js`)
        : err || new Error('could not open the Saturn save store'));
    };
    req.onblocked = () => reject(new Error('the Saturn save store is open elsewhere — close the Saturn player first'));
  });
}

async function withStore(mode, fn) {
  const db = await openFs();
  try {
    const tx = db.transaction(SATURN_IDBFS_STORE, mode);
    const done = new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
      tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
    });
    const result = await fn(tx.objectStore(SATURN_IDBFS_STORE));
    await done;
    return result;
  } finally {
    db.close();
  }
}

function byteLength(contents) {
  if (contents == null) return 0;
  if (typeof contents.byteLength === 'number') return contents.byteLength;
  return contents.length || 0;
}

/**
 * Every FILE in the core's save directory (directory records carry no
 * contents and are skipped): [{ path, size, timestamp }], sorted by path.
 */
export function listSaturnSaves() {
  return withStore('readonly', (store) => new Promise((resolve, reject) => {
    const out = [];
    const req = store.openCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) {
        resolve(out.sort((a, b) => a.path.localeCompare(b.path)));
        return;
      }
      const v = cursor.value;
      if (v && v.contents != null) {
        out.push({
          path: String(cursor.key),
          size: byteLength(v.contents),
          timestamp: v.timestamp instanceof Date ? v.timestamp : new Date(v.timestamp || 0),
        });
      }
      cursor.continue();
    };
    req.onerror = () => reject(req.error || new Error('could not list the Saturn saves'));
  }));
}

/** The file's bytes (a fresh Uint8Array), or null when there is no such file. */
export async function readSaturnSave(path) {
  const rec = await withStore('readonly', (store) => settle(store.get(path)));
  if (!rec || rec.contents == null) return null;
  return toBytes(rec.contents).slice();
}

/**
 * Write a file the way IDBFS would: { timestamp: now, mode, contents }. A
 * fresh timestamp is what makes the emulator's populate-on-boot take this
 * copy over the one it last held. Returns { path, size, timestamp }.
 */
export function writeSaturnSave(path, bytes) {
  const contents = toBytes(bytes).slice();
  const timestamp = new Date();
  return withStore('readwrite', async (store) => {
    const prev = await settle(store.get(path));
    const mode = prev && typeof prev.mode === 'number' ? prev.mode : FILE_MODE;
    await settle(store.put({ timestamp, mode, contents }, path));
    return { path, size: contents.length, timestamp };
  });
}

/**
 * Put one Dezaemon 2 save into the browser core's internal memory.
 *
 *   sav       a .sav (MiSTer image, logical pair, or gzip) to take the first
 *             DEZA2____NN game out of — its comment, language and date carry
 *             over unless overridden
 *   payload   the payload bytes directly (then `sav` is not needed)
 *   comment   the 10-character directory comment
 *   slot      1-5 to force DEZA2____NN; filename to name the entry outright;
 *             with neither, the engine replaces the slot whose comment
 *             matches, else takes the first free one
 *   path      the .srm to edit; defaults to dezaemonSrmPath()
 *
 * Returns { path, filename, slot, replaced, fits: true, payloadBytes,
 * existed }. When the payload does not fit the engine's PartitionFullError
 * propagates unchanged (name "PartitionFullError"; payloadBytes, freeBytes,
 * capacityBytes tell the story) — for a whole game it always will, see the
 * header. Close a running Saturn player before calling.
 */
export async function stageDezaemonUserSave({ sav, payload, comment, slot, filename, path } = {}) {
  const engine = await import('/engine/shmup-engine.js');
  const target = path || dezaemonSrmPath();
  let source = null;
  if (!(payload instanceof Uint8Array)) {
    if (sav == null) throw new Error('stageDezaemonUserSave needs a payload, or a .sav to take one from');
    let bytes = toBytes(sav);
    if (engine.isGzip(bytes)) bytes = (await engine.normalize(bytes)).data;
    ({ payload, entry: source } = engine.gamePayloadFromSav(bytes));
  }
  const existing = await readSaturnSave(target);
  const staged = engine.stageSaveInInternalRam(existing, {
    payload,
    filename,
    slot,
    comment: comment ?? (source ? source.comment : undefined),
    language: source ? source.language : undefined,
    date: source ? source.date : undefined,
  });
  await writeSaturnSave(target, staged.interleaved);
  const m = /^DEZA2____(\d\d)$/.exec(staged.filename);
  return {
    path: target,
    filename: staged.filename,
    slot: m ? Number(m[1]) : null,
    replaced: staged.replaced,
    fits: true,
    payloadBytes: payload.length,
    existed: existing !== null,
  };
}
