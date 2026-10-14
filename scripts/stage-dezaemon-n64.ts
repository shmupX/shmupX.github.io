// scripts/stage-dezaemon-n64.ts — Dezaemon 3D in English, and the 64DD IPL,
// where both builds can serve them.
//
//   deno task n64:stage                  → static/n64dd/Dezaemon3D.z64 + static/n64dd/64DD_IPL.n64
//   deno task n64:stage --out dir/       → the same two files under another directory
//
// WHY A COPY AND NOT THE ROUTE
// /api/dezaemon-n64 already serves both, translated and in native byte order,
// and in a source checkout that is enough. A PACKAGED launcher is the case it
// cannot cover, for the reason scripts/stage-dezaemon-sfc.ts gives: the route
// reads dev-fixtures/ off real disk, and a compiled binary embeds only
// _fresh/server.js and _fresh/client, which is static/. So the cartridge is
// staged there, patched on the way — the 2024 translation under
// static/n64dd/ applied to the Japanese dump and the result held to the SHA-1
// its readme gives (lib/dezaemon-n64.ts) — and the IPL beside it, and the
// same URLs answer in `deno task dev` and in a packaged app.
//
// NEVER COMMITTED, AND THEREFORE NEVER PUBLISHED
// Athena's cartridge and Nintendo's IPL are not ours to ship. .gitignore
// excludes both staged copies (static/n64dd/*.z64, *.n64), so they exist only
// on a machine that already had the dumps; Deno Deploy builds from the
// repository and has no such files. The patch beside them IS committed: it is
// the translation team's own release and carries none of the ROM.
//
// Finding nothing is not an error. Most checkouts have neither file, `deno
// task build` runs this on every one of them, and a Deploy build must not
// fail over files it is not supposed to have — so the task says what it did
// and exits 0. A copy already staged is left alone in that case. A Dezaemon
// dump the translation does not know (neither the Japanese nor the English
// sum) is reported with its sum and not staged, since the patch would make
// garbage of it.

import { dirname, fromFileUrl, join, relative, resolve } from "@std/path";
import {
  DEZAEMON_N64_ROM_NAME,
  findDezaemonN64,
  N64DD_IPL_NAME,
  readDezaemonN64Rom,
  readN64ddIpl,
} from "../lib/dezaemon-n64.ts";

const ROOT = resolve(dirname(fromFileUrl(import.meta.url)), "..");
/** Where static/n64dd/play.html looks for the pair. Keep in step with
 * N64DD_STATIC_ROM / N64DD_STATIC_IPL in static/n64dd-library.js. */
const DEFAULT_DIR = join(ROOT, "static", "n64dd");

function fail(message: string): never {
  console.error(`error: ${message}`);
  Deno.exit(2);
}

let outDir = DEFAULT_DIR;
for (let i = 0; i < Deno.args.length; i++) {
  const arg = Deno.args[i];
  if (arg === "--out") {
    const next = Deno.args[++i];
    if (!next) fail("--out needs a path");
    outDir = resolve(next);
  } else if (arg.startsWith("--out=")) {
    outDir = resolve(arg.slice("--out=".length));
  } else {
    fail(`unknown argument ${JSON.stringify(arg)}`);
  }
}

async function staged(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isFile;
  } catch {
    return false;
  }
}

const extra = [
  Deno.env.get("DEZAEMON_N64_ROM") ?? "",
  Deno.env.get("N64DD_IPL") ?? "",
].filter(Boolean);
const found = await findDezaemonN64(ROOT, { extra });
const romOut = join(outDir, DEZAEMON_N64_ROM_NAME);
const iplOut = join(outDir, N64DD_IPL_NAME);

if (!found.rom) {
  console.log(
    "n64:stage: no Dezaemon 3D ROM in dev-fixtures/ (or $DEZAEMON_N64_ROM), so nothing to stage" +
      (await staged(romOut)
        ? `; the copy already at ${relative(ROOT, romOut)} is left alone`
        : "") +
      ".",
  );
} else if (found.rom.edition === "unknown") {
  console.log(
    `n64:stage: ${
      relative(ROOT, found.rom.path)
    } is a Dezaemon 3D dump the translation does not know ` +
      `(SHA-1 ${found.rom.sha1}); the patch takes the original Japanese ROM. Not staged.`,
  );
} else {
  const bytes = await readDezaemonN64Rom(found.rom, { root: ROOT });
  await Deno.mkdir(outDir, { recursive: true });
  await Deno.writeFile(romOut, bytes);
  console.log(
    `n64:stage: ${relative(ROOT, found.rom.path)} → ${
      relative(ROOT, romOut)
    } (${bytes.length} bytes, ` +
      `${
        found.rom.edition === "japan"
          ? "translated to English"
          : "already the English ROM"
      }, ` +
      `${found.rom.header.order} order in, z64 out)`,
  );
}

if (!found.ipl) {
  console.log(
    "n64:stage: no 64DD IPL in dev-fixtures/ (or $N64DD_IPL), so none staged" +
      (await staged(iplOut)
        ? `; the copy already at ${relative(ROOT, iplOut)} is left alone`
        : "") +
      ".",
  );
} else {
  const bytes = await readN64ddIpl(found.ipl);
  await Deno.mkdir(outDir, { recursive: true });
  await Deno.writeFile(iplOut, bytes);
  console.log(
    `n64:stage: ${relative(ROOT, found.ipl.path)} → ${
      relative(ROOT, iplOut)
    } (${bytes.length} bytes)`,
  );
}
