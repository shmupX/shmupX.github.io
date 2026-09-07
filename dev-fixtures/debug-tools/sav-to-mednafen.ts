// Turn an exported (or community) Dezaemon 2 .sav into Mednafen's Saturn save
// pair, so a save the writer produced (scripts/build-sav.ts) can be dropped
// straight into a Mednafen base directory and loaded from the cartridge in the
// game's own LOAD menu — the emulator round trip that validates the writer.
//
//   deno run -A dev-fixtures/debug-tools/sav-to-mednafen.ts <file.sav> <out-base>
//   deno run -A dev-fixtures/debug-tools/sav-to-mednafen.ts "Dez 2 - foo.sav" ~/.mednafen/sav/"Dezaemon 2 (Japan)"
//
// The input is the 1,114,112-byte 0xFF-interleaved image (32 KB internal +
// 512 KB cart) the writer emits and MiSTer's Saturn core reads; normalize()
// de-interleaves it. Mednafen keeps the cart as <name>.bcr (a gzip of just the
// 512 KB cart partition, the same shape Mednafen writes) and the internal RAM
// as <name>.bkr (raw 32 KB). <name> must match the disc so Mednafen finds it:
// with `filesys.fname_sav %f.%x` in mednafen.cfg it is the cue's base name,
// e.g. sav/"Dezaemon 2 (Japan)". Close Mednafen first — it rewrites its save
// files on exit and would clobber a freshly written pair.
//
// The inverse of the .bcr half is a plain gunzip; bup-source.normalize() eats
// either the .bcr (gzip) or the raw .sav, so a save written here re-imports
// through the same pipeline the editor's importer uses.

import {
  CART_PARTITION_SIZE,
  INTERNAL_PARTITION_SIZE,
  normalize,
} from "../../packages/shmup-engine/mod.js";

const [input, outBase] = Deno.args;
if (!input || !outBase) {
  console.error(
    "usage: sav-to-mednafen.ts <file.sav> <out-base-without-extension>",
  );
  Deno.exit(2);
}

const { data } = await normalize(await Deno.readFile(input));
const expected = INTERNAL_PARTITION_SIZE + CART_PARTITION_SIZE;
if (data.length !== expected) {
  console.error(
    `error: ${input} normalizes to ${data.length} bytes, expected ${expected} ` +
      `(a MiSTer-layout .sav = 32 KB internal + 512 KB cart)`,
  );
  Deno.exit(1);
}

const cart = data.subarray(INTERNAL_PARTITION_SIZE);
const gz = new Uint8Array(
  await new Response(
    new Blob([cart]).stream().pipeThrough(new CompressionStream("gzip")),
  ).arrayBuffer(),
);
await Deno.writeFile(outBase + ".bcr", gz);
await Deno.writeFile(
  outBase + ".bkr",
  data.subarray(0, INTERNAL_PARTITION_SIZE),
);
console.log(
  `wrote ${outBase}.bcr (${gz.length} B, gzip of the cart partition) and ${outBase}.bkr (${INTERNAL_PARTITION_SIZE} B)`,
);
