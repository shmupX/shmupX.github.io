// The level record's `dezaemonBgm`, and the whole 24-slot song bank behind it.
//
// A cart's music is sec6 (24 song slots of 4,228 bytes) plus the 24-entry
// BGM table in the settings block (sec5 +0x41..+0x58: title, game over,
// stage clear, ending, then a main/boss pair per stage) and the SFX set
// (+0x59). The record carries all of it, so a cart goes import -> cloud ->
// export without losing a byte:
//
//   sfxSet    1 REAL / 2 COMIC / 3 SF
//   special   [title, gameover, clear, ending] slots       (table[0..3])
//   stages    [[main, boss], …] for the level's stages     (table[4..])
//   songs     { slot: base64 } — the slots the game PLAYS: named by the table
//             (or by `sequence`) and holding notes or an accompaniment. The
//             runtime reads only this, as it always has.
//   bank      { slot: base64 } — every other slot that is not the editor's
//             blank, carried for the cart and the music maker. Disjoint from
//             `songs`.
//   table     the raw 24 table bytes, so entries past the level's stage count
//             survive
//   tempos    { slot: stepSeconds } for `songs`, informational
//   sequence  web-only: slots played end to end as one piece (bgm:tone)
//   names     web-only: { slot: label } the music maker shows on a tape
//   edited    web-only: when the music maker last wrote the record (ms)
//
// Older records (songs/special/stages only) read and write exactly as before:
// a missing `table` is zeros under `special`/`stages`, a missing `bank` is
// blank slots.
//
// Environment-neutral ESM (Node + browser).

import { MEASURE_SIZE, MEASURES, SONG_SIZE, SONG_SLOTS } from "../decode/decode-song.js";
import { songStreams } from "./song-streams.js";
import { stepSecondsOf } from "./song-write.js";

export const BGM_TABLE_SIZE = 24;
export const SPECIAL_ROLES = Object.freeze(["title", "gameover", "clear", "ending"]);
export const MAX_STAGE_PAIRS = 10;

/** An unused 音まろ song slot: the header and per-measure control bytes every save carries. */
export function emptySong() {
    const song = new Uint8Array(SONG_SIZE);
    song.set([0x00, 0x1f, 0x03, 0x0f], 0);
    for (let m = 0; m < MEASURES; m++) song.set([0x00, 0x00, 0x80, 0x03], 4 + m * MEASURE_SIZE);
    return song;
}

/** sec6 with every slot empty. */
export function emptySongBank() {
    const sec6 = new Uint8Array(SONG_SIZE * SONG_SLOTS);
    const song = emptySong();
    for (let s = 0; s < SONG_SLOTS; s++) sec6.set(song, s * SONG_SIZE);
    return sec6;
}

const EMPTY = emptySong();

/** True when a slot is byte for byte the editor's blank. */
export function isEmptySong(bytes) {
    if (!bytes || bytes.length !== SONG_SIZE) return false;
    for (let i = 0; i < SONG_SIZE; i++) if (bytes[i] !== EMPTY[i]) return false;
    return true;
}

export function bytesToB64(bytes) {
    if (typeof btoa === "function") {
        let s = "";
        for (let i = 0; i < bytes.length; i += 0x8000) {
            s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        }
        return btoa(s);
    }
    // deno-lint-ignore no-undef
    return Buffer.from(bytes).toString("base64");
}

export function b64ToBytes(b64) {
    if (typeof atob === "function") return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    // deno-lint-ignore no-undef
    return new Uint8Array(Buffer.from(b64, "base64"));
}

/**
 * Whether a slot named by the table ships in `songs`: it has any pitch byte
 * in its composed parts (the importer's rule since the first import, via
 * decodeSong's noteCount) or its accompaniment sounds before the loop end.
 */
export function shipsAsSong(bytes) {
    for (let m = 0; m < MEASURES; m++) {
        const base = 4 + m * MEASURE_SIZE + 4;
        for (let p = 0; p < 4; p++) {
            const at = base + p * 32 + 16;
            for (let st = 0; st < 16; st++) if (bytes[at + st] !== 0) return true;
        }
    }
    const s = songStreams(bytes);
    return s.accomp.some((ch) => ch.some((e) => e.step < s.loopEndStep));
}

function slotIndex(key) {
    const n = Number(key);
    return Number.isInteger(n) && n >= 0 && n < SONG_SLOTS ? n : -1;
}

/** `{slot: b64}` as an object, or as the array RTDB turns it into (holes are null). */
function slotEntries(map) {
    if (!map || typeof map !== "object") return [];
    const pairs = Array.isArray(map) ? map.map((v, i) => [i, v]) : Object.entries(map);
    return pairs.filter(([k, v]) => slotIndex(k) >= 0 && typeof v === "string" && v.length);
}

/** The 24 table bytes a record stands for. `table` first, then `special` and `stages` where they say otherwise. */
export function bgmTableOf(record) {
    const out = new Array(BGM_TABLE_SIZE).fill(0);
    if (!record || typeof record !== "object") return out;
    const raw = Array.isArray(record.table) ? record.table : null;
    if (raw && raw.length === BGM_TABLE_SIZE) {
        for (let i = 0; i < BGM_TABLE_SIZE; i++) out[i] = Number(raw[i]) & 0xff;
    }
    const put = (i, v) => {
        if (!Number.isInteger(v) || v === out[i]) return;
        out[i] = Math.max(0, Math.min(SONG_SLOTS - 1, v));
    };
    (Array.isArray(record.special) ? record.special : []).slice(0, 4).forEach((v, i) => put(i, v));
    (Array.isArray(record.stages) ? record.stages : []).slice(0, MAX_STAGE_PAIRS).forEach((pair, s) => {
        if (!Array.isArray(pair)) return;
        put(4 + s * 2, pair[0]);
        put(5 + s * 2, pair[1]);
    });
    return out;
}

/** sec6 out of a record: the blank bank, then `bank`, then `songs`. */
export function sec6FromBgm(record, warn = () => {}) {
    const sec6 = emptySongBank();
    if (!record || typeof record !== "object") return sec6;
    for (const field of ["bank", "songs"]) {
        for (const [key, b64] of slotEntries(record[field])) {
            const slot = slotIndex(key);
            try {
                const bytes = b64ToBytes(b64);
                if (bytes.length === SONG_SIZE) sec6.set(bytes, slot * SONG_SIZE);
                else warn(`song slot ${slot} is ${bytes.length} bytes, not ${SONG_SIZE} — skipped`);
            } catch (e) {
                warn(`song slot ${slot} could not be read (${e.message})`);
            }
        }
    }
    return sec6;
}

/**
 * The music maker's working set out of a record of any vintage:
 * `{slots: Uint8Array[24], table: number[24], sfxSet, stageCount, sequence?, names?}`.
 */
export function bankFromBgm(record) {
    const sec6 = sec6FromBgm(record);
    const slots = [];
    for (let i = 0; i < SONG_SLOTS; i++) slots.push(sec6.slice(i * SONG_SIZE, (i + 1) * SONG_SIZE));
    const r = record && typeof record === "object" ? record : {};
    const out = {
        slots,
        table: bgmTableOf(r),
        sfxSet: Number.isInteger(r.sfxSet) ? r.sfxSet : 1,
        stageCount: Array.isArray(r.stages) ? Math.min(r.stages.length, MAX_STAGE_PAIRS) : 0,
    };
    if (Array.isArray(r.sequence)) out.sequence = r.sequence.slice();
    if (r.names && typeof r.names === "object") {
        out.names = {};
        for (const [k, v] of Object.entries(r.names)) {
            if (slotIndex(k) >= 0 && typeof v === "string" && v) out.names[slotIndex(k)] = v;
        }
    }
    return out;
}

function recordOf(slots, table, sfxSet, stageCount, sequence) {
    const special = table.slice(0, 4);
    const stages = [];
    for (let s = 0; s < Math.min(stageCount, MAX_STAGE_PAIRS); s++) {
        stages.push([table[4 + s * 2], table[5 + s * 2]]);
    }
    const referenced = new Set([...special, ...stages.flat(), ...(sequence || [])]);
    const songs = {};
    const bank = {};
    const tempos = {};
    slots.forEach((bytes, slot) => {
        if (referenced.has(slot) && shipsAsSong(bytes)) {
            songs[slot] = bytesToB64(bytes);
            tempos[slot] = stepSecondsOf(bytes[3]);
        } else if (!isEmptySong(bytes)) {
            bank[slot] = bytesToB64(bytes);
        }
    });
    return { sfxSet, special, stages, songs, tempos, bank, table: table.slice() };
}

/**
 * The record for a cart's music, straight off the save: the settings
 * block's BGM table and SFX set, and the decompressed sec6.
 */
export function bgmFromSave({ bgmTable, sfxSet }, sec6, stageCount) {
    if (!Array.isArray(bgmTable) || bgmTable.length !== BGM_TABLE_SIZE) {
        throw new RangeError(`bgm-record: a BGM table is ${BGM_TABLE_SIZE} bytes`);
    }
    if (!sec6 || sec6.length !== SONG_SIZE * SONG_SLOTS) {
        throw new RangeError(`bgm-record: sec6 is ${SONG_SIZE * SONG_SLOTS} bytes`);
    }
    const slots = [];
    for (let i = 0; i < SONG_SLOTS; i++) slots.push(sec6.subarray(i * SONG_SIZE, (i + 1) * SONG_SIZE));
    return recordOf(slots, bgmTable.slice(), sfxSet, stageCount);
}

/**
 * The record for the music maker's working set (the inverse of bankFromBgm).
 * `previous` is the record it was opened from: its `sequence` and any field
 * this module does not own ride along.
 */
export function bgmFromBank(bank, { stageCount, previous, edited } = {}) {
    if (!bank || !Array.isArray(bank.slots) || bank.slots.length !== SONG_SLOTS) {
        throw new RangeError(`bgm-record: a bank is ${SONG_SLOTS} slots`);
    }
    const table = Array.isArray(bank.table) && bank.table.length === BGM_TABLE_SIZE
        ? bank.table.map((v) => Number(v) & 0xff)
        : new Array(BGM_TABLE_SIZE).fill(0);
    const prev = previous && typeof previous === "object" ? previous : {};
    const sequence = Array.isArray(bank.sequence) ? bank.sequence : Array.isArray(prev.sequence) ? prev.sequence : null;
    const count = Number.isInteger(stageCount) ? stageCount : (bank.stageCount ?? (Array.isArray(prev.stages) ? prev.stages.length : 0));
    const out = {
        ...prev,
        ...recordOf(bank.slots, table, Number.isInteger(bank.sfxSet) ? bank.sfxSet : 1, count, sequence),
    };
    if (sequence) out.sequence = sequence.filter((slot) => String(slot) in out.songs);
    else delete out.sequence;
    if (bank.names && Object.keys(bank.names).length) out.names = { ...bank.names };
    else delete out.names;
    if (edited !== undefined) out.edited = edited;
    return out;
}
