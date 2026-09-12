// Unpack a Dezaemon 2 disc into dev-fixtures/.cache/saturn-disc/ — every ISO
// 9660 file, and every `.CMP` decompressed beside it in unpacked/.
//
//   deno run -A dev-fixtures/debug-tools/extract-disc.ts [image] [out]
//
// `extract-cmp.mjs` pulls one file out and decompresses it, which is the right
// tool when you know what you want. This is the other half: the whole disc at
// once, because almost every question about the format turns out to need a
// file nobody predicted — the play engine for a routine, an overlay for the
// editor's own labels, a sample game to hold a save against, a preset song, a
// background, the part library.
//
// What lands in the cache, and why each matters:
//
//   unpacked/GAME.bin    the PLAY-MODE ENGINE, 165,628 B, loads at 0x06064000.
//                        FORMAT.md writes its addresses as "+0xNNNNN", meaning
//                        that file offset, so +0x19810 is RAM 0x0607D810.
//   0KERNEL.BIN          the main SH-2 program: sound driver, menus, the shell.
//   unpacked/KUMITATE    組み子さん, the game assembler — the editor screen that
//                        writes most of sec5.
//   unpacked/S_PAINT     絵太郎, the CG editor.  unpacked/POLYKITI  ポリ吉, the 3D
//                        part editor, whose POLYHELP/POLYBTN carry its labels.
//   SGM_*.CMP            six complete games (DAIO, RAMS, ELFI, MIYA, GUST,
//                        INIT), each 766,596 B = the eight sections raw in
//                        memory order sec0-3, 5, 4, 6, 7. Two of them are also
//                        in the community collection, which is what
//                        test/disc-sample-games.test.js holds equal end to end.
//   SMP_BGM.BIN          uncompressed, exactly sec6's 101,472 B.
//   M_DATA01-73.BIN      the preset songs, 4,228 B each — a save's sec6 is
//                        mostly these.
//   MDLDT_01-56.CMP      the ポリ吉 part library the sec7 shape word indexes.
//   DEMO_?N.BIN          per-stage input recordings for the sample games.
//   DEZA2.PAL            the editor's 18x16 RGB555 palette.
//
// Verify a fresh extraction before trusting an offset: GAME.bin must be
// 165,628 bytes and the interval table at RAM 0x6085F60 must read
// `00 1d 00 16 00 10 00 0b 00 07 00 04 00 02 00 01` (u16be, values in the low
// bytes). If it does not, the LZSS phase is off and every address is wrong.
// This checks both and says so.
//
// The disc is community content: it stays in the gitignored dev-fixtures/, and
// so does everything this writes.

import { basename } from "@std/path";
import {
  listFiles,
  openDisc,
  readFile,
} from "../../packages/shmup-engine/src/cd/iso9660-read.js";
import { decompressCmp } from "../../packages/shmup-engine/src/decompress.js";

const DEFAULT_OUT = "dev-fixtures/.cache/saturn-disc";
/** What GAME.bin has to look like for its addresses to mean anything. */
const GAME_SIZE = 165_628;
const GAME_BASE = 0x06064000;
const ANCHOR_ADDR = 0x06085f60;
const ANCHOR = "001d00160010000b0007000400020001";

function fail(message: string): never {
  console.error(`error: ${message}`);
  Deno.exit(2);
}

/** Every disc image in dev-fixtures/, biggest first — the data track wins. */
function findImage(): string {
  const found: { path: string; size: number }[] = [];
  for (const entry of Deno.readDirSync("dev-fixtures")) {
    if (!entry.isFile) continue;
    if (!/\.(bin|iso|img)$/i.test(entry.name)) continue;
    if (!/dezaemon 2/i.test(entry.name)) continue;
    found.push({
      path: `dev-fixtures/${entry.name}`,
      size: Deno.statSync(`dev-fixtures/${entry.name}`).size,
    });
  }
  found.sort((a, b) => b.size - a.size);
  if (found.length === 0) {
    fail(
      "no Dezaemon 2 disc image in dev-fixtures/ (a .bin, .iso or .img); pass one as the first argument",
    );
  }
  return found[0].path;
}

const image = Deno.args[0] || findImage();
const out = Deno.args[1] || DEFAULT_OUT;

let disc;
try {
  disc = openDisc(Deno.readFileSync(image));
} catch (err) {
  fail(`cannot open ${image}: ${(err as Error).message}`);
}

await Deno.mkdir(`${out}/unpacked`, { recursive: true });

let files = 0;
let unpacked = 0;
const failures: string[] = [];
for (const entry of listFiles(disc)) {
  const name = entry.name.replace(/;1$/, "");
  const bytes = readFile(disc, entry.name) ?? readFile(disc, name);
  if (!bytes) {
    failures.push(`${name}: unreadable`);
    continue;
  }
  Deno.writeFileSync(`${out}/${name}`, bytes);
  files++;
  if (!name.endsWith(".CMP")) continue;
  try {
    Deno.writeFileSync(
      `${out}/unpacked/${name.replace(/\.CMP$/, ".bin")}`,
      Uint8Array.from(decompressCmp(bytes)),
    );
    unpacked++;
  } catch (err) {
    failures.push(`${name}: ${(err as Error).message}`);
  }
}

console.log(
  `${
    basename(image)
  } -> ${out}: ${files} files, ${unpacked} of them decompressed`,
);
for (const f of failures) console.log(`  ${f}`);

// The two checks that say whether the addresses are usable.
let game: Uint8Array | null = null;
try {
  game = Deno.readFileSync(`${out}/unpacked/GAME.bin`);
} catch {
  console.log("GAME.bin: not on this disc — nothing to check");
}
if (game) {
  const sizeOk = game.length === GAME_SIZE;
  const at = ANCHOR_ADDR - GAME_BASE;
  const anchor = Array.from(
    game.subarray(at, at + 16),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
  const anchorOk = anchor === ANCHOR;
  console.log(
    `GAME.bin ${game.length} bytes ${
      sizeOk ? "(expected)" : `(EXPECTED ${GAME_SIZE})`
    }`,
  );
  console.log(
    `interval table at 0x${ANCHOR_ADDR.toString(16)}: ${anchor} ${
      anchorOk ? "(matches)" : "(DOES NOT MATCH — the LZSS phase is off)"
    }`,
  );
  if (!sizeOk || !anchorOk) Deno.exit(1);
  console.log("addresses in FORMAT.md are good against this extraction");
}
