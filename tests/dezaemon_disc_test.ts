// lib/dezaemon-disc.ts: finding the Dezaemon 2 disc in dev-fixtures/ and
// turning it into the zip the browser's Saturn player boots.
//
// The disc itself is community content and never in the repo, so most of
// this runs against a disc the repo's own ISO 9660 writer builds in a
// temporary tree: a Dezaemon 2 image is recognised by GAME.CMP and DEZA2.PAL
// in its root, and that is a property the writer can reproduce. The real
// fixture — when a checkout has one — gets its own test at the end, skipped
// otherwise. The zip is read back through static/zip-read.js, so the pair of
// writers and the reader agree with each other.

import { assert, assertEquals, assertThrows } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { buildIso } from "../lib/ps2/iso9660.ts";
import {
  buildDezaemonDiscZip,
  buildStoredZip,
  candidatesKey,
  cueForImage,
  DEZAEMON_CUE_NAME,
  dezaemonGeometry,
  discCandidates,
  findDezaemonDisc,
  findDezaemonDiscs,
  parseCueFiles,
  rewriteCueFiles,
  trackModeFor,
} from "../lib/dezaemon-disc.ts";
import { crc32 } from "../lib/ps2/zip.ts";
import { unzip } from "../static/zip-read.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

Deno.test("parseCueFiles reads quoted and bare FILE names in order", () => {
  const cue = [
    'FILE "Dezaemon 2 (Japan) (Track 1).bin" BINARY',
    "  TRACK 01 MODE1/2352",
    "    INDEX 01 00:00:00",
    'FILE "Dezaemon 2 (Japan) (Track 2).bin" BINARY',
    "  TRACK 02 AUDIO",
    "    INDEX 00 00:00:00",
    "    INDEX 01 00:02:00",
    "FILE track3.bin BINARY",
    "  TRACK 03 AUDIO",
    "REM FILE not-a-file.bin BINARY",
  ].join("\r\n");
  assertEquals(parseCueFiles(cue), [
    "Dezaemon 2 (Japan) (Track 1).bin",
    "Dezaemon 2 (Japan) (Track 2).bin",
    "track3.bin",
  ]);
});

Deno.test("rewriteCueFiles renames only the FILE lines", () => {
  const cue = 'FILE "discs/Dez 2.bin" BINARY\n  TRACK 01 MODE1/2352\n';
  assertEquals(
    rewriteCueFiles(cue, (n) => n.split("/").pop()!),
    'FILE "Dez 2.bin" BINARY\n  TRACK 01 MODE1/2352\n',
  );
});

Deno.test("a bare image gets a one-track cue for its geometry", () => {
  assertEquals(
    trackModeFor({ sectorSize: 2352, dataOffset: 16 }),
    "MODE1/2352",
  );
  assertEquals(trackModeFor({ sectorSize: 2048, dataOffset: 0 }), "MODE1/2048");
  assertEquals(
    trackModeFor({ sectorSize: 2352, dataOffset: 24 }),
    "MODE2/2352",
  );
  assertEquals(trackModeFor({ sectorSize: 2336, dataOffset: 8 }), "MODE2/2336");
  assertEquals(trackModeFor({ sectorSize: 2448, dataOffset: 16 }), null);
  assertEquals(
    cueForImage("Dez 2.bin", { sectorSize: 2352, dataOffset: 16 }),
    'FILE "Dez 2.bin" BINARY\n  TRACK 01 MODE1/2352\n    INDEX 01 00:00:00\n',
  );
  assertThrows(() =>
    cueForImage("x.bin", { sectorSize: 2448, dataOffset: 16 })
  );
});

/** A disc image the detector should accept (or, without the markers, not). */
function image(markers: boolean): Uint8Array {
  const files = [
    { path: "0KERNEL.BIN", data: encoder.encode("kernel") },
    { path: "SNDPAC.BIN", data: encoder.encode("samples") },
  ];
  if (markers) {
    files.push(
      { path: "GAME.CMP", data: encoder.encode("game") },
      { path: "DEZA2.PAL", data: new Uint8Array(576) },
    );
  }
  return buildIso({
    volumeId: "DEZAEMON2",
    files,
    date: new Date("2000-03-04T00:00:00Z"),
  });
}

Deno.test("dezaemonGeometry wants both marker files in the root", () => {
  assertEquals(dezaemonGeometry(image(true)), {
    sectorSize: 2048,
    dataOffset: 0,
  });
  assertEquals(dezaemonGeometry(image(false)), null);
  assertEquals(dezaemonGeometry(new Uint8Array(4096)), null);
});

/** A temporary checkout: <root>/dev-fixtures/ with the given files. */
async function tree(files: Record<string, Uint8Array | string>) {
  const root = await Deno.makeTempDir({ prefix: "deza-disc-" });
  const fixtures = join(root, "dev-fixtures");
  await Deno.mkdir(fixtures);
  for (const [name, data] of Object.entries(files)) {
    await Deno.writeFile(
      join(fixtures, name),
      typeof data === "string" ? encoder.encode(data) : data,
    );
  }
  return { root, fixtures, done: () => Deno.remove(root, { recursive: true }) };
}

Deno.test("a bare Dezaemon image is found and described by a generated cue; decoys are not", async () => {
  const t = await tree({
    "deza.iso": image(true),
    "other-game.iso": image(false),
    "notes.txt": "not a disc",
  });
  try {
    const discs = await findDezaemonDiscs(t.root, { cache: false });
    assertEquals(discs.length, 1);
    const [disc] = discs;
    assertEquals(disc.cueFrom, "generated");
    assertEquals(disc.cuePath, null);
    assertEquals(disc.files.map((f) => f.name), ["deza.iso"]);
    assertEquals(disc.files[0].size, image(true).length);
    assertEquals(
      disc.cue,
      'FILE "deza.iso" BINARY\n  TRACK 01 MODE1/2048\n    INDEX 01 00:00:00\n',
    );
  } finally {
    await t.done();
  }
});

Deno.test("a cue beside the image is used as it is, and claims its image", async () => {
  const cueText = 'FILE "Dezaemon 2 (Japan).iso" BINARY\r\n' +
    "  TRACK 01 MODE1/2048\r\n    INDEX 01 00:00:00\r\n";
  const t = await tree({
    "Dezaemon 2 (Japan).iso": image(true),
    "Dezaemon 2 (Japan).cue": cueText,
    // A cue whose FILE is missing must be ignored rather than half-used.
    "broken.cue": 'FILE "missing.bin" BINARY\n  TRACK 01 MODE1/2352\n',
  });
  try {
    const discs = await findDezaemonDiscs(t.root, { cache: false });
    assertEquals(discs.length, 1, "the image must not be listed twice");
    const [disc] = discs;
    assertEquals(disc.cueFrom, "file");
    assertEquals(disc.cuePath, join(t.fixtures, "Dezaemon 2 (Japan).cue"));
    assertEquals(disc.files.map((f) => f.name), ["Dezaemon 2 (Japan).iso"]);
    assertEquals(parseCueFiles(disc.cue), ["Dezaemon 2 (Japan).iso"]);
    assert(disc.cue.includes("MODE1/2048"));
  } finally {
    await t.done();
  }
});

Deno.test("an explicit extra path (the $DEZAEMON_DISC hook) is a candidate too", async () => {
  const t = await tree({});
  const elsewhere = await Deno.makeTempDir({ prefix: "deza-elsewhere-" });
  try {
    const iso = join(elsewhere, "Dezaemon 2.bin");
    await Deno.writeFile(iso, image(true));
    await Deno.writeTextFile(
      join(elsewhere, "Dezaemon 2.cue"),
      'FILE "Dezaemon 2.bin" BINARY\n  TRACK 01 MODE1/2048\n    INDEX 01 00:00:00\n',
    );
    assertEquals(await findDezaemonDisc(t.root, { cache: false }), null);
    const disc = await findDezaemonDisc(t.root, {
      extra: [join(elsewhere, "Dezaemon 2.cue")],
      cache: false,
    });
    assert(disc);
    assertEquals(disc.cueFrom, "file");
    assertEquals(disc.files[0].path, iso);
  } finally {
    await t.done();
    await Deno.remove(elsewhere, { recursive: true });
  }
});

Deno.test("the memo key follows names, sizes and mtimes", async () => {
  const t = await tree({ "deza.iso": image(true) });
  try {
    const before = candidatesKey(await discCandidates(t.root));
    assertEquals(candidatesKey(await discCandidates(t.root)), before);
    await Deno.writeFile(join(t.fixtures, "deza.iso"), image(false));
    const after = candidatesKey(await discCandidates(t.root));
    assert(after !== before, "a rewritten image must change the key");
    // The memoised answer is keyed on that, so it re-detects (and now finds
    // nothing, since the markers are gone).
    assertEquals(await findDezaemonDiscs(t.root), []);
  } finally {
    await t.done();
  }
});

Deno.test("the zip holds 'Dezaemon 2.cue' and the track files, stored", async () => {
  const t = await tree({ "deza.iso": image(true) });
  try {
    const disc = (await findDezaemonDisc(t.root, { cache: false }))!;
    const zip = await buildDezaemonDiscZip(disc, { cache: false });
    const entries = await unzip(zip);
    assertEquals(entries.map((e) => e.path), [DEZAEMON_CUE_NAME, "deza.iso"]);
    assertEquals(decoder.decode(entries[0].data), disc.cue);
    assertEquals(entries[1].data, image(true));
    // Stored: the archive is the files plus headers, nothing was deflated.
    assert(zip.length > image(true).length + disc.cue.length);
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    assertEquals(view.getUint16(8, true), 0, "first entry's method is store");
  } finally {
    await t.done();
  }
});

Deno.test("buildStoredZip is reproducible and carries the right crc", async () => {
  const data = encoder.encode("hello disc");
  const a = buildStoredZip([{ path: "a.txt", data }], new Date(0));
  const b = buildStoredZip([{ path: "a.txt", data }], new Date(0));
  assertEquals(a, b);
  const view = new DataView(a.buffer);
  assertEquals(view.getUint32(14, true), crc32(data));
  assertEquals((await unzip(a))[0].data, data);
});

// ── The real disc, when this checkout has one ────────────────────────────────

const REPO_ROOT = new URL("../", import.meta.url);
const FIXTURE = "Dezaemon 2 (Japan) (Track 1).bin";
const haveFixture = await Deno.stat(
  new URL(`dev-fixtures/${FIXTURE}`, REPO_ROOT),
).then((s) => s.isFile).catch(() => false);

Deno.test({
  name:
    "the dev-fixtures disc is found as a MODE1/2352 data track and zips whole",
  ignore: !haveFixture,
  async fn() {
    const disc = await findDezaemonDisc(fromFileUrl(REPO_ROOT), {
      cache: false,
    });
    assert(disc, "the fixture disc was not recognised");
    assertEquals(disc.files.map((f) => f.name), [FIXTURE]);
    assertEquals(disc.files[0].size, 7646352);
    if (disc.cueFrom === "generated") {
      assertEquals(
        disc.cue,
        `FILE "${FIXTURE}" BINARY\n  TRACK 01 MODE1/2352\n    INDEX 01 00:00:00\n`,
      );
    }
    const zip = await buildDezaemonDiscZip(disc, { cache: false });
    const entries = await unzip(zip);
    assertEquals(entries.map((e) => e.path), [DEZAEMON_CUE_NAME, FIXTURE]);
    assertEquals(entries[1].data.length, 7646352);
    assertEquals(dezaemonGeometry(entries[1].data), {
      sectorSize: 2352,
      dataOffset: 16,
    });
  },
});
