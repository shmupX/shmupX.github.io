// The PlayStation memory card, as the container both PlayStation Dezaemons
// save into.
//
// A card is 128 KB: 16 blocks of 8 KB, each block 64 frames of 128 bytes.
// Block 0 is the directory — frame 0 carries the "MC" magic, frames 1..15
// describe blocks 1..15 (status, byte size, next-block link, the 20-byte
// product-code file name), frames 16..35 the broken-sector list, and every
// directory frame ends in an XOR checksum of its first 127 bytes. A save that
// spans several blocks chains them through the link field (a 0-based block
// index, 0xFFFF for none); the file's bytes are the chained blocks in order.
// Both Dezaemon+ (`BISLPS-00335DEZA`) and Dezaemon Kids! (`BISLPS-01503DEZAKIDS`)
// take the whole card: one 15-block, 122,880-byte file.
//
// Dumps arrive in a few wrappings, all reduced here to save blocks:
//   - raw card images (.mcr/.mcd/.mc/.srm/.sav, 131,072 bytes),
//   - DexDrive .gme (a 3,904-byte header, then the raw card),
//   - single-save .mcs (one directory frame, then the blocks),
//   - PS3 .psv exports (a 0x84-byte header, then the blocks),
//   - a bare block run that opens with the "SC" save header.
//
// Environment-neutral ESM (Node + browser).

export const CARD_SIZE = 0x20000;
export const FRAME_SIZE = 0x80;
export const BLOCK_SIZE = 0x2000;
export const BLOCK_COUNT = 15;
export const DIRECTORY_OFFSET = FRAME_SIZE;
export const FILENAME_OFFSET = 10;
export const FILENAME_LENGTH = 20;
export const NO_NEXT = 0xffff;
export const CARD_MAGIC = "MC";
export const GME_HEADER_SIZE = 0xf40;
export const GME_MAGIC = "123-456-STD";
export const PSV_HEADER_SIZE = 0x84;
export const MCS_HEADER_SIZE = FRAME_SIZE;

/** Directory-frame status bytes. */
export const STATUS = Object.freeze({
    FIRST: 0x51,
    MIDDLE: 0x52,
    LAST: 0x53,
    FREE: 0xa0,
    DELETED_FIRST: 0xa1,
    DELETED_MIDDLE: 0xa2,
    DELETED_LAST: 0xa3,
    UNUSABLE: 0xff,
});

export function latin1(bytes, offset, length) {
    let s = "";
    for (let i = 0; i < length && offset + i < bytes.length; i++) s += String.fromCharCode(bytes[offset + i]);
    return s;
}

/** The C string in a fixed field: bytes up to the first NUL. */
export function cString(bytes, offset, length) {
    let end = offset;
    while (end < offset + length && end < bytes.length && bytes[end] !== 0) end++;
    return latin1(bytes, offset, end - offset);
}

export function u16le(bytes, at) {
    return bytes[at] | (bytes[at + 1] << 8);
}

export function u32le(bytes, at) {
    return (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0;
}

/** XOR of a directory frame's first 127 bytes — what its last byte must be. */
export function frameChecksum(frame) {
    let x = 0;
    for (let i = 0; i < FRAME_SIZE - 1 && i < frame.length; i++) x ^= frame[i];
    return x;
}

export function isCardImage(bytes) {
    return bytes.length === CARD_SIZE && latin1(bytes, 0, 2) === CARD_MAGIC;
}

export function isGmeImage(bytes) {
    return bytes.length === GME_HEADER_SIZE + CARD_SIZE && latin1(bytes, 0, GME_MAGIC.length) === GME_MAGIC;
}

export function isPsvImage(bytes) {
    return bytes.length > PSV_HEADER_SIZE && bytes[0] === 0 && latin1(bytes, 1, 3) === "VSP";
}

export function isMcsImage(bytes) {
    return bytes.length > MCS_HEADER_SIZE && (bytes.length - MCS_HEADER_SIZE) % BLOCK_SIZE === 0 &&
        (bytes[0] & 0xf0) === 0x50 && latin1(bytes, MCS_HEADER_SIZE, 2) === "SC";
}

export function isBareSave(bytes) {
    return bytes.length >= BLOCK_SIZE && bytes.length % BLOCK_SIZE === 0 && latin1(bytes, 0, 2) === "SC";
}

/**
 * One directory frame (block `index + 1`).
 * @param {Uint8Array} card  a raw card image
 * @param {number} index     0..14
 */
export function parseDirectoryFrame(card, index) {
    const at = DIRECTORY_OFFSET + index * FRAME_SIZE;
    const frame = card.subarray(at, at + FRAME_SIZE);
    const status = frame[0];
    return {
        block: index + 1,
        offset: at,
        status,
        size: u32le(frame, 4),
        next: u16le(frame, 8),
        filename: cString(frame, FILENAME_OFFSET, FILENAME_LENGTH),
        checksum: frame[FRAME_SIZE - 1],
        checksumOk: frameChecksum(frame) === frame[FRAME_SIZE - 1],
        live: status === STATUS.FIRST || status === STATUS.MIDDLE || status === STATUS.LAST,
        deleted: status === STATUS.DELETED_FIRST || status === STATUS.DELETED_MIDDLE || status === STATUS.DELETED_LAST,
        free: status === STATUS.FREE,
        first: status === STATUS.FIRST || status === STATUS.DELETED_FIRST,
        last: status === STATUS.LAST || status === STATUS.DELETED_LAST,
    };
}

/** Bytes of block `block` (1..15) of a raw card image. */
export function blockBytes(card, block) {
    return card.subarray(block * BLOCK_SIZE, (block + 1) * BLOCK_SIZE);
}

/**
 * Follow a file's block chain from its first directory frame. Stops at a
 * frame flagged last, a missing link, a link out of range, or a loop.
 */
export function chainFrom(frames, firstIndex) {
    const chain = [];
    const seen = new Set();
    let index = firstIndex;
    while (index >= 0 && index < frames.length && !seen.has(index)) {
        seen.add(index);
        chain.push(index + 1);
        const frame = frames[index];
        if (frame.last || frame.next === NO_NEXT) break;
        index = frame.next;
    }
    return chain;
}

/**
 * Parse a raw 128 KB card image: the directory and every file on it, each
 * file's bytes gathered from its chained blocks.
 * @param {Uint8Array} card
 */
export function parseMemoryCard(card) {
    const magic = latin1(card, 0, 2);
    const frames = [];
    for (let i = 0; i < BLOCK_COUNT; i++) frames.push(parseDirectoryFrame(card, i));
    const files = [];
    for (let i = 0; i < frames.length; i++) {
        const frame = frames[i];
        if (!frame.first) continue;
        const blocks = chainFrom(frames, i);
        const parts = blocks.map((b) => blockBytes(card, b));
        const joined = new Uint8Array(parts.length * BLOCK_SIZE);
        parts.forEach((p, k) => joined.set(p, k * BLOCK_SIZE));
        const size = Math.min(frame.size, joined.length);
        files.push({
            filename: frame.filename,
            firstBlock: frame.block,
            blocks,
            size: frame.size,
            complete: frame.size <= joined.length && blocks.length > 0 && frames[blocks[blocks.length - 1] - 1].last,
            deleted: frame.deleted,
            data: joined.subarray(0, size),
        });
    }
    return {
        magic,
        magicOk: magic === CARD_MAGIC,
        headerChecksumOk: frameChecksum(card.subarray(0, FRAME_SIZE)) === card[FRAME_SIZE - 1],
        frames,
        files,
        freeBlocks: frames.filter((f) => f.free).length,
    };
}

/**
 * Whatever a file holds, reduced to save blocks: [{filename, data, container}].
 * `container` names the wrapping that was peeled: "card", "gme", "mcs",
 * "psv" or "bare". Unknown input yields an empty list.
 * @param {Uint8Array} bytes
 * @returns {{container: string, card: ReturnType<typeof parseMemoryCard> | null, saves: {filename: string, data: Uint8Array, deleted: boolean}[]}}
 */
export function locateSaves(bytes) {
    if (isCardImage(bytes) || isGmeImage(bytes)) {
        const container = isGmeImage(bytes) ? "gme" : "card";
        const card = parseMemoryCard(container === "gme" ? bytes.subarray(GME_HEADER_SIZE) : bytes);
        return {
            container,
            card,
            saves: card.files.map((f) => ({ filename: f.filename, data: f.data, deleted: f.deleted })),
        };
    }
    if (isMcsImage(bytes)) {
        const size = u32le(bytes, 4) || bytes.length - MCS_HEADER_SIZE;
        return {
            container: "mcs",
            card: null,
            saves: [{
                filename: cString(bytes, FILENAME_OFFSET, FILENAME_LENGTH),
                data: bytes.subarray(MCS_HEADER_SIZE, MCS_HEADER_SIZE + size),
                deleted: false,
            }],
        };
    }
    if (isPsvImage(bytes)) {
        return {
            container: "psv",
            card: null,
            saves: [{ filename: cString(bytes, 0x64, FILENAME_LENGTH), data: bytes.subarray(PSV_HEADER_SIZE), deleted: false }],
        };
    }
    if (isBareSave(bytes)) {
        return { container: "bare", card: null, saves: [{ filename: "", data: bytes, deleted: false }] };
    }
    return { container: "unknown", card: null, saves: [] };
}
