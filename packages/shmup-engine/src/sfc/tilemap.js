// Little-endian word helpers for the GROUP tables.
//
// The words themselves are chip words (chips.js) — not SNES tilemap words,
// which is what this file once took them for: a group word names a source
// chip to copy, and the slot it sits in decides the VRAM tile. The readers
// and writers of raw u16 lists stay here. Environment-neutral ESM (Node + browser).

/** `count` little-endian u16 at `offset`. */
export function readWords(bytes, offset, count) {
    if (offset + count * 2 > bytes.length) {
        throw new Error(`${count} words at 0x${offset.toString(16)} run past the end (${bytes.length})`);
    }
    const words = new Uint16Array(count);
    for (let i = 0; i < count; i++) words[i] = bytes[offset + i * 2] | (bytes[offset + i * 2 + 1] << 8);
    return words;
}

/** `words` written little-endian at `offset`. */
export function writeWords(bytes, offset, words) {
    if (offset + words.length * 2 > bytes.length) {
        throw new Error(`${words.length} words at 0x${offset.toString(16)} run past the end (${bytes.length})`);
    }
    for (let i = 0; i < words.length; i++) {
        bytes[offset + i * 2] = words[i] & 0xff;
        bytes[offset + i * 2 + 1] = (words[i] >> 8) & 0xff;
    }
    return bytes;
}
