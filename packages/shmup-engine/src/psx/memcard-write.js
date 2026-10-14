// Building a PlayStation memory card from scratch — the writer half of
// memcard.js, which only reads.
//
// placeKidsSave / placePlusSave (kids-edit.js, plus-edit.js) write an edited
// block back into a card that already exists. This module is for the case
// where there is no card yet: a level exported from the editor has to arrive
// as a 128 KB image an emulator can mount, so the directory block has to be
// made as well as the save.
//
// The layout is the console's own (nocash's PSX-SPX, "Memory Card Data
// Format"), and every number here is one memcard.js already reads back:
//
//   block 0, frame 0      "MC", zeros, XOR checksum (0x0E)
//   block 0, frames 1-15  one directory frame per data block: status, u32
//                         byte size, u16 link to the next block (0-based,
//                         0xFFFF for none), the 20-byte file name, checksum
//   block 0, frames 16-35 the broken-sector list: u32 0xFFFFFFFF (none) and
//                         a checksum each
//   block 0, frames 36-55 broken-sector replacement data, 0xFF-filled
//   block 0, frames 56-62 unused, 0xFF-filled
//   block 0, frame 63     the write-test frame, a copy of frame 0
//   blocks 1-15           8 KB each; a file takes a chain of them
//
// A file's size is written only in its FIRST directory frame; the middle and
// last frames of its chain carry a zero size, the status that names their
// position (0x52 / 0x53) and the link. A free block's frame is 0xA0 with
// 0xFFFF for a link and a zero name, which is what a console formats.
//
// Environment-neutral ESM (Node + browser); no I/O.

import {
    BLOCK_COUNT,
    BLOCK_SIZE,
    CARD_SIZE,
    DIRECTORY_OFFSET,
    FILENAME_LENGTH,
    FILENAME_OFFSET,
    FRAME_SIZE,
    frameChecksum,
    NO_NEXT,
    parseMemoryCard,
    STATUS,
} from "./memcard.js";

/** Frames 16..35 of block 0: the broken-sector list, twenty entries. */
export const BROKEN_LIST_FIRST_FRAME = 16;
export const BROKEN_LIST_FRAMES = 20;
/** Frames 36..55: the replacement data for those twenty sectors. */
export const BROKEN_DATA_FIRST_FRAME = 36;
export const BROKEN_DATA_FRAMES = 20;
/** Frame 63: the write-test frame, a copy of frame 0. */
export const WRITE_TEST_FRAME = 63;
/** What a broken-sector entry holds when it names no sector. */
export const NO_BROKEN_SECTOR = 0xffffffff;

function putU16le(bytes, at, v) {
    bytes[at] = v & 0xff;
    bytes[at + 1] = (v >> 8) & 0xff;
}

function putU32le(bytes, at, v) {
    putU16le(bytes, at, v & 0xffff);
    putU16le(bytes, at + 2, (v >>> 16) & 0xffff);
}

function seal(frame) {
    frame[FRAME_SIZE - 1] = frameChecksum(frame);
}

/**
 * A formatted, empty 128 KB card: the header frame, fifteen free directory
 * frames, an empty broken-sector list, and the write-test frame. Every data
 * block is zero.
 * @returns {Uint8Array}
 */
export function formatMemoryCard() {
    const card = new Uint8Array(CARD_SIZE);
    const header = card.subarray(0, FRAME_SIZE);
    header[0] = 0x4d; // M
    header[1] = 0x43; // C
    seal(header);
    for (let i = 0; i < BLOCK_COUNT; i++) {
        const frame = card.subarray(DIRECTORY_OFFSET + i * FRAME_SIZE, DIRECTORY_OFFSET + (i + 1) * FRAME_SIZE);
        frame[0] = STATUS.FREE;
        putU16le(frame, 8, NO_NEXT);
        seal(frame);
    }
    for (let i = 0; i < BROKEN_LIST_FRAMES; i++) {
        const at = (BROKEN_LIST_FIRST_FRAME + i) * FRAME_SIZE;
        const frame = card.subarray(at, at + FRAME_SIZE);
        putU32le(frame, 0, NO_BROKEN_SECTOR);
        seal(frame);
    }
    card.fill(0xff, BROKEN_DATA_FIRST_FRAME * FRAME_SIZE, WRITE_TEST_FRAME * FRAME_SIZE);
    card.set(header, WRITE_TEST_FRAME * FRAME_SIZE);
    return card;
}

/**
 * The 20-byte directory name a save file carries: the product code, as
 * memcard.js reads it back with cString(). ASCII only, because the console
 * matches these bytes against the title id it is running.
 */
export function encodeCardFilename(filename) {
    if (typeof filename !== "string" || !filename.length) throw new Error("a card file needs a name");
    if (filename.length > FILENAME_LENGTH) {
        throw new Error(`a card file name is at most ${FILENAME_LENGTH} bytes; "${filename}" is ${filename.length}`);
    }
    const out = new Uint8Array(FILENAME_LENGTH);
    for (let i = 0; i < filename.length; i++) {
        const c = filename.charCodeAt(i);
        if (c < 0x20 || c > 0x7e) throw new Error(`"${filename[i]}" is not printable ASCII; a card file name is`);
        out[i] = c;
    }
    return out;
}

/**
 * A card holding the given files, each laid into the next free blocks.
 *
 * `files` is [{filename, data}]: the 20-byte product-code name and the save's
 * bytes from its "SC" frame. A file is padded to whole 8 KB blocks, and the
 * directory records its exact byte length — a Dezaemon save is 0x1E000, the
 * whole card, which is why both games list one file per card.
 *
 * Read back through parseMemoryCard() before it is returned, so a card this
 * makes is one memcard.js agrees with: every frame checksums, every file is
 * complete and comes back byte for byte.
 *
 * @param {{filename: string, data: Uint8Array}[]} files
 * @returns {Uint8Array} the 131,072-byte image
 */
export function buildMemoryCard(files) {
    const card = formatMemoryCard();
    let next = 1;
    for (const file of files) {
        if (!(file.data instanceof Uint8Array) || !file.data.length) {
            throw new Error(`${file.filename || "(unnamed)"}: a card file is a non-empty Uint8Array`);
        }
        const blocks = Math.ceil(file.data.length / BLOCK_SIZE);
        if (next + blocks - 1 > BLOCK_COUNT) {
            throw new Error(
                `${file.filename} needs ${blocks} block${blocks === 1 ? "" : "s"} and the card has ` +
                    `${BLOCK_COUNT - next + 1} free of ${BLOCK_COUNT}`,
            );
        }
        const name = encodeCardFilename(file.filename);
        for (let k = 0; k < blocks; k++) {
            const block = next + k;
            const frame = card.subarray(DIRECTORY_OFFSET + (block - 1) * FRAME_SIZE, DIRECTORY_OFFSET + block * FRAME_SIZE);
            frame.fill(0);
            const last = k === blocks - 1;
            frame[0] = k === 0 ? STATUS.FIRST : last ? STATUS.LAST : STATUS.MIDDLE;
            if (k === 0) {
                putU32le(frame, 4, file.data.length);
                frame.set(name, FILENAME_OFFSET);
            }
            // The link is a 0-based block index, so block b+1 is written as b.
            putU16le(frame, 8, last ? NO_NEXT : block);
            seal(frame);
            card.set(file.data.subarray(k * BLOCK_SIZE, (k + 1) * BLOCK_SIZE), block * BLOCK_SIZE);
        }
        next += blocks;
    }
    const back = parseMemoryCard(card);
    if (!back.magicOk || !back.headerChecksumOk || !back.frames.every((f) => f.checksumOk)) {
        throw new Error("the card this built does not read back: a directory frame failed its checksum");
    }
    for (const file of files) {
        const found = back.files.find((f) => f.filename === file.filename);
        if (!found || !found.complete || found.size !== file.data.length) {
            throw new Error(`${file.filename} did not come back off the card it was just written to`);
        }
        for (let i = 0; i < file.data.length; i++) {
            if (found.data[i] !== file.data[i]) {
                throw new Error(`${file.filename} read back with a different byte at 0x${i.toString(16)}`);
            }
        }
    }
    return card;
}
