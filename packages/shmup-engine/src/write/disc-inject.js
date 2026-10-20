// Put a game on the Dezaemon 2 disc itself, so a Saturn with no backup
// cartridge plays it.
//
// A Dezaemon 2 game is normally a cart save (bup-write.js): 89 KB at the very
// least, so it never fits the console's 32 KB internal backup memory, and the
// browser's Saturn (EmulatorJS around yabause) has no cartridge at all. But the
// disc carries games of its own — six complete ones, SGM_*.CMP (FORMAT.md
// "Disc image") — and one of them is not a sample: SGM_INIT.CMP is the
// editor's boot image, the game every power-on starts out holding (the stock
// one is byte-identical to the Gust sample). Replace it, and the console boots
// holding the injected game; the title's PLAY → U plays it.
//
// What the code does with that file, traced in the SH-2 (0KERNEL.BIN, the
// D2MENU and GAME overlays; FORMAT.md "SGM_INIT.CMP, the boot image"):
//
//   - only D2MENU's cold-boot entry reads it, once per power-on: kernel list
//     loader 0x06006F9C stages the whole file at LWRAM 0x002C8A84, then the
//     .CMP wrapper 0x060050F8 unpacks it straight onto the live sections at
//     0x00200000, in memory order sec0-3, 5, 4, 6, 7 — no 0x6C table, no
//     checksum, no size check, nothing done to it afterwards
//   - the file is found by name, through SEGA's GFS directory table built from
//     the ISO 9660 records at boot, and read for exactly the directory's data
//     length; no position or size of any file is hard-coded anywhere, so the
//     new file may be any length and, if it outgrows its 82 sectors, may move
//   - it is staged whole below the end of LWRAM, so a .CMP may be at most
//     0x00300000 - 0x002C8A84 = 226,684 bytes (gs comes to ~98 KB)
//   - PLAY → U unpacks no game: the play engine runs whatever is at
//     0x00200000. S1-S3 (and the hidden pair) unpack their own SGM over it,
//     and nothing ever brings the boot image back until the next power-on
//
// That last point is why the menu is patched too, by default. A cold boot
// clears the byte at 0x06056980, which the menu reads as "the editor holds no
// work of the player's" — and while it is clear, 900 idle frames on the title
// (15 s) start the attract demo, which is a sample game unpacked over
// 0x00200000, and S1-S3 overwrite the editor's game without asking. Loading a
// cart sets it; a disc that boots holding a game should too. D2MENU's cold
// path (0x06066818) stores one zero into three bytes — that flag, the demo
// rotation index and a music-restart flag; the patch rewrites those seven
// instructions to store 1 into the first and 0 into the other two. r3 ends
// where the stock code leaves it; r1 and r2 do not, but the next two
// instructions load both before anything reads them, and nothing branches
// into the seven. With it, the title waits forever and S1-S3 ask before they
// overwrite the game, exactly as after a cart LOAD.
//
// Both rewritten files go through compress.js and must decode on the Saturn
// itself. Its LZSS core (kernel 0x06004FF8) clears only ring bytes
// 0x000-0xFED before each file and leaves 0xFEE-0xFFF holding the previous
// file's last bytes, so a stream that copies from those 18 bytes before
// writing them would come out differently on the console than in
// decompress.js. staleRingReads() counts such copies; the injection refuses a
// stream that makes any.
//
// Environment-neutral ESM (Deno + browser). Takes and returns Uint8Array.

import { compressCmp } from "../compress.js";
import { decompressCmp, SECTION_SIZES } from "../decompress.js";
import { findEntry, openDisc, readFile } from "../cd/iso9660-read.js";
import { replaceFile } from "../cd/iso9660-patch.js";

/** The editor's boot image: the game a power-on starts out holding. */
export const BOOT_IMAGE_FILE = "SGM_INIT.CMP";
/** The main menu overlay, which reads the boot image and runs the title. */
export const MENU_FILE = "D2MENU.CMP";
/** The order the eight sections sit in memory, and so in an SGM image. */
export const SGM_MEMORY_ORDER = Object.freeze([0, 1, 2, 3, 5, 4, 6, 7]);
/** An SGM image: the eight sections raw, back to back. */
export const SGM_IMAGE_SIZE = SECTION_SIZES.reduce((a, b) => a + b, 0); // 766,596
/** The largest .CMP the boot load can stage: LWRAM end minus 0x002C8A84. */
export const SGM_STAGE_LIMIT = 0x00300000 - 0x002c8a84; // 226,684

// D2MENU's cold-path clear (decompressed overlay offsets; the overlay runs at
// 0x06064000). r3 already holds 0x06056980 from the mov.l at +0x2818; the
// words after +0x2828 reload r1 and r2, and r3 ends at 0x06056982 both ways.
const MENU_PATCH_AT = 0x281a;
const MENU_STOCK = [
    0xe200, //  mov   #0,r2
    0x2320, //  mov.b r2,@r3      editor-work flag   = 0
    0x6133, //  mov   r3,r1
    0x7101, //  add   #1,r1
    0x2120, //  mov.b r2,@r1      demo rotation      = 0
    0x7302, //  add   #2,r3
    0x2320, //  mov.b r2,@r3      music restart      = 0
];
const MENU_PATCHED = [
    0xe201, //  mov   #1,r2
    0x2320, //  mov.b r2,@r3      editor-work flag   = 1
    0xe200, //  mov   #0,r2
    0x7301, //  add   #1,r3
    0x2320, //  mov.b r2,@r3      demo rotation      = 0
    0x7301, //  add   #1,r3
    0x2320, //  mov.b r2,@r3      music restart      = 0
];
/** The stock overlay's decompressed size, the patch's own sanity check. */
const MENU_RAW_SIZE = 33568;

// --- the SGM image -------------------------------------------------------------

/** Eight sections (indexed sec0..sec7, decompressed) as one SGM image. */
export function sampleGameImage(sections) {
    if (!Array.isArray(sections) || sections.length !== SECTION_SIZES.length) {
        throw new Error(`a game is ${SECTION_SIZES.length} sections, got ${sections ? sections.length : 0}`);
    }
    const image = new Uint8Array(SGM_IMAGE_SIZE);
    let at = 0;
    for (const index of SGM_MEMORY_ORDER) {
        const s = sections[index];
        if (!s || s.length !== SECTION_SIZES[index]) {
            throw new Error(`sec${index} is ${s ? s.length : 0} bytes, expected ${SECTION_SIZES[index]}`);
        }
        image.set(s, at);
        at += s.length;
    }
    return image;
}

/** An SGM image cut back into its eight sections, indexed sec0..sec7. */
export function sampleGameSections(image) {
    if (image.length !== SGM_IMAGE_SIZE) {
        throw new Error(`an SGM image is ${SGM_IMAGE_SIZE} bytes, got ${image.length}`);
    }
    const sections = [];
    let at = 0;
    for (const index of SGM_MEMORY_ORDER) {
        sections[index] = image.slice(at, at + SECTION_SIZES[index]);
        at += SECTION_SIZES[index];
    }
    return sections;
}

/**
 * How many bytes a .CMP's stream copies out of the ring positions the
 * Saturn's decoder never cleared and the stream had not yet written
 * (0xFEE..0xFFF at the start). Zero means the console decodes it exactly as
 * decompress.js does, whatever the previous file left there.
 */
export function staleRingReads(cmp) {
    const len = (cmp[0] | (cmp[1] << 8) | (cmp[2] << 16) | (cmp[3] << 24)) >>> 0;
    const input = cmp.subarray(4, 4 + len);
    const known = new Uint8Array(0x1000);
    known.fill(1, 0, 0xfee);
    let rpos = 0xfee;
    let stale = 0;
    let i = 0;
    let flags = 0;
    let flagCount = 0;
    while (i < input.length) {
        if (flagCount === 0) {
            flags = input[i++];
            flagCount = 8;
            if (i >= input.length) break;
        }
        const literal = flags & 1;
        flags >>= 1;
        flagCount--;
        if (literal) {
            if (i >= input.length) break;
            i++;
            known[rpos] = 1;
            rpos = (rpos + 1) & 0xfff;
        } else {
            if (i + 1 >= input.length) break;
            const b1 = input[i++];
            const b2 = input[i++];
            const off = b1 | ((b2 & 0xf0) << 4);
            const count = (b2 & 0x0f) + 3;
            for (let k = 0; k < count; k++) {
                const from = (off + k) & 0xfff;
                if (!known[from]) stale++;
                // A byte copied from an unknown one is unknown too.
                known[rpos] = known[from];
                rpos = (rpos + 1) & 0xfff;
            }
        }
    }
    return stale;
}

/** Compress `raw` as a .CMP the Saturn decodes the way decompress.js does,
 * checking both. `what` names it in the errors. */
function saturnCmp(raw, what) {
    const cmp = compressCmp(raw);
    const back = decompressCmp(cmp);
    if (back.length !== raw.length || back.some((b, i) => b !== raw[i])) {
        throw new Error(`${what}: the compressed stream does not decode back to the same bytes`);
    }
    const stale = staleRingReads(cmp);
    if (stale) {
        throw new Error(`${what}: the stream copies ${stale} bytes the Saturn's decoder never cleared`);
    }
    return cmp;
}

/** Eight sections as the SGM_INIT.CMP that boots holding them. */
export function sampleGameCmp(sections) {
    const cmp = saturnCmp(sampleGameImage(sections), BOOT_IMAGE_FILE);
    if (cmp.length > SGM_STAGE_LIMIT) {
        throw new Error(
            `${BOOT_IMAGE_FILE}: ${cmp.length} bytes compressed; the boot load stages at most ${SGM_STAGE_LIMIT}`,
        );
    }
    return cmp;
}

// --- the menu ------------------------------------------------------------------

const wordsAt = (raw, at, count) =>
    Array.from({ length: count }, (_, i) => (raw[at + 2 * i] << 8) | raw[at + 2 * i + 1]);
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

/** "stock", "patched", or null for an overlay this patch does not know. */
export function menuPatchState(raw) {
    if (raw.length !== MENU_RAW_SIZE) return null;
    const words = wordsAt(raw, MENU_PATCH_AT, MENU_STOCK.length);
    if (same(words, MENU_STOCK)) return "stock";
    if (same(words, MENU_PATCHED)) return "patched";
    return null;
}

/** The decompressed D2MENU with the boot flag set; an already patched one is
 * returned unchanged. Throws on an overlay it does not recognise. */
export function patchMenu(raw) {
    const state = menuPatchState(raw);
    if (!state) {
        throw new Error(
            `${MENU_FILE}: not the retail overlay this patch was traced on (${raw.length} bytes; want ${MENU_RAW_SIZE} with the stock words at +0x${
                MENU_PATCH_AT.toString(16)
            })`,
        );
    }
    const out = Uint8Array.from(raw);
    if (state === "stock") {
        MENU_PATCHED.forEach((w, i) => {
            out[MENU_PATCH_AT + 2 * i] = w >> 8;
            out[MENU_PATCH_AT + 2 * i + 1] = w & 0xff;
        });
    }
    return out;
}

// --- the disc ------------------------------------------------------------------

function discFile(disc, name) {
    const bytes = readFile(disc, name);
    if (!bytes) throw new Error(`${name} is not on this disc — is it Dezaemon 2?`);
    return bytes;
}

/**
 * Write `sections` onto a Dezaemon 2 data track (`image`: the Track 1 .bin,
 * MODE1/2352, or a cooked .iso) as its boot image, and — unless `menu` is
 * false — patch the menu so the title neither plays its attract demo over the
 * game nor lets S1-S3 replace it unasked.
 *
 * Returns {image, report}. `report.boot` and `report.menu` (null when the menu
 * was left alone) carry each file's old and new size, where it went and which
 * sectors were rewritten; `report.touched` is every LBA that changed.
 */
export function injectGameIntoDisc(image, sections, { menu = true } = {}) {
    const disc = openDisc(image);
    if (!disc) throw new Error("not a disc image: no ISO 9660 volume");
    for (const name of [BOOT_IMAGE_FILE, MENU_FILE, "GAME.CMP"]) {
        if (!findEntry(disc, name)) throw new Error(`${name} is not on this disc — is it Dezaemon 2?`);
    }
    const oldBoot = discFile(disc, BOOT_IMAGE_FILE);
    const cmp = sampleGameCmp(sections);
    const boot = replaceFile(image, BOOT_IMAGE_FILE, cmp);
    let out = boot.image;
    const touched = new Set(boot.touched);
    const report = {
        boot: {
            file: BOOT_IMAGE_FILE,
            before: oldBoot.length,
            after: cmp.length,
            placement: boot.placement,
            extent: boot.extent,
            sectors: Math.ceil(cmp.length / 2048),
            allocation: boot.allocation,
        },
        menu: null,
        grownBy: boot.grownBy,
        touched: [],
    };
    if (menu) {
        const oldMenu = discFile(disc, MENU_FILE);
        const raw = decompressCmp(oldMenu);
        const state = menuPatchState(raw);
        if (state === "patched") {
            report.menu = { file: MENU_FILE, state: "already patched", before: oldMenu.length, after: oldMenu.length };
        } else {
            const patched = saturnCmp(patchMenu(raw), MENU_FILE);
            const step = replaceFile(out, MENU_FILE, patched);
            out = step.image;
            step.touched.forEach((lba) => touched.add(lba));
            report.grownBy += step.grownBy;
            report.menu = {
                file: MENU_FILE,
                state: "patched",
                before: oldMenu.length,
                after: patched.length,
                placement: step.placement,
                extent: step.extent,
            };
        }
    }
    report.touched = [...touched].sort((a, b) => a - b);
    return { image: out, report };
}

/**
 * What a disc boots holding: its boot image's eight sections, and whether its
 * menu carries the patch ("stock", "patched", or null when unrecognised).
 */
export function readDiscGame(image) {
    const disc = openDisc(image);
    if (!disc) throw new Error("not a disc image: no ISO 9660 volume");
    const sections = sampleGameSections(decompressCmp(discFile(disc, BOOT_IMAGE_FILE)));
    const menu = menuPatchState(decompressCmp(discFile(disc, MENU_FILE)));
    return { sections, menu };
}
