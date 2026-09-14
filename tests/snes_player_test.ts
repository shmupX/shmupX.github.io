// The Super Famicom player, and the three copies it leans on.
//
// static/snes/play.html is the first core in static/emulators.json served by
// THIS origin instead of by the cmg mirror, and that arrangement rests on
// facts spread across five files that cannot import each other: the catalogue
// says the core is `local`, the worker's MIRRORABLE list leaves /snes/ alone,
// the page points at EmulatorJS vendored inside another game's folder,
// static/snes-library.js names the staged cart's URL, and
// scripts/stage-dezaemon-sfc.ts writes it. Any one of them drifting is a black
// screen in a player's browser — a 504 from an origin that has never served
// /snes/, or a 404 for a core that used to be there — so they are checked
// against each other rather than trusted.
//
// It also pins the thing no code can: that the staged cartridge is gitignored.
// Athena's ROM is not ours to ship, and the only reason a copy under static/
// is safe is that Deno Deploy builds from this repository and git does not
// carry it.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { DEZAEMON_SFC_TITLE } from "../lib/dezaemon-sfc.ts";
import { emuStateFor } from "../static/ps2-library.js";
import {
  findSnesRom,
  SNES_BYOD_FILE,
  SNES_BYOD_PLAYER,
  SNES_BYOD_READY,
  SNES_CORE_ID,
  SNES_ROM_TITLE,
  SNES_STATIC_ROM,
  snesBootFiles,
} from "../static/snes-library.js";

// deno-lint-ignore no-explicit-any
type Any = any;

const repo = (p: string) => new URL(`../${p}`, import.meta.url);
const read = (p: string) => Deno.readTextFile(repo(p));

async function exists(p: string): Promise<boolean> {
  try {
    return (await Deno.stat(repo(p))).isFile;
  } catch {
    return false;
  }
}

const catalog = JSON.parse(await read("static/emulators.json"));
const snesCore = (catalog.cores ?? []).find((c: Any) => c.id === SNES_CORE_ID);
const player = await read("static/snes/play.html");

Deno.test("the Super Famicom core is local, and says so", async () => {
  assert(snesCore, "static/emulators.json lists no snes core");
  assertEquals(
    snesCore.local,
    true,
    "the snes core is served from this origin; without `local` the installer " +
      "would wait on a service worker and the warm would mirror our own page " +
      "from cmg",
  );
  assertEquals(
    snesCore.prefixes,
    [],
    "a local core owns no mirrored paths — see MIRRORABLE in static/emu-sw.js",
  );
  assertEquals(snesCore.player, "/snes/play.html");
  assertEquals(
    "manifest" in snesCore,
    false,
    "there is no mirror shelf for this console, so there is no manifest to " +
      "read; svelte-src/Dashboard.svelte skips the fetch when the field is absent",
  );
  assert(
    await exists("static/snes/play.html"),
    "the catalogue's player must be a file this origin serves",
  );
});

Deno.test("nothing mirrors the player this origin serves", async () => {
  const worker = await read("static/emu-sw.js");
  const block = worker.match(/const MIRRORABLE = \[([\s\S]*?)\];/);
  assert(block, "no MIRRORABLE list in static/emu-sw.js");
  const mirrorable = [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);

  // The worker's own matcher, so this test agrees with it by construction.
  const claimed = (pathname: string) =>
    mirrorable.some((p) => pathname === p || pathname.startsWith(p));

  for (const path of ["/snes/", "/snes/play.html", "/snes/Dezaemon.sfc"]) {
    assertEquals(
      claimed(path),
      false,
      `${path} is served from static/; a MIRRORABLE entry would send it to ` +
        `${catalog.origin}, which has never served /snes/ at all`,
    );
  }
});

Deno.test("installing a local core gives the worker nothing to mirror", () => {
  // The state the dashboard would push with only the Super Famicom installed.
  // Empty prefixes is the whole point: a visitor whose one core is local has
  // nothing for a service worker to answer, so none is registered.
  assertEquals(emuStateFor(catalog, [SNES_CORE_ID]), {
    origin: catalog.origin,
    prefixes: [],
    isolated: [],
  });

  // ...and a local core alongside a mirrored one adds nothing of its own, not
  // even a claim on the catalogue's shared scripts.
  const ps2Only = emuStateFor(catalog, ["ps2"]);
  assertEquals(emuStateFor(catalog, ["ps2", SNES_CORE_ID]), ps2Only);
});

Deno.test("the player boots on the EmulatorJS Super Mario SP vendors", async () => {
  const at = player.match(/var EJS_DATA = "([^"]+)"/);
  assert(at, "static/snes/play.html must name the EmulatorJS it loads");
  const data = at[1];
  assert(
    data.startsWith("/") && data.endsWith("/"),
    "an absolute directory: this page has one mount point and the files are " +
      "in another one",
  );

  // Pruning any of these from the game folder breaks this page too, which is
  // the whole reason the dependency is written down here.
  for (
    const file of [
      "loader.js",
      "emulator.min.js",
      "emulator.min.css",
      "cores/snes9x-wasm.data",
      "cores/reports/snes9x.json",
      "compression/extract7z.js",
    ]
  ) {
    assert(
      await exists("static" + data + file),
      `static${data}${file} is missing — static/snes/play.html loads it, and ` +
        `scripts/vendor-emulatorjs.ts is what puts it there`,
    );
  }

  // Nothing may reach for the CDN: the point of vendoring is a player that
  // works offline and on a machine that has never seen emulatorjs.org.
  assertEquals(
    player.includes("cdn.emulatorjs.org"),
    false,
    "the player must not fetch EmulatorJS from the CDN",
  );
  // SharedArrayBuffer is not available here — ISOLATED_PLAYERS in main.ts and
  // vite.config.ts covers /ps2/ and /switch/ only — and threads:true is a hard
  // start error without it.
  assertStringIncludes(player, "window.EJS_threads = false;");
  assertStringIncludes(player, 'window.EJS_core = "snes";');
});

Deno.test("the page implements the hand-off the launcher performs", () => {
  // static/snes-library.js names these; the page has to answer to them. They
  // are strings on a postMessage, so nothing but this test connects the two.
  assertEquals(SNES_BYOD_PLAYER, "/snes/play.html?byod=1");
  assertStringIncludes(player, `"${SNES_BYOD_READY}"`);
  assertStringIncludes(player, `"${SNES_BYOD_FILE}"`);
  // Same-origin on both sides. The cart is the operator's own file and the
  // launcher is the page's own parent; a "*" here would hand either to anyone
  // who framed the player.
  assertStringIncludes(player, "e.origin !== location.origin");
  assertStringIncludes(
    player,
    'window.parent.postMessage({ type: "snes-byod-ready" }, location.origin)',
  );
});

Deno.test("the staged cart has one path, spelled the same in both halves", async () => {
  const stager = await read("scripts/stage-dezaemon-sfc.ts");
  // scripts/stage-dezaemon-sfc.ts joins ROOT + static + snes + the ROM name
  // from lib/dezaemon-sfc.ts; the browser has to ask for exactly that URL.
  assertEquals(SNES_STATIC_ROM, "/snes/Dezaemon.sfc");
  assertStringIncludes(stager, '"static", "snes", DEZAEMON_SFC_ROM_NAME');

  // static/ is plain browser ESM and cannot import the .ts constant, so the
  // title exists twice on purpose.
  assertEquals(SNES_ROM_TITLE, DEZAEMON_SFC_TITLE);
});

Deno.test("the staged cart is gitignored, and therefore never deployed", async () => {
  const ignore = await read(".gitignore");
  // The URL the browser asks for is the path under static/ that serves it.
  const dir = "static" +
    SNES_STATIC_ROM.slice(0, SNES_STATIC_ROM.lastIndexOf("/"));
  assertStringIncludes(
    ignore,
    `\n${dir}/*.sfc\n`,
    "Athena's cartridge is not ours to ship. A copy under static/ is only " +
      "safe because Deno Deploy builds from this repository: git not " +
      "carrying the file is what keeps `vite build` from copying it into the " +
      "deployed site.",
  );
});

// ── The cartridge probe, with no server at all ───────────────────────────────

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** A route that answers "no cartridge" and a static/ that holds one. */
function stagedOnly(bytes = new Uint8Array(0x80000)): Fetch {
  return (url, init) => {
    if (url.startsWith(SNES_STATIC_ROM)) {
      const headers = { "content-length": String(bytes.length) };
      return Promise.resolve(
        init?.method === "HEAD"
          ? new Response(null, { headers })
          : new Response(bytes as BlobPart, { headers }),
      );
    }
    return Promise.resolve(
      Response.json({ available: false, reason: "local only" }),
    );
  };
}

Deno.test("a packaged build finds the cart under static/, not in dev-fixtures", async () => {
  const rom = await findSnesRom({ fetchImpl: stagedOnly() });
  assertEquals(rom.available, true);
  assertEquals(rom.rom, SNES_STATIC_ROM);
  assertEquals(rom.source, "staged");
  assertEquals(rom.size, 0x80000);
  assertEquals(rom.title, DEZAEMON_SFC_TITLE);
});

Deno.test("the route wins over the staged copy when both answer", async () => {
  const both: Fetch = (url, init) => {
    if (url.startsWith("/api/dezaemon-sfc")) {
      return Promise.resolve(Response.json({
        available: true,
        name: "Deza.sfc",
        rom: "/api/dezaemon-sfc?rom=1",
      }));
    }
    return stagedOnly()(url, init);
  };
  // The file on disk is the one the operator is editing; the staged copy can
  // be a build old.
  const rom = await findSnesRom({ fetchImpl: both });
  assertEquals(rom.name, "Deza.sfc");
  assertEquals(rom.rom, "/api/dezaemon-sfc?rom=1");
});

Deno.test("the bare cartridge boots with no save under it", async () => {
  const boot = await snesBootFiles(undefined, { fetchImpl: stagedOnly() });
  assertEquals(boot.sram, null, "the cartridge row has no shelf entry");
  assertEquals(boot.title, DEZAEMON_SFC_TITLE);
  assertEquals(boot.rom.name, "Dezaemon.sfc");
  assertEquals(boot.rom.size, 0x80000);
});
