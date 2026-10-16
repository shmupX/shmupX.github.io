// `deno task sfc:verify`: the file checks, the Lua that boots a save in Mesen,
// the report that comes back through the battery, and the verdict over it.
//
// The pure parts are tested on images the engine builds — a formatted cart
// and a synthetic level through exportLevelToSfcSram — and on a report
// assembled here the way the Lua assembles it. The last test boots the real
// cart in Mesen with the ALDI Adventure fixture, and is skipped on a
// checkout without Mesen, the ROM or the fixture.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  cgramRowMatches,
  decodeReport,
  encodeReport,
  EXIT,
  liveFindings,
  REPORT_MAGIC,
  staticFindings,
  verifyScript,
  vramTileOrigins,
} from "../scripts/lib/sfc-verify.ts";
import {
  luaByteString,
  mesenHomeCandidates,
  romBaseName,
} from "../lib/sfc-mesen.ts";
import {
  exportLevelToSfcSram,
  formatSfcSram,
  parseSfcSav,
  REGION,
  SRAM_SIZE,
} from "../packages/shmup-engine/src/sfc/index.js";
import { encodePng, newRaster } from "@shmupx/shmup-harbor/png";

// deno-lint-ignore no-explicit-any
type Any = any;

function frame(w: number, h: number, [r, g, b]: number[]) {
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) rgba.set([r, g, b, 255], i * 4);
  rgba[3] = 0;
  return { w, h, rgba };
}

/** The writer test's level: three enemies, a boss, a ship — no scenery grid. */
function level(): Any {
  return {
    name: "tiny sfc",
    width: 8,
    enemylist: [
      ["00", "00", "B0", "00", "00", "B0", "00", "00"],
      ["A1", "00", "00", "A0", "00", "00", "00", "A1"],
      ["00", "A0", "00", "00", "C0", "00", "A0", "00"],
    ],
    enemyData: {
      enemyA: {
        name: "dot",
        hp: 3,
        score: 200,
        speed: 2,
        interval: 60,
        texture: ["dot0.png", "dot1.png"],
      },
      enemyB: {
        name: "slab",
        hp: 20,
        score: 1000,
        speed: 1,
        interval: -1,
        texture: ["slab0.png"],
      },
      enemyC: {
        name: "tower",
        hp: 50,
        score: 5000,
        speed: 4,
        interval: 30,
        texture: ["tower0.png"],
      },
    },
    bossData: {
      boss0: { name: "big", hp: 300, score: 6000, texture: ["boss0.png"] },
    },
    playerData: { texture: ["ship0.png"] },
  };
}

function art(): Any {
  return {
    "dot0.png": frame(12, 14, [255, 0, 0]),
    "dot1.png": frame(12, 14, [200, 0, 0]),
    "slab0.png": frame(30, 14, [0, 0, 255]),
    "tower0.png": frame(14, 30, [0, 200, 0]),
    "boss0.png": frame(100, 60, [0, 255, 0]),
    "ship0.png": frame(24, 24, [255, 255, 255]),
  };
}

const builtLevel = exportLevelToSfcSram(level(), art(), { name: "tiny" }).sram;

const byCheck = (fs: { check: string; level: string }[], check: string) =>
  fs.filter((f) => f.check === check).map((f) => f.level);

Deno.test("a built level passes the file checks, with the gaps it has named", () => {
  const { findings, content } = staticFindings(builtLevel);
  assert(!findings.some((f) => f.level === "fail"), JSON.stringify(findings));
  assertEquals(byCheck(findings, "size"), ["pass"]);
  assertEquals(byCheck(findings, "magic"), ["pass"]);
  assertEquals(byCheck(findings, "checksums"), ["pass"]);
  assertEquals(byCheck(findings, "tiles"), ["pass"]);
  // the writer's synthetic level has waves but no scenery grid
  assert(content.stages[0].spawns > 0);
  assertEquals(content.stages[0].mapCells, 0);
  const stage0 = findings.find((f) => f.check === "stage 0")!;
  assertEquals(stage0.level, "warn");
  assertStringIncludes(stage0.detail, "no scenery");
});

Deno.test("a formatted cart is reported as empty, not broken", () => {
  const { findings, content } = staticFindings(formatSfcSram());
  assert(!findings.some((f) => f.level === "fail"), JSON.stringify(findings));
  assertEquals(content.stagesWithContent, 0);
  assertEquals(byCheck(findings, "stages"), ["warn"]);
  assertEquals(byCheck(findings, "title"), ["warn"]);
  assertEquals(byCheck(findings, "tiles"), ["warn"]);
});

Deno.test("a corrupted word, a missing magic and a half dump each fail", () => {
  const corrupt = builtLevel.slice();
  corrupt[REGION.map.offset + 5] ^= 0xff;
  const a = staticFindings(corrupt).findings;
  assertEquals(byCheck(a, "checksums"), ["fail"]);
  assertStringIncludes(
    a.find((f) => f.check === "checksums")!.detail,
    "stage 0",
  );

  const unmagic = builtLevel.slice();
  unmagic[REGION.checkString.offset] = 0x58;
  assertEquals(byCheck(staticFindings(unmagic).findings, "magic"), ["fail"]);

  const half = builtLevel.slice(0, 0x10000);
  assertEquals(byCheck(staticFindings(half).findings, "size"), ["fail"]);
});

Deno.test("an all-black palette row is pointed out when something draws through it", () => {
  const dark = builtLevel.slice();
  // stage 0's enemy row, 6, goes black
  for (let i = 0; i < 32; i++) dark[REGION.palette.offset + 6 * 32 + i] = 0;
  const { findings } = staticFindings(dark);
  const pal = findings.filter((f) => f.check === "palette");
  assertEquals(pal.length, 1);
  assertStringIncludes(pal[0].detail, "row 6 (enemies)");
});

Deno.test("the Lua literal cannot let one byte run into the next", () => {
  assertEquals(
    luaByteString(new Uint8Array([0, 1, 10, 255, 12])),
    "\\000\\001\\010\\255\\012",
  );
});

Deno.test("the script embeds the whole image and every phase it must reach", () => {
  const lua = verifyScript(builtLevel, { playFrames: 120 });
  assertStringIncludes(lua, 'local SRAM = "\\');
  assertStringIncludes(
    lua,
    "PLAY_FRAMES, MENU_FRAMES, STEP_FRAMES = 120, 1800, 900",
  );
  assertStringIncludes(lua, `"${REPORT_MAGIC}"`);
  for (const code of [EXIT.noMenu, EXIT.noTitle, EXIT.noPlay]) {
    assertStringIncludes(lua, `finish(${code}, `);
  }
  assertStringIncludes(lua, `emu.stop(${EXIT.reportTooBig})`);
  assertStringIncludes(lua, "emu.reset()");
  assertStringIncludes(lua, "emu.takeScreenshot()");
  // the state bytes FORMAT-SFC.md "Running a save" names
  for (const probe of ["0x000D", "0x03D6", "0x00D8", "0x03F4", "0x0406"]) {
    assertStringIncludes(lua, probe);
  }
  // a 64 KB dump is refused rather than padded
  let threw = false;
  try {
    verifyScript(builtLevel.slice(0, 0x10000));
  } catch {
    threw = true;
  }
  assert(threw);
});

Deno.test("the report survives the trip through the battery", () => {
  const enc = new TextEncoder();
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  const bytes = encodeReport([
    [
      "status",
      enc.encode(
        "phase=done;reached=yes;sramDiff=0;magic=T.TABATA;frames=1800;code=0",
      ),
    ],
    ["png:menu", png],
    ["cgram", new Uint8Array(0x200).fill(7)],
  ]);
  // what Mesen writes is the whole 128 KB cart, the report at its start
  const battery = new Uint8Array(SRAM_SIZE);
  battery.set(bytes);
  const r = decodeReport(battery)!;
  assert(r);
  assertEquals(r.status.phase, "done");
  assertEquals(r.status.sramDiff, "0");
  assertEquals(r.status.magic, "T.TABATA");
  assertEquals(r.shots.menu, png);
  assertEquals(r.cgram?.length, 0x200);
  assertEquals(r.vram, null);
  assertEquals(decodeReport(new Uint8Array(SRAM_SIZE)), null);
});

/** CGRAM as the game lays it out: a save row at palette `pal`, shifted up one colour. */
function cgramWith(rows: [number, Uint16Array][]): Uint8Array {
  const cgram = new Uint8Array(0x200);
  for (const [pal, row] of rows) {
    for (let i = 0; i < 15; i++) {
      const at = pal * 32 + (i + 1) * 2;
      cgram[at] = row[i] & 0xff;
      cgram[at + 1] = (row[i] >> 8) & 0x7f;
    }
  }
  return cgram;
}

Deno.test("the verdict reads the console: palettes, tiles, screen, SRAM", async () => {
  const parsed = parseSfcSav(builtLevel);
  const rows = parsed.palettes!.rows;
  const cgram = cgramWith([[7, rows[0].raw], [6, rows[12].raw], [
    12,
    rows[6].raw,
  ], [15, rows[18].raw]]);
  assert(cgramRowMatches(cgram, 12, rows[6].raw));
  assert(!cgramRowMatches(cgram, 5, rows[6].raw));
  assert(cgramRowMatches(cgram, 15, rows[18].raw), "the ship's row");

  // VRAM carrying the save's first eight sheet tiles and some noise
  const vram = new Uint8Array(0x10000);
  vram.set(
    builtLevel.subarray(
      REGION.graphics.offset,
      REGION.graphics.offset + 8 * 32,
    ),
    0x2000,
  );
  vram.fill(0x5a, 0x4000, 0x4000 + 32 * 3);
  const origins = vramTileOrigins(vram, builtLevel, null);
  assertEquals(origins.total, 8 + 3);
  assertEquals(origins.fromSave, 8);
  assertEquals(origins.fromFactory, 0);

  const raster = newRaster(8, 8);
  for (let i = 0; i < 64; i++) {
    raster.data.set([i * 4, 0, 255 - i * 4, 255], i * 4);
  }
  const play = await encodePng(raster);

  const enc = new TextEncoder();
  const status = (s: string) =>
    ["status", enc.encode(s)] as [string, Uint8Array];
  const good = decodeReport(encodeReport([
    status(
      "phase=done;reached=yes;sramDiff=0;sramFirst=;magic=T.TABATA;frames=1800;code=0",
    ),
    ["png:play", new Uint8Array(play)],
    ["cgram", cgram],
    ["vram", vram],
  ]));
  const v = await liveFindings(builtLevel, null, good, EXIT.ok);
  assert(v.ok, JSON.stringify(v.findings));
  assertEquals(byCheck(v.findings, "palette"), [
    "pass",
    "pass",
    "pass",
    "pass",
  ]);
  assertEquals(byCheck(v.findings, "tiles"), ["pass"]);
  assertEquals(byCheck(v.findings, "screen"), ["pass"]);
  assertEquals(byCheck(v.findings, "sram"), ["pass"]);

  // the same console after the ROM rewrote the cart
  const formatted = decodeReport(encodeReport([
    status(
      "phase=done;reached=yes;sramDiff=40000;sramFirst=0x00040 0x00041;magic=T.TABATA;frames=1800;code=0",
    ),
    ["png:play", new Uint8Array(play)],
    ["cgram", new Uint8Array(0x200).fill(0x11)],
    ["vram", vram],
  ]));
  const bad = await liveFindings(builtLevel, null, formatted, EXIT.ok);
  assert(!bad.ok);
  assertEquals(byCheck(bad.findings, "sram"), ["fail"]);
  assertEquals(byCheck(bad.findings, "palette"), [
    "fail",
    "fail",
    "fail",
    "fail",
  ]);

  // a run that never reached the menu
  const stuck = decodeReport(encodeReport([
    status(
      "phase=menu;reached=no;sramDiff=0;sramFirst=;magic=T.TABATA;frames=1801;code=10",
    ),
    ["png:stuck", new Uint8Array(play)],
  ]));
  const s = await liveFindings(builtLevel, null, stuck, EXIT.noMenu);
  assert(!s.ok);
  assertStringIncludes(
    s.findings.find((f) => f.check === "run")!.detail,
    "main menu never appeared",
  );
  assertEquals(byCheck(s.findings, "palette"), []);

  // no report at all
  const none = await liveFindings(builtLevel, null, null, EXIT.reportTooBig);
  assertEquals(byCheck(none.findings, "run"), ["fail"]);
});

Deno.test("Mesen's folders are named after its builds, and the battery after the ROM", () => {
  assertEquals(romBaseName("/x/y/Dezaemon (EN).sfc"), "Dezaemon (EN)");
  const dirs = mesenHomeCandidates("/explicit/home");
  assertEquals(dirs[0], "/explicit/home");
  assert(dirs.some((d) => d.endsWith("Mesen2")));
});

// --- the real cart, when this machine has it -------------------------------

const ROOT = new URL("../", import.meta.url).pathname;
const FIXTURE = join(
  ROOT,
  "dev-fixtures",
  "SNES Dezaemon - Kaite Tsukutte Asoberu",
  "ALDI Adventure (2026-08-22).srm",
);
const haveFixture = (() => {
  try {
    return Deno.statSync(FIXTURE).isFile;
  } catch {
    return false;
  }
})();
const haveMesen = await (async () => {
  const { findMesenBin, mesenBinExists } = await import("../lib/sfc-mesen.ts");
  return await mesenBinExists(findMesenBin());
})();

Deno.test({
  name: "the ALDI Adventure fixture boots, loads and plays in Mesen",
  ignore: !haveFixture || !haveMesen,
  async fn() {
    const { verifySfcSave } = await import("../scripts/verify-sfc.ts");
    const out = await Deno.makeTempDir({ prefix: "sfc-verify-test-" });
    try {
      const r = await verifySfcSave({
        save: FIXTURE,
        rom: null,
        out,
        mesen: null,
        mesenHome: null,
        playFrames: 120,
        timeout: 120,
        staticOnly: false,
        json: false,
      });
      assert(r.ran, "Mesen did not run");
      assert(r.ok, JSON.stringify(r.live));
      assertEquals(r.exitCode, EXIT.ok);
      assertEquals(byCheck(r.live, "sram"), ["pass"]);
      assertEquals(byCheck(r.live, "palette"), ["pass", "pass", "pass"]);
      assert(r.shots.some((p) => p.endsWith("play.png")));
    } finally {
      await Deno.remove(out, { recursive: true }).catch(() => {});
    }
  },
});
