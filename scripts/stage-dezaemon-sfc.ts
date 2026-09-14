// scripts/stage-dezaemon-sfc.ts — the Dezaemon cartridge, where both builds can serve it.
//
//   deno task sfc:stage                → static/snes/Dezaemon.sfc
//   deno task sfc:stage --out path.sfc
//
// WHY A COPY AND NOT THE ROUTE
// /api/dezaemon-sfc already serves this ROM, and in a source checkout that is
// enough. A PACKAGED launcher is the case it cannot cover. The route reads the
// file off disk through lib/dezaemon-sfc.ts, whose repoRoot() walks up looking
// for dev-fixtures/ — and a compiled binary embeds only _fresh/server.js and
// _fresh/client (embedArgs in packages/shmup-harbor/scripts/build-desktop.ts),
// so dev-fixtures/ is not in it and there is nothing for the walk to find. The
// one tree that does reach the binary is static/: `vite build` copies it into
// _fresh/client, which embedArgs includes. So the cart is staged there, and
// the same URL answers in `deno task dev` and in a packaged app.
//
// The bytes are the ones the player wants, not the ones on disk: the copier
// header is stripped on the way out for the reason lib/dezaemon-sfc.ts gives —
// EmulatorJS hands the core whatever file it is given, and 512 bytes of Super
// Wild Card header shift every address in the image.
//
// NEVER COMMITTED, AND THEREFORE NEVER PUBLISHED
// Athena's cart is not ours to ship. .gitignore excludes the staged copy, so
// it exists only on a machine that already had the ROM: Deno Deploy builds
// from the repository and has no such file, and `vite build` there copies an
// empty static/snes/ into the deployed site. This is the same bargain the
// sound bank strikes in vite.config.ts, reached differently — SNDPAC.BIN can
// stay out of static/ entirely because nothing packaged needs it, and a cart
// the packaged launcher has to boot cannot.
//
// Finding no ROM is not an error. Most checkouts have none, `deno task build`
// runs this on every one of them, and a Deploy build must not fail over a file
// it is not supposed to have — so the task says what it did and exits 0. A
// copy already staged is left alone in that case: on a machine whose ROM has
// moved, the staged cart is the only one left.

import { dirname, fromFileUrl, join, relative, resolve } from "@std/path";
import {
  DEZAEMON_SFC_ROM_NAME,
  findDezaemonSfcRom,
  readDezaemonSfcRom,
} from "../lib/dezaemon-sfc.ts";

const ROOT = resolve(dirname(fromFileUrl(import.meta.url)), "..");
/** Where static/snes/play.html looks for the cart. Keep in step with
 * SNES_STATIC_ROM in static/snes-library.js. */
const DEFAULT_OUT = join(ROOT, "static", "snes", DEZAEMON_SFC_ROM_NAME);

function fail(message: string): never {
  console.error(`error: ${message}`);
  Deno.exit(2);
}

let out = DEFAULT_OUT;
for (let i = 0; i < Deno.args.length; i++) {
  const arg = Deno.args[i];
  if (arg === "--out") {
    const next = Deno.args[++i];
    if (!next) fail("--out needs a path");
    out = resolve(next);
  } else if (arg.startsWith("--out=")) {
    out = resolve(arg.slice("--out=".length));
  } else {
    fail(`unknown argument ${JSON.stringify(arg)}`);
  }
}

const extra = [Deno.env.get("DEZAEMON_SFC_ROM") ?? ""].filter(Boolean);
const rom = await findDezaemonSfcRom(ROOT, { extra });

if (!rom) {
  let staged = "";
  try {
    staged = `; the copy already at ${relative(ROOT, out)} is left alone`;
    await Deno.stat(out);
  } catch {
    staged = "";
  }
  console.log(
    "sfc:stage: no Dezaemon (Super Famicom) ROM in dev-fixtures/ " +
      `(or $DEZAEMON_SFC_ROM), so nothing to stage${staged}.`,
  );
  Deno.exit(0);
}

const bytes = await readDezaemonSfcRom(rom);
await Deno.mkdir(dirname(out), { recursive: true });
await Deno.writeFile(out, bytes);
console.log(
  `sfc:stage: ${relative(ROOT, rom.path)} → ${relative(ROOT, out)} ` +
    `(${bytes.length} bytes, ${
      rom.header.copierHeader ? "copier header stripped" : "no copier header"
    })`,
);
