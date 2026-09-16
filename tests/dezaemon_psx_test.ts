// lib/dezaemon-psx.ts, routes/api/dezaemon-psx.ts and static/psx-library.js:
// finding the PlayStation Dezaemons in dev-fixtures/, describing them, and
// turning one into the zip the browser's PSX player boots.
//
// The discs and the memory cards are community content and never in the repo,
// so almost everything here runs against a disc this repo's own ISO 9660
// writer builds and mode2form1() then rewraps into 2352-byte Mode 2 Form 1
// frames. That geometry is what every real PlayStation rip has and it is the
// one entry of iso9660-read.js's GEOMETRIES table that buildIso cannot reach
// on its own — packages/shmup-harbor/lib/ps2/iso9660.ts:11 writes 2048-byte
// cooked sectors and nothing else — so without the rewrap the whole suite
// would exercise a branch no user's disc ever takes. The cards come from the
// engine's own synthetic builders. The real fixtures, when a checkout has
// them, get their own two tests at the end, skipped otherwise.
//
// It also holds the MIRRORED COPIES equal, because static/ is plain browser
// ESM and cannot reach a .ts module: the launcher's title, the two content
// names and the player's BIOS path exist twice on purpose. Six files that
// cannot import each other have to agree — lib/dezaemon-psx.ts,
// static/psx-library.js, static/emulators.json, static/emu-sw.js,
// svelte-src/Dashboard.svelte and packages/shmup-engine/src/psx/index.js —
// and a drift in any of them is a section that renders the wrong name, boots
// nothing, or orphans a memory card that was filed under the old one.
//
// The two message strings are the exception. "psx-byod-ready" and
// "psx-byod-file" belong to https://cmg.easierbycode.deno.net/psx/play.html,
// a page on another origin that nothing in CI can fetch, so they are pinned
// here as literals: that records what the launcher says, it does not verify
// that the player answers to it. The same goes for that page's hardcoded
// EJS_biosUrl — PSX_PLAYER_BIOS restates it, and all that is asserted is that
// the constant and the caveat built from it exist.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
import { buildIso } from "@shmupx/shmup-harbor/iso9660";
import { crc32 } from "@shmupx/shmup-harbor/zip";
import { unzip } from "../static/zip-read.js";
import {
  candidatesKey,
  dezaemonGeometry,
  findDezaemonDiscs,
  parseCueFiles,
  trackModeFor,
} from "../lib/dezaemon-disc.ts";
import {
  detectPsxCards,
  detectPsxDiscs,
  DEZAEMON_PSX_TITLE,
  findPsxCards,
  findPsxDisc,
  findPsxDiscs,
  identifyPsxDisc,
  parsePsxBootCode,
  PSX_CONTENT_NAMES as PSX_CONTENT_NAMES_TS,
  PSX_DISC_CODES,
  PSX_PLAYER_BIOS as PSX_PLAYER_BIOS_TS,
  psxCardCandidates,
  type PsxDisc,
  psxDiscCandidates,
  psxDiscZipEtag,
  psxDiscZipLength,
  psxDiscZipStream,
  type PsxGameId,
  psxZipEntries,
  readDiscPrefix,
  repoRoot,
} from "../lib/dezaemon-psx.ts";
import {
  findPsxDiscs as browserFindPsxDiscs,
  PSX_BYOD_FILE,
  PSX_BYOD_PLAYER,
  PSX_BYOD_READY,
  PSX_CONTENT_NAMES,
  PSX_CORE_ID,
  PSX_GAME_TITLES,
  PSX_PLAYER_BIOS,
  PSX_TITLE,
  psxBiosCaveat,
  psxCardsByGame,
} from "../static/psx-library.js";
import { handler } from "../routes/api/dezaemon-psx.ts";
import {
  KIDS_PRODUCT,
  PLUS_PRODUCT,
  PSX_GAMES,
} from "../packages/shmup-engine/src/psx/index.js";
import {
  buildCard,
  buildKidsBlock,
  buildPlusBlock,
  SJIS,
} from "../packages/shmup-engine/test/_psx-synthetic.js";

// deno-lint-ignore no-explicit-any
type Any = any;
type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const repo = (p: string) => new URL(`../${p}`, import.meta.url);
const read = (p: string) => Deno.readTextFile(repo(p));

// ── Building a disc a PlayStation would recognise ────────────────────────────

const COOKED_SECTOR = 2048;
const RAW_SECTOR = 2352;
/** Where Mode 2 Form 1 puts the 2048 bytes of user data inside its frame. */
const USER_AT = 24;

const bcd = (n: number) => ((Math.floor(n / 10) << 4) | (n % 10)) & 0xff;

/**
 * buildIso()'s cooked 2048-byte sectors, rewrapped as 2352-byte Mode 2 Form 1
 * frames: the twelve-byte sync pattern 00 FF*10 00, the BCD minute/second/
 * frame address and the mode byte 0x02, then the eight-byte subheader twice
 * (the form-1 data-sector coding, 00 00 08 00), then the user data at +24.
 *
 * The EDC/ECC tail is left zero. Nothing reads it here: openDisc() decides a
 * geometry purely by finding "CD001" and a type-1 descriptor at LBA 16
 * (iso9660-read.js:34-42), and correct ECC would mean carrying a Reed-Solomon
 * encoder into a test that is about which Dezaemon a disc is.
 */
function mode2form1(cooked: Uint8Array): Uint8Array {
  const sectors = Math.ceil(cooked.length / COOKED_SECTOR);
  const out = new Uint8Array(sectors * RAW_SECTOR);
  for (let lba = 0; lba < sectors; lba++) {
    const at = lba * RAW_SECTOR;
    out.fill(0xff, at + 1, at + 11);
    const abs = lba + 150; // the address is absolute, and track 1 starts at 2s
    out[at + 12] = bcd(Math.floor(abs / 4500));
    out[at + 13] = bcd(Math.floor(abs / 75) % 60);
    out[at + 14] = bcd(abs % 75);
    out[at + 15] = 0x02;
    out[at + 18] = 0x08;
    out[at + 22] = 0x08;
    out.set(
      cooked.subarray(lba * COOKED_SECTOR, (lba + 1) * COOKED_SECTOR),
      at + USER_AT,
    );
  }
  return out;
}

interface IsoFile {
  path: string;
  data: Uint8Array;
}

/** An ISO 9660 volume, raw by default because that is how discs arrive. */
function discImage(
  files: IsoFile[],
  { cooked = false }: { cooked?: boolean } = {},
): Uint8Array {
  const iso = buildIso({
    volumeId: "DEZAEMON",
    files,
    date: new Date("2000-03-04T00:00:00Z"),
  });
  return cooked ? iso : mode2form1(iso);
}

/** The root entries each game is identified by when SYSTEM.CNF is unreadable.
 * Dezaemon+'s UPLOAD is a directory, which is the whole reason the PSX module
 * cannot reuse dezaemonGeometry's marker loop (it rejects directories). */
const MARKERS: Record<PsxGameId, string[]> = {
  kids: ["KIDS.EXE", "KIDS_DAT.BIN"],
  plus: ["MAIN.EXE", "UPLOAD/SAMP0.BIN"],
};

/** How each disc spells its own boot name — with the underscore and dot the
 * BIOS grammar allows, which is not how the product code is written. */
const BOOT_CODES: Record<PsxGameId, string> = {
  kids: "SLPS_015.03",
  plus: "SLPS_003.35",
};

/**
 * A PlayStation Dezaemon as a rip holds one: a SYSTEM.CNF whose BOOT line
 * names `code`, plus the game's root markers. `pad` appends a filler file
 * that sorts after every one of them (buildIso lays file data out in the
 * directory's sorted order, iso9660.ts:284-290), so an image can be made far
 * longer than a prefix read without moving SYSTEM.CNF out of that prefix.
 */
function psxImage(
  {
    game = "kids",
    code = BOOT_CODES[game],
    markersOnly = false,
    cooked = false,
    pad = 0,
  }: {
    game?: PsxGameId;
    code?: string;
    markersOnly?: boolean;
    cooked?: boolean;
    pad?: number;
  } = {},
): Uint8Array {
  const files: IsoFile[] = MARKERS[game].map((path) => ({
    path,
    data: encoder.encode(`${game}:${path}`),
  }));
  if (!markersOnly) {
    files.push({
      path: "SYSTEM.CNF",
      data: encoder.encode(
        `BOOT = cdrom:\\${code};1\r\n` +
          "TCB = 4\r\nEVENT = 10\r\nSTACK = 801FFFF0\r\n",
      ),
    });
  }
  if (pad) {
    files.push({
      path: "ZZFILL.BIN",
      data: new Uint8Array(pad * COOKED_SECTOR),
    });
  }
  return discImage(files, { cooked });
}

/** The decoy that actually turns up in dev-fixtures/: a Dezaemon 2 disc. */
function saturnImage(): Uint8Array {
  return discImage([
    { path: "GAME.CMP", data: encoder.encode("game") },
    { path: "DEZA2.PAL", data: new Uint8Array(576) },
  ], { cooked: true });
}

/**
 * A temporary checkout: <root>/dev-fixtures/ with the given files. A key may
 * name subdirectories, because the card walk descends into them and the
 * collection keeps a folder per game and sometimes one per contributor.
 */
async function tree(files: Record<string, Uint8Array | string>) {
  const root = await Deno.makeTempDir({ prefix: "deza-psx-" });
  const fixtures = join(root, "dev-fixtures");
  await Deno.mkdir(fixtures);
  for (const [name, data] of Object.entries(files)) {
    const path = join(fixtures, name);
    await Deno.mkdir(dirname(path), { recursive: true });
    await Deno.writeFile(
      path,
      typeof data === "string" ? encoder.encode(data) : data,
    );
  }
  return { root, fixtures, done: () => Deno.remove(root, { recursive: true }) };
}

/** The zip's bytes, read the way the route's response body is read. */
async function streamed(disc: PsxDisc): Promise<Uint8Array> {
  return new Uint8Array(
    await new Response(psxDiscZipStream(disc)).arrayBuffer(),
  );
}

function jsonFetch(routes: Record<string, unknown>): Fetch {
  return (url) => {
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (key === undefined) {
      return Promise.resolve(new Response("no", { status: 404 }));
    }
    return Promise.resolve(
      new Response(JSON.stringify(routes[key]), {
        headers: { "content-type": "application/json" },
      }),
    );
  };
}

// The handler only ever reads ctx.req, so that is the whole fixture. Narrowing
// it here rather than building a Fresh context keeps the test about the answer.
const route = handler as unknown as {
  GET(ctx: { req: Request }): Response | Promise<Response>;
};
const get = (query = "", init?: RequestInit): Promise<Response> =>
  Promise.resolve(
    route.GET({
      req: new Request(`http://127.0.0.1:8787/api/dezaemon-psx${query}`, init),
    }),
  );

/**
 * Run `fn` with $DEZAEMON_PSX_DISC naming `path`. The delete is not tidiness:
 * `deno test` runs this whole file in one process, so a variable left set
 * changes what every later test — in this file and the next — is looking at.
 */
async function withExtraDisc<T>(
  path: string,
  fn: () => Promise<T>,
): Promise<T> {
  Deno.env.set("DEZAEMON_PSX_DISC", path);
  try {
    return await fn();
  } finally {
    Deno.env.delete("DEZAEMON_PSX_DISC");
  }
}

// ── Disc identification ──────────────────────────────────────────────────────

Deno.test("a MODE2/2352 PlayStation image is read, and its SYSTEM.CNF says which Dezaemon it is", () => {
  assertEquals(identifyPsxDisc(psxImage({ game: "kids" })), {
    game: "kids",
    code: "SLPS-01503",
    codeFrom: "system.cnf",
    region: "JP",
    sectorSize: 2352,
    dataOffset: 24,
  });
  // The same volume as a cooked .iso, which is what this repo's writer emits
  // and what a rip of the data track alone would look like.
  assertEquals(identifyPsxDisc(psxImage({ game: "kids", cooked: true })), {
    game: "kids",
    code: "SLPS-01503",
    codeFrom: "system.cnf",
    region: "JP",
    sectorSize: 2048,
    dataOffset: 0,
  });
});

Deno.test("a boot line is read through an underscore, a dot, cdrom0:, a forward slash and CRLF", () => {
  // dev-fixtures/debug-tools/README.md:114-115 spells one of these two boot
  // names with an underscore and the other without, in the same sentence.
  // Real SYSTEM.CNFs vary the same way, so every separator is optional.
  const table: [string, string | null][] = [
    ["BOOT = cdrom:\\SLPS_015.03;1\r\n", "SLPS-01503"],
    ["BOOT=cdrom0:\\SLPS015.03;1", "SLPS-01503"],
    ["BOOT = cdrom:/SLPS_003.35;1", "SLPS-00335"],
    ["BOOT = cdrom0:\\SLPS_015.04;1\r\n", "SLPS-01504"],
    // The line is rarely the first one in the file.
    ["TCB = 4\r\nEVENT = 10\r\nBOOT = cdrom:\\SLPS_015.03;1\r\n", "SLPS-01503"],
    ["BOOT = cdrom:\\PSX.EXE;1", null],
    ["", null],
  ];
  for (const [text, want] of table) {
    assertEquals(parsePsxBootCode(text), want, JSON.stringify(text));
  }
});

Deno.test("Select 100 is a Dezaemon+ disc that says SLPS-01504, not SLPS-00335", async () => {
  const t = await tree({
    "Dezaemon Plus Select 100 (Japan).bin": psxImage({
      game: "plus",
      code: "SLPS_015.04",
    }),
  });
  try {
    const [disc] = await findPsxDiscs(t.root, { cache: false });
    assert(disc, "the Select 100 re-release was not recognised at all");
    assertEquals(disc.game, "plus");
    assertEquals(
      disc.code,
      "SLPS-01504",
      "the row must not claim SLPS-00335 when the disc is the re-release",
    );
    assertEquals(disc.id, "slps-01504");
    assertEquals(disc.codeFrom, "system.cnf");
    assertEquals(disc.region, "JP");
    // Same game, so the same save file and the same content name: the two
    // discs differ in their code and in nothing the player is handed.
    assertEquals(disc.title, PSX_GAMES.plus.title);
    assertEquals(disc.content, "Dezaemon Plus");
  } finally {
    await t.done();
  }
});

Deno.test("a disc with no readable SYSTEM.CNF falls back to its root markers", () => {
  assertEquals(identifyPsxDisc(psxImage({ game: "kids", markersOnly: true })), {
    game: "kids",
    code: "SLPS-01503",
    codeFrom: "markers",
    region: "JP",
    sectorSize: 2352,
    dataOffset: 24,
  });
  assertEquals(identifyPsxDisc(psxImage({ game: "plus", markersOnly: true })), {
    game: "plus",
    code: "SLPS-00335",
    codeFrom: "markers",
    region: "JP",
    sectorSize: 2352,
    dataOffset: 24,
  });
});

Deno.test("MAIN.EXE alone is not Dezaemon+, and UPLOAD has to be a directory", () => {
  const main: IsoFile = { path: "MAIN.EXE", data: encoder.encode("exe") };
  // MAIN.EXE is a generic PlayStation executable name shared with dozens of
  // unrelated games, so on its own it identifies nothing.
  assertEquals(identifyPsxDisc(discImage([main])), null);
  // And a FILE called UPLOAD is not the UPLOAD directory the game writes its
  // uploads into. This is the case a copy of dezaemonGeometry gets wrong from
  // the other side: that loop rejects any directory outright
  // (lib/dezaemon-disc.ts:131), so it would miss the real disc entirely.
  assertEquals(
    identifyPsxDisc(
      discImage([main, { path: "UPLOAD", data: encoder.encode("not a dir") }]),
    ),
    null,
  );
  assertEquals(
    identifyPsxDisc(
      discImage([main, { path: "UPLOAD/SAMP0.BIN", data: new Uint8Array(4) }]),
    )?.game,
    "plus",
  );
});

Deno.test("a Dezaemon 2 disc is not a PlayStation disc, and a PlayStation disc is not Dezaemon 2", async () => {
  assertEquals(identifyPsxDisc(saturnImage()), null);
  assertEquals(dezaemonGeometry(psxImage({ game: "kids" })), null);
  // A disc whose SYSTEM.CNF parses to some other game is refused there rather
  // than falling through to the markers: MAIN.EXE and an UPLOAD directory
  // would otherwise let an unrelated SLUS title in through the back door.
  assertEquals(
    identifyPsxDisc(
      discImage([
        { path: "MAIN.EXE", data: encoder.encode("exe") },
        { path: "UPLOAD/SAMP0.BIN", data: new Uint8Array(4) },
        {
          path: "SYSTEM.CNF",
          data: encoder.encode("BOOT = cdrom:\\SLUS_005.94;1\r\n"),
        },
      ]),
    ),
    null,
  );

  const t = await tree({
    "kids.bin": psxImage({ game: "kids" }),
    "deza2.iso": saturnImage(),
  });
  try {
    const psx = await findPsxDiscs(t.root, { cache: false });
    assertEquals(psx.map((d) => d.id), ["slps-01503"]);
    assertEquals(psx[0].files.map((f) => f.name), ["kids.bin"]);
    const saturn = await findDezaemonDiscs(t.root, { cache: false });
    assertEquals(saturn.length, 1);
    assertEquals(saturn[0].files.map((f) => f.name), ["deza2.iso"]);
  } finally {
    await t.done();
  }
});

Deno.test("a 150-sector pregap hides the volume, and that is a miss rather than a throw", () => {
  // A dump that keeps track 1's pregap puts the PVD at LBA 166, and every
  // geometry openDisc knows looks at LBA 16. It returns null with no error,
  // so the route's NOT_HERE string is the only place a user learns why.
  const image = psxImage({ game: "kids" });
  const withPregap = new Uint8Array(150 * RAW_SECTOR + image.length);
  withPregap.set(image, 150 * RAW_SECTOR);
  assertEquals(identifyPsxDisc(withPregap), null);
});

Deno.test("detection reads a prefix, not the image", async () => {
  // A real MODE2/2352 rip is 300-700 MB and this module exists to not read
  // one whole. 64 sectors is 150 KB of a 529 KB image here, and the PVD, the
  // root directory and SYSTEM.CNF all sit inside it.
  const image = psxImage({ game: "kids", pad: 200 });
  const prefix = image.subarray(0, 64 * RAW_SECTOR);
  assert(prefix.length < image.length, "the prefix must be a prefix");
  assertEquals(identifyPsxDisc(prefix)?.code, "SLPS-01503");

  const t = await tree({ "kids.bin": image });
  try {
    const path = join(t.fixtures, "kids.bin");
    const read64 = await readDiscPrefix(path, 64 * RAW_SECTOR);
    assert(read64);
    assertEquals(read64.length, 64 * RAW_SECTOR);
    assertEquals(identifyPsxDisc(read64)?.code, "SLPS-01503");
    assertEquals(await readDiscPrefix(join(t.fixtures, "gone.bin")), null);
  } finally {
    await t.done();
  }
});

// ── Cue sheets and candidates ────────────────────────────────────────────────

Deno.test("a cue beside the image is used as it is, and claims its image", async () => {
  const cueText = 'FILE "Dezaemon Kids! (Japan).bin" BINARY\r\n' +
    "  TRACK 01 MODE2/2352\r\n    INDEX 01 00:00:00\r\n";
  const t = await tree({
    "Dezaemon Kids! (Japan).bin": psxImage({ game: "kids" }),
    "Dezaemon Kids! (Japan).cue": cueText,
    // A cue whose FILE is missing must be ignored rather than half-used.
    "broken.cue": 'FILE "missing.bin" BINARY\n  TRACK 01 MODE2/2352\n',
  });
  try {
    const discs = await findPsxDiscs(t.root, { cache: false });
    assertEquals(discs.length, 1, "the image must not be listed twice");
    const [disc] = discs;
    assertEquals(disc.cueFrom, "file");
    assertEquals(disc.cuePath, join(t.fixtures, "Dezaemon Kids! (Japan).cue"));
    assertEquals(disc.files.map((f) => f.name), ["Dezaemon Kids! (Japan).bin"]);
    // The zip is flat, so the cue inside it names the tracks by base name.
    assertEquals(parseCueFiles(disc.cue), ["Dezaemon Kids! (Japan).bin"]);
    assertStringIncludes(disc.cue, "MODE2/2352");
  } finally {
    await t.done();
  }
});

Deno.test("a bare image gets a MODE2/2352 cue written for it", async () => {
  const t = await tree({ "x.bin": psxImage({ game: "kids" }) });
  try {
    const [disc] = await findPsxDiscs(t.root, { cache: false });
    assert(disc);
    assertEquals(disc.cueFrom, "generated");
    assertEquals(disc.cuePath, null);
    assertEquals(
      disc.cue,
      'FILE "x.bin" BINARY\n  TRACK 01 MODE2/2352\n    INDEX 01 00:00:00\n',
    );
    // One track, and no way to know whether there were others: a rip whose
    // BGM is Red Book audio boots silent. cueFrom is how the row says so.
    assertEquals(parseCueFiles(disc.cue).length, 1);
  } finally {
    await t.done();
  }
});

Deno.test("an explicit extra path (the $DEZAEMON_PSX_DISC hook) is a candidate too", async () => {
  const t = await tree({});
  const elsewhere = await Deno.makeTempDir({ prefix: "deza-psx-elsewhere-" });
  try {
    const image = join(elsewhere, "Dezaemon Kids!.bin");
    await Deno.writeFile(image, psxImage({ game: "kids" }));
    assertEquals(await findPsxDiscs(t.root, { cache: false }), []);
    const discs = await findPsxDiscs(t.root, {
      extra: [image],
      cache: false,
    });
    assertEquals(discs.length, 1);
    assertEquals(discs[0].files[0].path, image);
    assertEquals(discs[0].id, "slps-01503");
    // One disc by id, which is what the bytes branch of the route looks up.
    const one = await findPsxDisc(t.root, "slps-01503", {
      extra: [image],
      cache: false,
    });
    assertEquals(one?.files[0].path, image);
    assertEquals(
      await findPsxDisc(t.root, "slps-00335", { extra: [image], cache: false }),
      null,
    );
  } finally {
    await t.done();
    await Deno.remove(elsewhere, { recursive: true });
  }
});

Deno.test("two discs are found, each keyed by its own product code", async () => {
  const t = await tree({
    "Dezaemon Kids! (Japan).bin": psxImage({ game: "kids" }),
    "Dezaemon Plus Select 100 (Japan).bin": psxImage({
      game: "plus",
      code: "SLPS_015.04",
    }),
  });
  try {
    // The memo-free pair, which is what findPsxDiscs runs when its key moves.
    const discs = await detectPsxDiscs(await psxDiscCandidates(t.root));
    assertEquals(discs.map((d) => d.id), ["slps-01503", "slps-01504"]);
    assertEquals(discs.map((d) => d.game), ["kids", "plus"]);
    assertEquals(discs[0].files.map((f) => f.name), [
      "Dezaemon Kids! (Japan).bin",
    ]);
    assertEquals(discs[1].files.map((f) => f.name), [
      "Dezaemon Plus Select 100 (Japan).bin",
    ]);
    // ?zip=plus could not have told these two apart; ?zip=<code> can, and
    // that is the whole reason the id is the product code.
    assertEquals(
      new Set(discs.map((d) => d.content)).size,
      2,
      "two discs, and neither claiming the other's files",
    );
    assertEquals(
      (await findPsxDiscs(t.root, { cache: false })).map((d) => d.id),
      ["slps-01503", "slps-01504"],
    );
  } finally {
    await t.done();
  }
});

Deno.test("the memo key follows names, sizes and mtimes", async () => {
  const t = await tree({ "kids.bin": psxImage({ game: "kids" }) });
  try {
    const before = candidatesKey(await psxDiscCandidates(t.root));
    assertEquals(candidatesKey(await psxDiscCandidates(t.root)), before);
    await Deno.writeFile(join(t.fixtures, "kids.bin"), saturnImage());
    const after = candidatesKey(await psxDiscCandidates(t.root));
    assert(after !== before, "a rewritten image must change the key");
    // The memoised answer is keyed on that, so it re-detects — and now finds
    // nothing, because the bytes under that name are a Saturn disc.
    assertEquals(await findPsxDiscs(t.root), []);

    // The cards walk its own tree and keep their own memo. Both keys come out
    // of candidatesKey and an empty tree keys to "" either way, which is
    // precisely why they are two variables and not one.
    const cardsBefore = candidatesKey(await psxCardCandidates(t.root));
    assertEquals(cardsBefore, "");
    await Deno.writeFile(
      join(t.fixtures, "one.sav"),
      buildCard(buildKidsBlock().block, KIDS_PRODUCT),
    );
    assert(
      candidatesKey(await psxCardCandidates(t.root)) !== cardsBefore,
      "a new card must change the card key",
    );
  } finally {
    await t.done();
  }
});

Deno.test("{ cache: false } re-reads a rebuilt tree", async () => {
  const t = await tree({
    "one.sav": buildCard(buildKidsBlock().block, KIDS_PRODUCT),
  });
  try {
    assertEquals((await findPsxCards(t.root)).map((c) => c.game), ["kids"]);
    // Same path, same 128 KB, different save: only the mtime moved, and a
    // second-resolution filesystem may not even show that. The route never
    // passes { cache: false }; the tests do, because they rebuild trees
    // faster than a memo keyed on stat data can notice.
    await Deno.writeFile(
      join(t.fixtures, "one.sav"),
      buildCard(buildPlusBlock().block, PLUS_PRODUCT),
    );
    assertEquals(
      (await findPsxCards(t.root, { cache: false })).map((c) => c.game),
      ["plus"],
    );
  } finally {
    await t.done();
  }
});

// ── The zip ──────────────────────────────────────────────────────────────────

Deno.test("the zip holds the cue and the track files, stored", async () => {
  const image = psxImage({ game: "kids" });
  const t = await tree({ "x.bin": image });
  try {
    const disc = (await findPsxDisc(t.root, "slps-01503", { cache: false }))!;
    assert(disc);
    assertEquals(psxZipEntries(disc).map((e) => e.path), [
      "Dezaemon Kids.cue",
      "x.bin",
    ]);
    assertEquals(psxZipEntries(disc)[0].from, null, "the cue is generated");
    assertEquals(psxZipEntries(disc)[1].from, join(t.fixtures, "x.bin"));

    const zip = await streamed(disc);
    const entries = await unzip(zip);
    assertEquals(entries.map((e) => e.path), ["Dezaemon Kids.cue", "x.bin"]);
    assertEquals(decoder.decode(entries[0].data), disc.cue);
    assertEquals(entries[1].data, image);

    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    assertEquals(view.getUint16(8, true), 0, "first entry's method is store");
    // The cue leads, so the CRC in the first local header is the cue's. The
    // image's sits in the second one, at a fixed offset because a stored
    // entry has no data descriptor and no extra field — which is what lets
    // psxDiscZipLength() know the body's length before a byte is read.
    const cue = encoder.encode(disc.cue);
    assertEquals(view.getUint32(14, true), crc32(cue));
    const at = 30 + encoder.encode("Dezaemon Kids.cue").length + cue.length;
    assertEquals(view.getUint16(at + 8, true), 0, "the track is stored too");
    assertEquals(view.getUint32(at + 14, true), crc32(image));
  } finally {
    await t.done();
  }
});

Deno.test("the zip's length is known before a byte is read", async () => {
  const t = await tree({ "x.bin": psxImage({ game: "kids", pad: 8 }) });
  try {
    const disc = (await findPsxDisc(t.root, "slps-01503", { cache: false }))!;
    assert(disc);
    const zip = await streamed(disc);
    assertEquals(
      psxDiscZipLength(disc),
      zip.length,
      "a content-length that disagrees with the body is a truncated disc",
    );
  } finally {
    await t.done();
  }
});

Deno.test("the same disc streams to the same bytes", async () => {
  const t = await tree({ "x.bin": psxImage({ game: "kids" }) });
  try {
    const disc = (await findPsxDisc(t.root, "slps-01503", { cache: false }))!;
    assert(disc);
    assertEquals(await streamed(disc), await streamed(disc));
    // And the tag over those bytes is the same tag, which is what makes the
    // route's 304 honest.
    assertEquals(await psxDiscZipEtag(disc), await psxDiscZipEtag(disc));
  } finally {
    await t.done();
  }
});

Deno.test("a track that could not be read is never remembered as its CRC", async () => {
  // A STORED local header carries the CRC ahead of the data, so the CRC is
  // taken in a pre-pass and memoised against path|size|mtime. A track that has
  // gone missing between the stat and the send is zero-filled to keep the
  // content-length promise — and the CRC of that padding must not be what the
  // memo hands out once the file is back, because the file coming back under
  // the same size and mtime is exactly the case the key cannot tell apart.
  const image = psxImage({ game: "kids" });
  const t = await tree({ "x.bin": image });
  try {
    const disc = (await findPsxDisc(t.root, "slps-01503", { cache: false }))!;
    assert(disc);
    const path = join(t.fixtures, "x.bin");
    const before = await Deno.stat(path);

    await Deno.remove(path);
    const padded = await streamed(disc);
    assertEquals(
      padded.length,
      psxDiscZipLength(disc),
      "a missing track is padded to the length the header promised",
    );

    await Deno.writeFile(path, image);
    await Deno.utime(path, before.atime ?? new Date(0), before.mtime!);

    const zip = await streamed(disc);
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    const at = 30 + encoder.encode("Dezaemon Kids.cue").length +
      encoder.encode(disc.cue).length;
    assertEquals(
      view.getUint32(at + 14, true),
      crc32(image),
      "the padding's CRC outlived the missing file and broke the zip",
    );
    assertEquals((await unzip(zip))[1].data, image);
  } finally {
    await t.done();
  }
});

Deno.test("hanging up before the first byte settles, and leaks nothing", async () => {
  // A hang-up during the CRC pre-pass is the awkward one: that pass has no
  // yield in it, so returning the generator cannot interrupt it and an
  // AbortSignal has to reach inside. What is pinned here is what a test can
  // actually see — the cancel settles, the read that was waiting ends rather
  // than hanging, and no file descriptor is left open (Deno's own leak
  // sanitizer is the assertion; this test failing on a leak IS the point).
  // The abort's other effect — that the read stops early instead of running
  // the disc out — is deliberately NOT asserted: at a size a test can afford,
  // the pre-pass finishes inside the same millisecond as the cancel, so any
  // assertion about it would be a coin toss dressed as a check. It is argued
  // for in psxDiscZipStream's comment instead.
  const t = await tree({ "x.bin": psxImage({ game: "kids", pad: 1600 }) });
  try {
    const disc = (await findPsxDisc(t.root, "slps-01503", { cache: false }))!;
    assert(disc);
    const reader = psxDiscZipStream(disc).getReader();
    const first = reader.read(); // starts the pre-pass; no byte can exist yet
    await reader.cancel();
    assertEquals((await first).done, true, "a cancelled read ends the stream");
    // And the disc is still servable afterwards: a cancel that poisoned the
    // CRC memo would show up in the very next launch, which is this one.
    assertEquals(
      (await unzip(await streamed(disc)))[1].data.length,
      disc.files[0].size,
    );
  } finally {
    await t.done();
  }
});

// ── Memory cards ─────────────────────────────────────────────────────────────

Deno.test("a memory card is found by content and named from its title frame", async () => {
  // buildKidsBlock takes SHIFT-JIS BYTES, not a JS string: the title frame is
  // 64 raw bytes and a JS string would be written as NULs and truncate it.
  const named = buildKidsBlock({ name: [...SJIS.A, ...SJIS.A, ...SJIS.space] });
  const t = await tree({
    "Dezaemon Kids!/01.sav": buildCard(buildKidsBlock().block, KIDS_PRODUCT),
    "Dezaemon Kids!/02.sav": buildCard(named.block, KIDS_PRODUCT),
  });
  try {
    const cards = await findPsxCards(t.root, { cache: false });
    assertEquals(cards.length, 2);
    const one = cards.find((c) => c.from === "Dezaemon Kids!/01.sav")!;
    assert(one, "the card under dev-fixtures/ was not listed");
    assertEquals(one.game, "kids");
    assertEquals(one.title, "デザエモンKids!『A 』");
    // narrow()'d: bracketedName returns the fullwidth "Ａ" the game wrote.
    assertEquals(one.name, "A");
    assertEquals(one.filename, "BISLPS-01503DEZAKIDS");
    assertEquals(one.container, "card");
    assertEquals(one.size, 122880);
    assertEquals(one.fileSize, 131072);
    assertEquals(one.deleted, false);
    // The path is relative to dev-fixtures/ and never a URL.
    assert(!one.from.startsWith("/"), "a row shows a path, not a location");

    const two = cards.find((c) => c.from === "Dezaemon Kids!/02.sav")!;
    assert(two, "the second card was not listed");
    assertEquals(two.name, "AA");
    assertEquals(two.title, "デザエモンKids!『AA 』");
  } finally {
    await t.done();
  }
});

Deno.test("a Dezaemon+ card has no name of its own, and the row is not left blank", async () => {
  const t = await tree({
    "Dezaemon Kids!/01.sav": buildCard(buildKidsBlock().block, KIDS_PRODUCT),
    "Dezaemon+/01.sav": buildCard(buildPlusBlock().block, PLUS_PRODUCT),
  });
  try {
    const cards = await findPsxCards(t.root, { cache: false });
    const plus = cards.find((c) => c.game === "plus")!;
    assert(plus, "the Dezaemon+ card was not listed");
    // Dezaemon+ keeps its game name in the graphics as a drawn logo and
    // nowhere in text (FORMAT-PSX.md:58-61), so there is nothing to narrow.
    assertEquals(plus.name, "");
    assertEquals(plus.title, "デザエモン+");
    assertEquals(plus.filename, "BISLPS-00335DEZA");
    // Which is why the shelf row is composed from the group, not the card:
    // one row per game, counted, with the display title in front of it.
    assertEquals(psxCardsByGame({ cards }), [
      { game: "kids", title: "Dezaemon Kids!", count: 1 },
      { game: "plus", title: "Dezaemon+", count: 1 },
    ]);
    assertEquals(psxCardsByGame(null), []);
  } finally {
    await t.done();
  }
});

Deno.test("a file that is the right size but not a card is not listed", async () => {
  const saturn = new Uint8Array(0x8000);
  encoder.encodeInto("BackUpRam Format", saturn);
  const t = await tree({
    // A formatted-but-empty card's worth of zeros, and a Saturn internal
    // backup: both plausible .sav files, neither a PlayStation memory card.
    "empty.sav": new Uint8Array(131072),
    "saturn.sav": saturn,
    "notes.txt": "not a card",
  });
  try {
    const candidates = await psxCardCandidates(t.root);
    assertEquals(
      candidates.map((f) => f.name),
      ["empty.sav", "saturn.sav"],
      "the extension filter is the cheap pass; locateSaves is the real one",
    );
    // locateSaves answers "unknown" rather than throwing, and an unknown
    // container is a file that is not a card — not an error to report.
    assertEquals(await detectPsxCards(candidates), []);
  } finally {
    await t.done();
  }
});

Deno.test("AppleDouble sidecars and dot-directories are never opened", async () => {
  // The sidecars carry a real card's bytes on purpose: if the walk opened
  // them this would list three cards, not one, and the count on the shelf row
  // would be triple what the collection holds.
  const card = buildCard(buildKidsBlock().block, KIDS_PRODUCT);
  const t = await tree({
    "Dezaemon Kids!/01.sav": card,
    "Dezaemon Kids!/._01.sav": card,
    ".cache/psx-disc/01.sav": card,
  });
  try {
    const cards = await findPsxCards(t.root, { cache: false });
    assertEquals(cards.map((c) => c.from), ["Dezaemon Kids!/01.sav"]);
  } finally {
    await t.done();
  }
});

Deno.test("a card id is stable across a rescan and names no path", async () => {
  const t = await tree({
    "Dezaemon Kids!/01.sav": buildCard(buildKidsBlock().block, KIDS_PRODUCT),
    "Dezaemon+/01.sav": buildCard(buildPlusBlock().block, PLUS_PRODUCT),
  });
  try {
    const a = await findPsxCards(t.root, { cache: false });
    const b = await findPsxCards(t.root, { cache: false });
    assertEquals(a.length, 2);
    assertEquals(a.map((c) => c.id), b.map((c) => c.id));
    assertEquals(new Set(a.map((c) => c.id)).size, 2, "two cards, two ids");
    for (const card of a) {
      // The id is a digest of the absolute path, so it survives a rescan —
      // and carries none of that path anywhere a URL could pick it up.
      assert(/^card-[0-9a-f]{12}$/.test(card.id), `bad card id ${card.id}`);
      assert(!card.id.includes("/"), "an id must name no path");
    }
  } finally {
    await t.done();
  }
});

// ── The route ────────────────────────────────────────────────────────────────

Deno.test("the deploy answers 'local only': 200 for the probe, 404 for the bytes", async () => {
  // deno test runs the whole file in one process, so this variable has to go
  // back the way it was found; leaving it set turns every later local-only
  // route test, in this file and the next, into a deploy test.
  Deno.env.set("DENO_DEPLOYMENT_ID", "x");
  try {
    const probe = await get();
    assertEquals(probe.status, 200);
    assertEquals(await probe.json(), {
      available: false,
      reason: "local only",
      discs: [],
      cards: [],
    });
    const bytes = await get("?zip=slps-01503");
    assertEquals(bytes.status, 404);
    await bytes.body?.cancel();
  } finally {
    Deno.env.delete("DENO_DEPLOYMENT_ID");
  }
});

Deno.test("a cross-site probe is refused", async () => {
  // A bare Request proves nothing: lib/local-guards.ts:36-38 lets a client
  // that sends neither sec-fetch-site nor origin through on purpose, because
  // that is curl and the repo's own scripts, not the CSRF threat model.
  const res = await get("", { headers: { "sec-fetch-site": "cross-site" } });
  assertEquals(res.status, 403);
  assertEquals(await res.json(), { ok: false, error: "cross-site request" });
  const bytes = await get("?zip=slps-01503", {
    headers: { "sec-fetch-site": "cross-site" },
  });
  assertEquals(bytes.status, 403);
  await bytes.body?.cancel();
});

Deno.test("the bytes branch makes the caller name a disc", async () => {
  const elsewhere = await Deno.makeTempDir({ prefix: "deza-psx-route-" });
  const image = join(elsewhere, "kids.bin");
  await Deno.writeFile(image, psxImage({ game: "kids" }));
  try {
    await withExtraDisc(image, async () => {
      const vague = await get("?zip=1");
      assertEquals(vague.status, 400);
      const body = await vague.json();
      assertEquals(body.ok, false);
      // There are two discs in the world and one save file each: picking one
      // silently would boot the wrong game with no way to tell.
      assertStringIncludes(body.error, "?zip=");
      assertStringIncludes(body.error, "slps-01503");

      const missing = await get("?zip=slps-99999");
      assertEquals(missing.status, 404);
      const gone = await missing.json();
      assertEquals(gone.ok, false);
      assertStringIncludes(gone.error, "dev-fixtures/");
      assertStringIncludes(gone.error, "SLPS-01503");
      // The pregap clause: openDisc returns null with no error on a dump that
      // keeps track 1's 150 sectors, so this string is the only place it is
      // ever explained.
      assertStringIncludes(gone.error, "pregap");
    });
  } finally {
    await Deno.remove(elsewhere, { recursive: true });
  }
});

Deno.test("the bytes branch honours if-none-match with a bodyless 304", async () => {
  const elsewhere = await Deno.makeTempDir({ prefix: "deza-psx-etag-" });
  const image = join(elsewhere, "kids.bin");
  await Deno.writeFile(image, psxImage({ game: "kids" }));
  try {
    await withExtraDisc(image, async () => {
      const root = await repoRoot();
      const disc = await findPsxDisc(root, "slps-01503", { extra: [image] });
      assert(disc, "the extra disc was not found by the module either");
      const want = await psxDiscZipEtag(disc);

      const first = await get("?zip=slps-01503");
      assertEquals(first.status, 200);
      assertEquals(first.headers.get("etag"), want);
      assertEquals(first.headers.get("content-type"), "application/zip");
      assertEquals(
        first.headers.get("content-disposition"),
        'attachment; filename="Dezaemon Kids.zip"',
      );
      assertEquals(
        Number(first.headers.get("content-length")),
        psxDiscZipLength(disc),
      );
      await first.body?.cancel();

      // The launcher asks on every PlayStation launch and the body is
      // hundreds of megabytes, so this is the request that matters.
      const again = await get("?zip=slps-01503", {
        headers: { "if-none-match": want },
      });
      assertEquals(again.status, 304);
      assertEquals(again.headers.get("etag"), want);
      assertEquals(again.body, null);
    });
  } finally {
    await Deno.remove(elsewhere, { recursive: true });
  }
});

Deno.test("the availability answer never carries a path or a parsed save", async () => {
  const elsewhere = await Deno.makeTempDir({ prefix: "deza-psx-json-" });
  // SLPS-00335 on purpose. This route reads the real dev-fixtures/, and the
  // two discs this project's collection holds are SLPS-01503 and SLPS-01504
  // (dev-fixtures/debug-tools/README.md:101-103); a disc whose id is already
  // taken is dropped, so an extra coded like one of those would vanish behind
  // the operator's own on a checkout that has them.
  const image = join(elsewhere, "plus.bin");
  await Deno.writeFile(image, psxImage({ game: "plus" }));
  try {
    await withExtraDisc(image, async () => {
      const body = await (await get()).json();
      assertEquals(body.available, true);
      assertEquals(body.title, DEZAEMON_PSX_TITLE);
      const disc = (body.discs as Any[]).find((d) => d.id === "slps-00335");
      assert(disc, "the $DEZAEMON_PSX_DISC hook produced no row");
      assertEquals(disc.game, "plus");
      assertEquals(disc.code, "SLPS-00335");
      assertEquals(disc.content, "Dezaemon Plus");
      assertEquals(disc.zip, "/api/dezaemon-psx?zip=slps-00335");
      assertEquals(disc.bios, "/bios/scph5500.bin");
      assertEquals(disc.playerBios, PSX_PLAYER_BIOS_TS);
      // available is true, so there is nothing to explain.
      assertEquals("reason" in body, false);

      // A track is a name and a size and nothing else — never a path, never
      // bytes. Asserted over every row, because the operator's own discs go
      // through the same serialiser as this one.
      for (const d of body.discs as Any[]) {
        assertEquals(d.id, String(d.code).toLowerCase());
        assertEquals(d.zip, `/api/dezaemon-psx?zip=${d.id}`);
        for (const f of d.files as Any[]) {
          assertEquals(Object.keys(f).sort(), ["name", "size"]);
          assertEquals(typeof f.size, "number");
        }
      }

      // Nothing in the answer says where any of it lives: the operator's
      // directory layout is not the launcher's business, and a path in a
      // JSON body is a path something later joins onto dev-fixtures/.
      const strings: string[] = [];
      const walk = (v: unknown) => {
        if (typeof v === "string") strings.push(v);
        else if (Array.isArray(v)) v.forEach(walk);
        else if (v && typeof v === "object") Object.values(v).forEach(walk);
      };
      walk(body);
      const fixtures = join(await repoRoot(), "dev-fixtures");
      for (const s of strings) {
        assert(!s.includes(elsewhere), `the answer leaks ${elsewhere}`);
        assert(!s.includes(fixtures), `the answer leaks ${fixtures}`);
      }
      // And never a parsed save: save.graphics and save.data are Uint8Arrays,
      // and JSON.stringify turns one into {"0":12,"1":255,...}. The cheap
      // card path never produces one, which is the point of it.
      for (const card of body.cards as Any[]) {
        for (const key of ["data", "graphics", "bytes", "block", "icons"]) {
          assertEquals(key in card, false, `cards[] carries ${key}`);
        }
      }

      // What the launcher renders is exactly this answer: static/ fetches it
      // and hands it on, so anything asserted safe here is what reaches a row.
      const seen = await browserFindPsxDiscs({
        fetchImpl: jsonFetch({ "/api/dezaemon-psx": body }),
      });
      assertEquals(seen, body);
      // ...and a route that is not there is a machine with no discs, not a
      // launcher that throws on its boot path.
      const down = await browserFindPsxDiscs({
        fetchImpl: () => Promise.reject(new Error("connection refused")),
      });
      assertEquals(down.available, false);
      assertEquals(down.discs, []);
      assertEquals(down.cards, []);
      assertStringIncludes(down.reason, "connection refused");
    });
  } finally {
    await Deno.remove(elsewhere, { recursive: true });
  }
});

// ── The copies that cannot import each other ─────────────────────────────────

Deno.test("the two copies of the titles and content names agree", () => {
  // static/ is plain browser ESM and cannot import the .ts constants, so
  // these exist twice on purpose.
  assertEquals(PSX_TITLE, DEZAEMON_PSX_TITLE);
  assertEquals({ ...PSX_CONTENT_NAMES }, { ...PSX_CONTENT_NAMES_TS });
  assertEquals(PSX_PLAYER_BIOS, PSX_PLAYER_BIOS_TS);
  // The cue's base name is what EmulatorJS hands the core, and therefore what
  // names the core's memory-card file. No "!", no "+": a "+" decodes as a
  // space under form decoding and this name reaches a content-disposition and
  // eventually a URL. Changing it after anyone has a save orphans that save.
  assertEquals(PSX_CONTENT_NAMES.kids, "Dezaemon Kids");
  assertEquals(PSX_CONTENT_NAMES.plus, "Dezaemon Plus");
  // The display titles keep both, and come from the engine.
  assertEquals(PSX_GAME_TITLES.kids, PSX_GAMES.kids.title);
  assertEquals(PSX_GAME_TITLES.plus, PSX_GAMES.plus.title);

  // The BIOS caveat, and nothing beyond it. /psx/play.html hardcodes
  // EJS_biosUrl = "/bios/scph5501.bin" (US) and both Dezaemons are Japanese
  // SLPS discs; that page lives on cmg.easierbycode.deno.net and nothing in
  // this repository can change what it asks for, so the row states the
  // mismatch and the launcher passes nothing. All that is checked here is
  // that the constant and the sentence exist.
  assertEquals(PSX_PLAYER_BIOS, "/bios/scph5501.bin");
  assertEquals(
    psxBiosCaveat({ region: "JP", bios: "/bios/scph5500.bin" }),
    "JP disc, US BIOS",
  );
  assertEquals(psxBiosCaveat({ region: "US", bios: PSX_PLAYER_BIOS }), null);
  assertEquals(psxBiosCaveat(null), null);
});

Deno.test("the launcher speaks the strings the player is documented to send", async () => {
  const dashboard = await read("svelte-src/Dashboard.svelte");
  // The launcher imports the names rather than spelling the strings, so a
  // rename in static/psx-library.js cannot leave one half behind.
  assertStringIncludes(dashboard, "PSX_BYOD_READY");
  assertStringIncludes(dashboard, "PSX_BYOD_FILE");
  assertStringIncludes(dashboard, "from '../static/psx-library.js'");

  // The strings themselves belong to /psx/play.html on the cmg origin. CI
  // cannot fetch that page, so unlike tests/snes_player_test.ts — where the
  // player is ours and lives under static/ — there is nothing to read them
  // out of. They are pinned here as the literals the brief documents.
  assertEquals(PSX_BYOD_READY, "psx-byod-ready");
  assertEquals(PSX_BYOD_FILE, "psx-byod-file");
  assertEquals(PSX_BYOD_PLAYER, "/psx/play.html?byod=1");
  // And no bios parameter on it. The only BIOS-selection convention in this
  // codebase is params.set('bios', ...) on the ?rom= manifest path; nothing
  // shows the player reads one under ?byod=1, and a parameter that is ignored
  // is worse than none because it looks handled.
  assertEquals(
    new URL(PSX_BYOD_PLAYER, "https://x").searchParams.has("bios"),
    false,
  );
});

Deno.test("/api/dezaemon-psx is outside MIRRORABLE", async () => {
  // Copied from tests/emu_sw_universe_test.ts:19-26 rather than imported:
  // that file is the worker's own contract and editing it is what makes
  // .github/workflows/eshop.yml run on a change that has nothing to do with
  // the eShop.
  const worker = await read("static/emu-sw.js");
  const block = worker.match(/const MIRRORABLE = \[([\s\S]*?)\];/);
  assert(block, "no MIRRORABLE list in static/emu-sw.js");
  const mirrorable = [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  const matchPrefix = (list: string[], pathname: string) =>
    list.some((p) => pathname === p || pathname.startsWith(p));

  // The worker returns before respondWith for anything outside the list, so
  // this route is answered by the server. It has to stay that way: a
  // worker-mediated response is the shape whose .blob() fails on a large
  // body, and this body is a disc image.
  for (
    const path of ["/api/dezaemon-psx", "/api/dezaemon-psx?zip=slps-01503"]
  ) {
    assertEquals(
      matchPrefix(mirrorable, new URL(path, "https://x").pathname),
      false,
      `${path} must not be claimed by MIRRORABLE`,
    );
  }
  // The player and its BIOS are on the other side of that line, and already
  // there — this change adds nothing to the list.
  assertEquals(matchPrefix(mirrorable, "/psx/play.html"), true);
  assertEquals(matchPrefix(mirrorable, "/bios/scph5500.bin"), true);
});

Deno.test("the psx core is mirrored, not local", async () => {
  const catalog = JSON.parse(await read("static/emulators.json"));
  const core = (catalog.cores ?? []).find((c: Any) => c.id === PSX_CORE_ID);
  assert(core, "static/emulators.json lists no psx core");
  // The exact inverse of tests/snes_player_test.ts:51-76, and the reason the
  // launcher's auto-add is guarded by a localStorage opt-out: installing this
  // core registers the service worker and warms ~12 MB, which is not
  // something to do to a machine that only turned out to have a disc.
  assertEquals("local" in core, false);
  assertEquals(core.manifest, "/PlayStation/manifest.json");
  assertEquals(core.prefixes, ["/psx/", "/PlayStation/"]);
  assertEquals(core.player, "/psx/play.html");
  assertEquals(core.title, "PLAYSTATION");
});

// ── The real discs and cards, when this checkout has them ────────────────────

const REPO_ROOT = new URL("../", import.meta.url);

const FIXTURE_CARD_DIRS = ["Dezaemon Kids!/", "Dezaemon+/"] as const;

async function inFixtures(p: string): Promise<boolean> {
  try {
    await Deno.stat(new URL(`dev-fixtures/${p}`, REPO_ROOT));
    return true;
  } catch {
    return false;
  }
}

const haveCardDirs = [
  await inFixtures(FIXTURE_CARD_DIRS[0]),
  await inFixtures(FIXTURE_CARD_DIRS[1]),
];

// Gated on what the detector FINDS, never on a file name — which is the rule
// lib/dezaemon-psx.ts is written to, and this gate used to break it. It named
// two dumps ("Dezaemon Kids! (Japan).bin" and "Dezaemon Plus Select 100
// (Japan).bin") and skipped silently for anything else, so the first real rip
// to land here — a CHD extracted as "Dezaemon Plus (Japan).bin", SLPS-00335,
// neither of those names and neither of those codes — read as "no fixtures"
// and the suite stayed green without testing a single genuine pressing. A gate
// that identifies by name in a feature that identifies by content is the one
// place that mistake costs the most, because its symptom is a skip.
const realDiscs = await findPsxDiscs(fromFileUrl(REPO_ROOT), { cache: false });

Deno.test({
  name:
    "a real PlayStation Dezaemon rip says its own code, and its zip is the length the route promises",
  ignore: realDiscs.length === 0,
  async fn() {
    for (const disc of realDiscs) {
      // Whatever pressing a checkout has, these hold: the three product codes
      // are the only ones the detector accepts, a pressed disc carries a
      // SYSTEM.CNF, and both games are Japanese.
      assert(
        disc.code in PSX_DISC_CODES,
        `${disc.files[0].name} reports ${disc.code}, which is not a Dezaemon`,
      );
      assertEquals(disc.id, disc.code.toLowerCase());
      assertEquals(disc.codeFrom, "system.cnf");
      assertEquals(disc.region, "JP");
      assertEquals(disc.content, PSX_CONTENT_NAMES_TS[disc.game]);

      // The prefix read is the whole point of the module: this file is
      // hundreds of megabytes and detection must never open it.
      const prefix = await readDiscPrefix(disc.files[0].path);
      assert(prefix, `${disc.files[0].name} could not be opened`);
      const seen = identifyPsxDisc(prefix);
      assert(seen, `${disc.files[0].name} was not identified from a prefix`);
      assertEquals(seen.code, disc.code);
      assertEquals(seen.game, disc.game);
      assert(
        trackModeFor(seen),
        `${disc.code}: ${seen.sectorSize}-byte sectors cannot be put in a cue`,
      );
      // A pressed CD ripped to .bin is Mode 2 Form 1. Asserting it here is what
      // checks mode2form1() above against a genuine pressing rather than
      // against my own idea of one; a cooked .iso is the other legal shape and
      // is exempt.
      if (disc.files[0].name.toLowerCase().endsWith(".bin")) {
        assertEquals(
          [seen.sectorSize, seen.dataOffset],
          [2352, 24],
          `${disc.files[0].name} is a .bin rip and should be MODE2/2352`,
        );
      }

      // The content-length the route sends, against the body it then streams.
      // Counted rather than buffered: this disc is half a gigabyte.
      let n = 0;
      for await (const chunk of psxDiscZipStream(disc)) n += chunk.length;
      assertEquals(
        psxDiscZipLength(disc),
        n,
        `${
          disc.files[0].name
        }: a content-length that disagrees is a truncated disc`,
      );
    }
  },
});

Deno.test({
  name: "the dev-fixtures memory cards are read, and every one is named",
  ignore: !haveCardDirs.some(Boolean),
  async fn() {
    const cards = await findPsxCards(fromFileUrl(REPO_ROOT), { cache: false });
    assert(cards.length > 0, "the collection is there but nothing was read");
    const games = ["kids", "plus"] as const;
    for (let i = 0; i < games.length; i++) {
      if (!haveCardDirs[i]) continue;
      assert(
        cards.some((c) => c.game === games[i]),
        `dev-fixtures/${FIXTURE_CARD_DIRS[i]} holds no ${games[i]} card`,
      );
    }
    for (const card of cards) {
      assert(card.title.length > 0, `${card.from} has no title frame`);
      assert(card.size > 0, `${card.from} has an empty save block`);
      assert(!card.from.startsWith("/"), `${card.from} is not relative`);
    }
  },
});
