// The PlayStation save header: the "SC" title frame and its icon frames.
//
// Every save file opens with a 128-byte title frame — "SC", an icon flag
// (0x11/0x12/0x13 = one to three 16x16 icon frames), the block count, a
// 64-byte Shift-JIS title, then at 0x60 the icon's 16-colour CLUT — followed
// by the icon frames (16x16 at 4bpp, 128 bytes each, low nibble first). Both
// Dezaemons declare one icon frame, so their own data begins at 0x100.
//
// Dezaemon Kids! puts the user's game name inside the title, between 『 』:
//   デザエモンＫｉｄｓ！ユーザーゲームデータ『Ａｉｒ　Ｓｔｏｒｙ　　』
// Dezaemon+ keeps a fixed title (デザエモン＋（プラス）　ユーザーゲームデータ);
// its game name lives in the graphics as a drawn logo, nowhere in text.
//
// Environment-neutral ESM (Node + browser). Shift-JIS decoding goes through
// TextDecoder("shift_jis") where the runtime has it (Deno, browsers, Node
// with full ICU) and falls back to Latin-1 otherwise.

import { latin1, u16le } from "./memcard.js";

export const SAVE_MAGIC = "SC";
export const TITLE_FRAME_SIZE = 0x80;
export const ICON_FRAME_SIZE = 0x80;
export const TITLE_OFFSET = 0x04;
export const TITLE_LENGTH = 0x40;
export const CLUT_OFFSET = 0x60;
export const ICON_DIM = 16;

let sjis = null;
function shiftJisDecoder() {
    if (sjis === null) {
        try {
            sjis = new TextDecoder("shift_jis");
        } catch {
            sjis = false;
        }
    }
    return sjis || null;
}

/** Shift-JIS bytes -> string; Latin-1 when the runtime lacks the codec. */
export function decodeShiftJis(bytes) {
    const decoder = shiftJisDecoder();
    return decoder ? decoder.decode(bytes) : latin1(bytes, 0, bytes.length);
}

/** Fullwidth ASCII and ideographic spaces -> their ASCII counterparts. */
export function narrow(text) {
    return text.replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/　/g, " ");
}

/** The text between 『 』 in a title, or null. Fullwidth spaces are trimmed. */
export function bracketedName(title) {
    const m = /『(.*?)』/.exec(title);
    if (!m) return null;
    return m[1].replace(/^[\s　]+|[\s　]+$/g, "");
}

/** A 16-entry PlayStation CLUT: RGB555 words, bit 15 = STP. */
export function decodeClut(bytes, offset) {
    const colors = [];
    for (let i = 0; i < 16; i++) colors.push(u16le(bytes, offset + i * 2));
    return colors;
}

/** One 16x16 4bpp icon frame -> 256 indices (low nibble is the left pixel). */
export function decodeIconFrame(bytes, offset) {
    const out = new Uint8Array(ICON_DIM * ICON_DIM);
    for (let i = 0; i < out.length; i += 2) {
        const b = bytes[offset + (i >> 1)];
        out[i] = b & 0x0f;
        out[i + 1] = b >> 4;
    }
    return out;
}

/**
 * @param {Uint8Array} data  a save's bytes, from its "SC" frame
 */
export function parseSaveHeader(data) {
    const magic = latin1(data, 0, 2);
    const iconFlag = data[2];
    const iconFrames = (iconFlag & 0xf0) === 0x10 ? Math.min(3, Math.max(1, iconFlag & 0x0f)) : 0;
    let titleEnd = TITLE_OFFSET;
    while (titleEnd < TITLE_OFFSET + TITLE_LENGTH && data[titleEnd] !== 0) titleEnd++;
    const titleBytes = data.subarray(TITLE_OFFSET, titleEnd);
    const title = decodeShiftJis(titleBytes);
    const icons = [];
    for (let i = 0; i < iconFrames; i++) icons.push(decodeIconFrame(data, TITLE_FRAME_SIZE + i * ICON_FRAME_SIZE));
    return {
        magic,
        magicOk: magic === SAVE_MAGIC,
        iconFlag,
        iconFrames,
        blockCount: data[3],
        title,
        titleAscii: narrow(title),
        titleBytes,
        clut: decodeClut(data, CLUT_OFFSET),
        icons,
        /** Where the game's own data starts: after the title and icon frames. */
        bodyOffset: TITLE_FRAME_SIZE + iconFrames * ICON_FRAME_SIZE,
    };
}
