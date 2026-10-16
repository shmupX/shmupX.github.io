// scripts/lib/sfc-verify.ts — does a Super Famicom Dezaemon save run? The
// pure half of `deno task sfc:verify`: what to check in the file, the Lua
// that boots it in Mesen and plays it, how the answer is read back, and the
// verdict.
//
// A save can be sealed and well-formed and still be the wrong game. The ROM
// decides at boot whether the SRAM is a cart it believes (FORMAT-SFC.md
// "Boot"): a failed check formats the cart back to the factory sample, so the
// player presses GAME PLAY and gets Daioh Gale with no sign that anything was
// rejected. The only witness is the running game, so the check here is in
// two layers:
//
//   1. STATIC — parseSfcSav and verifySfcChecksums over the file: the size,
//      the magic, the seventeen checksum words, and what the level actually
//      carries (a title picture, scenery, spawns, its own tiles), because a
//      save that loads but draws nothing is reported as "runs" by every
//      other measure.
//   2. LIVE — the real ROM in Mesen's test runner (lib/sfc-mesen.ts): the
//      SRAM is put under the cart, the boot runs, the main menu is answered
//      with Start (GAME PLAY), the game's own title with Start again, and
//      after a stretch of play the script reads back what it can see:
//        - the SRAM, byte for byte against the file (the ROM rewrites the
//          checksum block and MOUSE SPEED at every boot; nothing else);
//        - CGRAM, where BG palette 7 is stage 0's scenery row, BG palette 6
//          its boss row and OBJ palette 4 its enemy row, each shifted up one
//          colour (colour 0 is transparent);
//        - VRAM, where the stage's chips are the save's own tiles;
//        - screenshots of the menu, the title and the play.
//      All of it comes back through the battery file Mesen writes on stop.
//
// STATE BYTES
// The script polls WRAM rather than counting frames, because the splash,
// the fades and the title animation take as long as they take. The bytes
// were found by diffing dumps of each screen (two saves, both games):
//   $000D == 1 and $03D6 == 5   the main menu (GAME PLAY / EDIT / ETC.)
//   $000D == 0 and $00D8 == $9C the game's title (GAME START / OPTION / EXIT)
//   $03F4 == 1 and $0406 == 3   a stage playing
// On the main menu Start IS "GAME PLAY" whatever the cursor points at (B
// picks the pointed entry); on the game's title Start picks the cursor's
// entry, which rests on GAME START.

import {
  compareWithRomDefault,
  isDezaemonRom,
  parseSfcSav,
  REGION,
  romDefaultImage,
  SRAM_SIZE,
  verifySfcChecksums,
} from "../../packages/shmup-engine/src/sfc/index.js";
import { luaByteString } from "../../lib/sfc-mesen.ts";
import { decodePng } from "@shmupx/shmup-harbor/png";

/** One line of the verdict. `fail` is a save the ROM rejects or a run that did not play. */
export interface Finding {
  level: "pass" | "warn" | "fail";
  check: string;
  detail: string;
}

const DEFAULT_KEY_CONFIG = [0x20, 0x08, 0x10, 0x20];

/** Any content at all: a save with none of these is a cart the game formats to nothing. */
export interface SaveContent {
  stages: {
    stage: number;
    mapCells: number;
    spawns: number;
    spawnLines: number;
    enemies: number;
    boss: boolean;
  }[];
  titleChips: number;
  /** MY SHIP GROUP pose slots (0-11) naming the save's own chips: the level's ship, not the factory's. */
  shipPoseChips: number;
  tiles: number;
  /** Stages that carry scenery or spawns. */
  stagesWithContent: number;
}

// deno-lint-ignore no-explicit-any
type Parsed = any;

export function saveContent(parsed: Parsed): SaveContent {
  const stages = [];
  for (let n = 0; n < 6; n++) {
    const map = parsed.maps?.[n];
    const appear = parsed.appear?.[n];
    const enemies = parsed.enemies?.[n];
    stages.push({
      stage: n,
      mapCells: map?.used ?? 0,
      spawns: appear?.spawns ?? 0,
      spawnLines: appear?.used ?? 0,
      enemies: enemies?.used ?? 0,
      boss: !!enemies && !enemies.boss.blank,
    });
  }
  const titleChips =
    parsed.groups?.title?.filter((c: { empty: boolean }) => !c.empty).length ??
      0;
  const shipPoseChips =
    parsed.groups?.myShip?.slice(0, 12).filter((c: { user: boolean }) => c.user)
      .length ?? 0;
  return {
    stages,
    titleChips,
    shipPoseChips,
    tiles: parsed.graphics?.usedCount ?? 0,
    stagesWithContent: stages.filter((s) => s.mapCells > 0 || s.spawns > 0)
      .length,
  };
}

/**
 * Everything the file alone can answer. `fail` findings mean the ROM will
 * not accept the save (or cannot be given it); `warn` findings mean it will
 * run but show less than the player expects.
 */
export function staticFindings(
  sram: Uint8Array,
  rom: Uint8Array | null = null,
): { findings: Finding[]; parsed: Parsed; content: SaveContent } {
  const findings: Finding[] = [];
  const parsed = parseSfcSav(sram, { rom });
  const content = saveContent(parsed);
  const f = (level: Finding["level"], check: string, detail: string) =>
    findings.push({ level, check, detail });

  if (sram.length !== SRAM_SIZE) {
    f(
      "fail",
      "size",
      `${sram.length} bytes; the cart's battery is ${SRAM_SIZE} (a 64 KB dump has no graphics bank)`,
    );
  } else f("pass", "size", `${SRAM_SIZE} bytes, a full cart`);

  if (parsed.checkStringOk) f("pass", "magic", `"T.TABATA" at 0x7FF8`);
  else {
    f(
      "fail",
      "magic",
      `check string is ${
        JSON.stringify(parsed.checkString)
      }, not "T.TABATA": the ROM formats a cart without it`,
    );
  }

  if (sram.length >= SRAM_SIZE) {
    const v = verifySfcChecksums(sram);
    const bad = v.words.filter((w: { ok: boolean }) => !w.ok);
    if (v.ok) f("pass", "checksums", "all 17 words verify, copy matches");
    else {
      f(
        "fail",
        "checksums",
        `${bad.length} of 17 words do not verify (${
          bad.map((w: { name: string }) => w.name).join(", ")
        })${
          !v.blockOk && !v.copyOk
            ? " — both the block and its copy fail, so the ROM formats the cart"
            : v.blockOk
            ? " — the boot passes word F and shows CHECK SUM, then loads the save"
            : " — the block fails but the copy holds; the ROM restores it from the copy"
        }`,
      );
    }
  }

  if (parsed.errors?.length) {
    f(
      "fail",
      "parse",
      parsed.errors.map((e: { block: string; message: string }) =>
        `${e.block}: ${e.message}`
      ).join("; "),
    );
  }

  if (rom) {
    if (!isDezaemonRom(rom)) {
      f("fail", "rom", "the ROM given is not a Dezaemon cart (header)");
    } else {
      const cmp = compareWithRomDefault(sram, rom);
      if (cmp.identical) {
        f(
          "warn",
          "factory",
          "the first 64 KB is the ROM's own default image: this is the factory sample, not a built level",
        );
      } else {
        f(
          "pass",
          "factory",
          `${
            cmp.total - cmp.equal
          } of ${cmp.total} bytes differ from the ROM's default image`,
        );
      }
      if (parsed.rom && !parsed.rom.regionTableMatches) {
        f("warn", "rom", "the ROM's region table differs from the parser's");
      }
    }
  }

  // What the player will see.
  if (content.titleChips === 0) {
    f(
      "warn",
      "title",
      "TITLE GROUP is blank: the game's title screen shows no picture, only GAME START / OPTION / EXIT",
    );
  } else f("pass", "title", `${content.titleChips} title chips`);

  if (content.shipPoseChips === 0) {
    f(
      "warn",
      "ship",
      "the ship's pose slots name no chip of the save's own: the factory ship flies",
    );
  } else {
    f(
      "pass",
      "ship",
      `the level's own ship: ${content.shipPoseChips} of the 12 pose chips are the save's`,
    );
  }

  for (const s of content.stages) {
    const parts: string[] = [];
    if (s.mapCells === 0) parts.push("no scenery (black background)");
    if (s.spawns === 0) {
      parts.push("no spawns (the stage ends at its first line)");
    }
    if (parts.length && (s.stage === 0 || s.mapCells + s.spawns > 0)) {
      f("warn", `stage ${s.stage}`, parts.join("; "));
    } else if (!parts.length) {
      f(
        "pass",
        `stage ${s.stage}`,
        `${s.mapCells} scenery cells, ${s.spawns} spawns over ${s.spawnLines} lines, ${s.enemies} enemies${
          s.boss ? ", boss" : ""
        }`,
      );
    }
  }
  // Rows the game copies to CGRAM that are all black draw their content
  // invisibly — the usual reason a title "shows nothing". Words 0..14 are
  // the colours (the console lands them at 1..15; word 15 is never copied).
  const rows = parsed.palettes?.rows ?? [];
  const black = (row: number) =>
    rows[row]
      ? Array.from(rows[row].raw as Uint16Array).every((w, i) =>
        i === 15 || (w & 0x7fff) === 0
      )
      : false;
  if (content.titleChips > 0 && black(19)) {
    f(
      "warn",
      "palette",
      "row 19 (title) is all black: the title picture draws invisibly",
    );
  }
  for (const s of content.stages) {
    const dark: string[] = [];
    if (s.mapCells > 0 && black(s.stage)) dark.push(`row ${s.stage} (scenery)`);
    if (s.enemies > 0 && black(6 + s.stage)) {
      dark.push(`row ${6 + s.stage} (enemies)`);
    }
    if (s.boss && black(12 + s.stage)) dark.push(`row ${12 + s.stage} (boss)`);
    if (dark.length) {
      f("warn", "palette", `stage ${s.stage}: ${dark.join(", ")} all black`);
    }
  }
  if (content.stagesWithContent === 0) {
    f("warn", "stages", "no stage carries scenery or spawns");
  } else if (content.stagesWithContent < 6) {
    f(
      "warn",
      "stages",
      `${content.stagesWithContent} of 6 stages carry anything; the rest end at their first line`,
    );
  }
  if (content.tiles === 0) {
    f(
      "warn",
      "tiles",
      "GRAPIC DATA is blank: everything drawn is the ROM's factory art",
    );
  } else f("pass", "tiles", `${content.tiles} tiles in the save's sheets`);

  if (sram.length >= REGION.keyConfig.end) {
    const kc = Array.from(
      sram.subarray(REGION.keyConfig.offset, REGION.keyConfig.end),
    );
    if (kc.some((b, i) => b !== DEFAULT_KEY_CONFIG[i])) {
      f(
        "warn",
        "keys",
        `KEY CONFIG is ${
          kc.map((b) => b.toString(16).padStart(2, "0")).join(" ")
        }, not the default 20 08 10 20: the buttons are remapped in this save`,
      );
    }
  }

  return { findings, parsed, content };
}

/** ─── the Lua ───────────────────────────────────────────────────────────── */

export const REPORT_MAGIC = "SFCVERIFY1";

/** Exit codes the script hands Mesen. */
export const EXIT = Object.freeze({
  ok: 0,
  noMenu: 10,
  noTitle: 11,
  noPlay: 12,
  reportTooBig: 20,
});

export interface ScriptOptions {
  /** Frames to let the stage run before reading the console (default 600: ten seconds). */
  playFrames?: number;
  /** Frames to wait for the main menu after reset (default 1800). */
  menuFrames?: number;
  /** Frames to wait for each later screen (default 900). */
  stepFrames?: number;
}

/**
 * The script: `sram` goes under the cart, the console resets, the two Starts
 * are pressed when their screens arrive (and again every 120 frames while
 * they are not answered), and the report is written into SRAM before
 * emu.stop(). Mesen's Lua sandbox has no io and no os, so the whole
 * conversation is this string and the battery file.
 */
export function verifyScript(
  sram: Uint8Array,
  { playFrames = 600, menuFrames = 1800, stepFrames = 900 }: ScriptOptions = {},
): string {
  if (sram.length !== SRAM_SIZE) {
    throw new Error(
      `the script embeds a ${SRAM_SIZE}-byte image; got ${sram.length}`,
    );
  }
  return `-- generated by scripts/lib/sfc-verify.ts
local SRAM = "${luaByteString(sram)}"
local PLAY_FRAMES, MENU_FRAMES, STEP_FRAMES = ${playFrames}, ${menuFrames}, ${stepFrames}
local SAVE, WRAM, CGRAM, VRAM = emu.memType.snesSaveRam, emu.memType.snesWorkRam, emu.memType.snesCgRam, emu.memType.snesVideoRam

local frames, phase, phaseAt, lastPress, seenAt = 0, "boot", 0, -1000, -1
local SETTLE_MENU, SETTLE_TITLE = 60, 240 -- the title's elements fly in for ~200 frames
local hold = 0
local shots = {}

local function rd(a, t) return emu.read(a, t, false) end
local function u32(n)
  return string.char(n % 256, math.floor(n / 256) % 256, math.floor(n / 65536) % 256, math.floor(n / 16777216) % 256)
end
local function dump(t, from, len)
  local w = {}
  for a = from, from + len - 1 do w[#w + 1] = string.char(rd(a, t)) end
  return table.concat(w)
end
local function shot(name) shots[#shots + 1] = { "png:" .. name, emu.takeScreenshot() } end
local function isMenu() return rd(0x000D, WRAM) == 1 and rd(0x03D6, WRAM) == 5 end
local function isTitle() return rd(0x000D, WRAM) == 0 and rd(0x00D8, WRAM) == 0x9C end
local function isPlay() return rd(0x03F4, WRAM) == 1 and rd(0x0406, WRAM) == 3 end
local function press() hold = 8; lastPress = frames end

local function pack(sections)
  local buf = { "${REPORT_MAGIC}", string.char(#sections) }
  for _, s in ipairs(sections) do
    buf[#buf + 1] = string.char(#s[1]) .. s[1] .. u32(#s[2]) .. s[2]
  end
  return table.concat(buf)
end

local function finish(code, status)
  -- the SRAM against the file, before the report lands on top of it; the
  -- ROM rewrites CHECK SUM (0x00-0x1F), CHECK SUM COPY and MOUSE SPEED
  -- (0x7E5A-0x7E7B) at every boot, so those are not held against it
  local diff, first = 0, {}
  for i = 1, #SRAM do
    local a = i - 1
    if a >= 0x20 and not (a >= 0x7E5A and a < 0x7E7C) then
      if rd(a, SAVE) ~= string.byte(SRAM, i) then
        diff = diff + 1
        if #first < 8 then first[#first + 1] = string.format("0x%05x", a) end
      end
    end
  end
  status = status .. ";sramDiff=" .. diff .. ";sramFirst=" .. table.concat(first, " ")
    .. ";magic=" .. dump(SAVE, 0x7FF8, 8) .. ";frames=" .. frames .. ";code=" .. code
  local sections = { { "status", status } }
  for _, s in ipairs(shots) do sections[#sections + 1] = s end
  local played = (phase == "done")
  if played then
    sections[#sections + 1] = { "cgram", dump(CGRAM, 0, 0x200) }
    sections[#sections + 1] = { "wram", dump(WRAM, 0, 0x800) }
    sections[#sections + 1] = { "vram", dump(VRAM, 0, 0x10000) }
  end
  local blob = pack(sections)
  if #blob > #SRAM and played then
    sections[#sections] = nil -- drop VRAM, the one section that can tip it over
    blob = pack(sections)
  end
  if #blob > #SRAM then emu.stop(${EXIT.reportTooBig}) return end
  for i = 1, #blob do emu.write(i - 1, string.byte(blob, i), SAVE) end
  emu.stop(code)
end

emu.addEventCallback(function()
  if hold > 0 then
    emu.setInput({ start = true }, 0)
    hold = hold - 1
  else
    emu.setInput({ start = false }, 0)
  end
end, emu.eventType.inputPolled)

emu.addEventCallback(function()
  frames = frames + 1
  if phase == "boot" then
    for i = 1, #SRAM do emu.write(i - 1, string.byte(SRAM, i), SAVE) end
    phase = "menu"; frames = 0; phaseAt = 0
    emu.reset()
  elseif phase == "menu" then
    -- a screen is photographed a settle after it is recognised, once its
    -- fade-in (or the title's fly-in) is over, and only then answered
    if seenAt < 0 and isMenu() then
      seenAt = frames
    elseif seenAt >= 0 and frames - seenAt >= SETTLE_MENU then
      shot("menu"); press(); phase = "title"; phaseAt = frames; seenAt = -1
    elseif frames - phaseAt > MENU_FRAMES then
      shot("stuck"); finish(${EXIT.noMenu}, "phase=menu;reached=no")
    end
  elseif phase == "title" then
    if seenAt < 0 and frames - lastPress > 20 and isTitle() then
      seenAt = frames
    elseif seenAt >= 0 and frames - seenAt >= SETTLE_TITLE then
      shot("title"); press(); phase = "play"; phaseAt = frames; seenAt = -1
    elseif frames - phaseAt > STEP_FRAMES then
      shot("stuck"); finish(${EXIT.noTitle}, "phase=title;reached=no")
    elseif frames - lastPress > 120 and isMenu() then
      press()
    end
  elseif phase == "play" then
    if isPlay() then
      phase = "playing"; phaseAt = frames
    elseif frames - phaseAt > STEP_FRAMES then
      shot("stuck"); finish(${EXIT.noPlay}, "phase=play;reached=no")
    elseif frames - lastPress > 120 and isTitle() then
      press()
    end
  elseif phase == "playing" then
    if frames - phaseAt >= PLAY_FRAMES then
      shot("play"); phase = "done"
      finish(${EXIT.ok}, "phase=done;reached=yes")
    end
  end
end, emu.eventType.endFrame)
`;
}

/** ─── the report ────────────────────────────────────────────────────────── */

export interface Report {
  status: Record<string, string>;
  shots: Record<string, Uint8Array>;
  cgram: Uint8Array | null;
  wram: Uint8Array | null;
  vram: Uint8Array | null;
}

/** What `pack` wrote, for tests and for symmetry with the Lua. */
export function encodeReport(
  sections: [string, Uint8Array][],
): Uint8Array {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [
    enc.encode(REPORT_MAGIC),
    new Uint8Array([sections.length]),
  ];
  for (const [name, data] of sections) {
    const n = enc.encode(name);
    const len = new Uint8Array(4);
    new DataView(len.buffer).setUint32(0, data.length, true);
    parts.push(new Uint8Array([n.length]), n, len, data);
  }
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** The battery Mesen wrote, as the script's sections; null when it holds no report. */
export function decodeReport(bytes: Uint8Array): Report | null {
  const dec = new TextDecoder();
  if (
    bytes.length < REPORT_MAGIC.length + 1 ||
    dec.decode(bytes.subarray(0, REPORT_MAGIC.length)) !== REPORT_MAGIC
  ) return null;
  let at = REPORT_MAGIC.length;
  const count = bytes[at++];
  const report: Report = {
    status: {},
    shots: {},
    cgram: null,
    wram: null,
    vram: null,
  };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < count; i++) {
    const nameLen = bytes[at++];
    const name = dec.decode(bytes.subarray(at, at + nameLen));
    at += nameLen;
    const len = view.getUint32(at, true);
    at += 4;
    const data = bytes.slice(at, at + len);
    at += len;
    if (name === "status") {
      for (const kv of dec.decode(data).split(";")) {
        const eq = kv.indexOf("=");
        if (eq > 0) report.status[kv.slice(0, eq)] = kv.slice(eq + 1);
      }
    } else if (name.startsWith("png:")) report.shots[name.slice(4)] = data;
    else if (name === "cgram") report.cgram = data;
    else if (name === "wram") report.wram = data;
    else if (name === "vram") report.vram = data;
  }
  return report;
}

/** ─── the verdict ───────────────────────────────────────────────────────── */

/** CGRAM palette n's colours 1..15 against a save row's words 0..14. */
export function cgramRowMatches(
  cgram: Uint8Array,
  palette: number,
  row: Uint16Array,
): boolean {
  for (let i = 0; i < 15; i++) {
    const at = palette * 32 + (i + 1) * 2;
    const live = cgram[at] | (cgram[at + 1] << 8);
    if ((live & 0x7fff) !== (row[i] & 0x7fff)) return false;
  }
  return true;
}

const TILE_BYTES = 32;

function tileKey(bytes: Uint8Array, at: number): string {
  let s = "";
  for (let i = 0; i < TILE_BYTES; i++) s += String.fromCharCode(bytes[at + i]);
  return s;
}

/** The distinct non-blank 8x8 tiles in a byte range, as keys. */
export function tileSet(
  bytes: Uint8Array,
  from: number,
  length: number,
): Set<string> {
  const blank = tileKey(new Uint8Array(TILE_BYTES), 0);
  const out = new Set<string>();
  for (let at = from; at + TILE_BYTES <= from + length; at += TILE_BYTES) {
    const k = tileKey(bytes, at);
    if (k !== blank) out.add(k);
  }
  return out;
}

/** How many of VRAM's tiles come from the save's sheets, and how many from the ROM's factory sheets. */
export function vramTileOrigins(
  vram: Uint8Array,
  sram: Uint8Array,
  rom: Uint8Array | null,
): { total: number; fromSave: number; fromFactory: number; saveTiles: number } {
  const save = tileSet(sram, REGION.graphics.offset, REGION.graphics.length);
  const factory = rom
    ? tileSet(rom, romFactoryArtOffset(rom), 0x10000)
    : new Set<string>();
  const blank = tileKey(new Uint8Array(TILE_BYTES), 0);
  let total = 0, fromSave = 0, fromFactory = 0;
  for (let at = 0; at + TILE_BYTES <= vram.length; at += TILE_BYTES) {
    const k = tileKey(vram, at);
    if (k === blank) continue;
    total++;
    if (save.has(k)) fromSave++;
    if (factory.has(k)) fromFactory++;
  }
  return { total, fromSave, fromFactory, saveTiles: save.size };
}

/** The ROM's sheets 2 and 3 — the factory art — start at 0x40000 past any copier header. */
function romFactoryArtOffset(rom: Uint8Array): number {
  return (rom.length % 0x8000 === 512 ? 512 : 0) + 0x40000;
}

/** Distinct colours in a screenshot: 1 is a blank screen. */
export async function screenColours(png: Uint8Array): Promise<number> {
  const raster = await decodePng(new Uint8Array(png));
  const seen = new Set<number>();
  const d = raster.data;
  for (let i = 0; i < d.length; i += 4) {
    seen.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
  }
  return seen.size;
}

export interface Verdict {
  ok: boolean;
  findings: Finding[];
}

/**
 * The live findings: what the run reached, whether the ROM kept the save,
 * and whether what is on screen is this save's data rather than the
 * factory's. `rom` lets the factory's rows and tiles be told from the
 * save's; without it a match is reported but not weighed.
 */
export async function liveFindings(
  sram: Uint8Array,
  rom: Uint8Array | null,
  report: Report | null,
  exitCode: number | null,
): Promise<Verdict> {
  const findings: Finding[] = [];
  const f = (level: Finding["level"], check: string, detail: string) =>
    findings.push({ level, check, detail });

  if (!report) {
    f(
      "fail",
      "run",
      exitCode === EXIT.reportTooBig
        ? "the script's report did not fit the 128 KB battery"
        : `Mesen stopped with exit ${exitCode} and wrote no report`,
    );
    return { ok: false, findings };
  }
  const st = report.status;
  const frames = Number(st.frames ?? 0);
  switch (exitCode) {
    case EXIT.ok:
      f(
        "pass",
        "run",
        `main menu, title and play reached; ${frames} frames after reset`,
      );
      break;
    case EXIT.noMenu:
      f(
        "fail",
        "run",
        `the main menu never appeared (${frames} frames after reset) — see stuck.png; a CHECK SUM or S-RAM message waits for a button`,
      );
      break;
    case EXIT.noTitle:
      f(
        "fail",
        "run",
        `GAME PLAY did not reach the game's title (${frames} frames) — see stuck.png`,
      );
      break;
    case EXIT.noPlay:
      f(
        "fail",
        "run",
        `GAME START did not begin a stage (${frames} frames) — see stuck.png`,
      );
      break;
    default:
      f("fail", "run", `Mesen stopped with exit ${exitCode}`);
  }

  // The cart after boot.
  const diff = Number(st.sramDiff ?? -1);
  if (st.magic !== "T.TABATA") {
    f("fail", "sram", `after boot the magic reads ${JSON.stringify(st.magic)}`);
  } else if (diff === 0) {
    f(
      "pass",
      "sram",
      "the ROM kept the save byte for byte (checksum block and MOUSE SPEED aside)",
    );
  } else if (diff > 0) {
    const factory = rom
      ? (() => {
        // A formatted cart's first 64 KB is the ROM's default image; the
        // report cannot show the live SRAM, but a rewrite this large with
        // the magic intact is that.
        return diff > 0x4000
          ? " — a rewrite of that size is the ROM formatting the cart back to the factory sample"
          : "";
      })()
      : "";
    f(
      diff > 0x100 ? "fail" : "warn",
      "sram",
      `the ROM rewrote ${diff} bytes of the save (first at ${st.sramFirst})${factory}`,
    );
  }

  if (exitCode !== EXIT.ok) return { ok: false, findings };

  // Palettes: stage 0's rows in CGRAM.
  const parsed = parseSfcSav(sram);
  const factoryRows = rom
    ? parseSfcSav(romDefaultImage(rom)).palettes?.rows
    : null;
  if (report.cgram && parsed.palettes) {
    const rows = parsed.palettes.rows;
    const checks: [string, number, number][] = [
      ["scenery (BG palette 7 ← row 0)", 7, 0],
      ["boss (BG palette 6 ← row 12)", 6, 12],
      ["enemies (OBJ palette 4 ← row 6)", 12, 6],
      ["ship (OBJ palette 7 ← row 18)", 15, 18],
    ];
    for (const [what, pal, row] of checks) {
      const live = cgramRowMatches(report.cgram, pal, rows[row].raw);
      const sameAsFactory = factoryRows
        ? rows[row].raw.every((w: number, i: number) =>
          i === 15 || (w & 0x7fff) === (factoryRows[row].raw[i] & 0x7fff)
        )
        : false;
      if (live && sameAsFactory) {
        f(
          "warn",
          "palette",
          `${what} matches, but the save's row is the factory's too, so this tells the two apart no further`,
        );
      } else if (live) f("pass", "palette", `${what} is on the console`);
      else {
        const factoryLive = factoryRows
          ? cgramRowMatches(report.cgram, pal, factoryRows[row].raw)
          : false;
        f(
          "fail",
          "palette",
          `${what} is not in CGRAM${
            factoryLive
              ? " — the factory's row is: the sample game is playing"
              : ""
          }`,
        );
      }
    }
  }

  // Tiles: the save's own art in VRAM.
  if (report.vram) {
    const o = vramTileOrigins(report.vram, sram, rom);
    if (o.saveTiles === 0) {
      f(
        "warn",
        "tiles",
        `the save has no tiles of its own; VRAM holds ${o.total} (${o.fromFactory} factory)`,
      );
    } else if (o.fromSave > 0) {
      f(
        "pass",
        "tiles",
        `${o.fromSave} of VRAM's ${o.total} tiles are the save's own (${o.fromFactory} the factory's)`,
      );
    } else {
      f(
        "fail",
        "tiles",
        `none of VRAM's ${o.total} tiles come from the save's ${o.saveTiles} (${o.fromFactory} are the factory's)`,
      );
    }
  }

  // The screen.
  if (report.shots.play) {
    const colours = await screenColours(report.shots.play);
    if (colours <= 2) {
      f(
        "warn",
        "screen",
        `the play screenshot has ${colours} colour${colours === 1 ? "" : "s"}`,
      );
    } else f("pass", "screen", `the play screenshot has ${colours} colours`);
  }

  return { ok: !findings.some((x) => x.level === "fail"), findings };
}

export function formatFindings(findings: Finding[]): string {
  const mark = { pass: "ok  ", warn: "warn", fail: "FAIL" };
  return findings.map((x) =>
    `  ${mark[x.level]}  ${x.check.padEnd(9)} ${x.detail}`
  ).join("\n");
}
