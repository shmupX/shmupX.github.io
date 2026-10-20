// scripts/inject-disc.ts — `deno task disc:inject`, end to end on a synthetic
// disc: a cue and two tracks written to a temp dir, the game built (or taken
// off a cart), the new disc written beside its own cue, its own copy of the
// audio track and, asked for, the browser player's zip — and the boot image
// read back out of what was written. The retail disc is community content and
// never in CI; packages/shmup-engine/test/disc-inject.test.js holds the engine
// to it when a checkout has one.

import { assert, assertEquals, assertRejects } from "@std/assert";
import { basename, join } from "@std/path";
import { readDiscGame } from "@shmupx/shmup-engine/disc-inject";
import {
  cartGameName,
  cartGames,
  describeDisc,
  findSaturnDisc,
  injectDisc,
} from "../scripts/inject-disc.ts";
import { buildSav } from "../scripts/build-sav.ts";
import {
  CART_PARTITION_SIZE,
  formatPartition,
  gameSaveFilename,
  isGameSave,
  normalize,
  parse,
  placeSaveInPartition,
} from "@shmupx/shmup-engine";
import { CART_BLOCK_SIZE } from "@shmupx/shmup-engine/bup-write";
import { markerPayload } from "./support/cart_fixtures.ts";
import { parseCueFiles } from "../../../lib/dezaemon-disc.ts";
import { unzip } from "../../../static/zip-read.js";
import {
  dezaemonVolume,
  pattern,
} from "../../shmup-engine/test/_iso-synthetic.js";

const CUE = [
  'FILE "Synthetic (Track 1).bin" BINARY',
  "  TRACK 01 MODE1/2352",
  "    INDEX 01 00:00:00",
  'FILE "Synthetic (Track 2).bin" BINARY',
  "  TRACK 02 AUDIO",
  "    INDEX 00 00:00:00",
  "    INDEX 01 00:02:00",
  "",
].join("\r\n");

/** A two-track disc in `dir`: the synthetic Dezaemon data track and some audio. */
async function writeDisc(dir: string, { menu }: { menu?: Uint8Array } = {}) {
  await Deno.mkdir(dir, { recursive: true });
  const track1 = join(dir, "Synthetic (Track 1).bin");
  const track2 = join(dir, "Synthetic (Track 2).bin");
  const cue = join(dir, "Synthetic.cue");
  await Deno.writeFile(track1, dezaemonVolume(menu ? { menu } : {}).image);
  await Deno.writeFile(track2, pattern(2352 * 20, 5));
  await Deno.writeTextFile(cue, CUE);
  return { cue, track1, track2 };
}

const same = (a: Uint8Array[], b: Uint8Array[]) =>
  a.length === b.length &&
  a.every((s, i) =>
    s.length === b[i].length && s.every((v, j) => v === b[i][j])
  );

Deno.test("describeDisc takes a cue, its data track, or a bare track", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const { cue, track1, track2 } = await writeDisc(join(dir, "disc"));
    const byCue = await describeDisc(cue);
    assert(byCue);
    assertEquals(byCue.cuePath, cue);
    assertEquals(byCue.tracks.map((t) => basename(t)), [
      basename(track1),
      basename(track2),
    ]);
    // The data track with its cue beside it is described by that cue.
    const byTrack = await describeDisc(track1);
    assertEquals(byTrack?.cuePath, cue);
    // A bare data track gets a one-track cue written for it.
    const bare = join(dir, "bare", "Lonely.bin");
    await Deno.mkdir(join(dir, "bare"));
    await Deno.copyFile(track1, bare);
    const lonely = await describeDisc(bare);
    assertEquals(lonely?.cuePath, null);
    assertEquals(parseCueFiles(lonely!.cue), ["Lonely.bin"]);
    assert(lonely!.cue.includes("MODE1/2352"));
    // Anything else is not a disc.
    assertEquals(await describeDisc(track2), null);
    assertEquals(await describeDisc(join(dir, "missing.cue")), null);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("findSaturnDisc looks two folders down in dev-fixtures/, and names a bad --disc", async () => {
  const root = await Deno.makeTempDir();
  try {
    const { cue } = await writeDisc(
      join(root, "dev-fixtures", "Saturn", "Synthetic"),
    );
    // A cue that sorts first and names a track that is not Dezaemon 2: tried
    // before the real one, and passed over by what is in it.
    await Deno.writeFile(
      join(root, "dev-fixtures", "Saturn", "Other.bin"),
      pattern(5000, 1),
    );
    await Deno.writeTextFile(
      join(root, "dev-fixtures", "Saturn", "A Decoy.cue"),
      'FILE "Other.bin" BINARY\r\n  TRACK 01 MODE1/2352\r\n    INDEX 01 00:00:00\r\n',
    );
    if (!Deno.env.get("DEZAEMON_DISC")) {
      assertEquals((await findSaturnDisc(root))?.cuePath, cue);
    }
    assertEquals((await findSaturnDisc(root, cue))?.cuePath, cue);
    await assertRejects(
      () =>
        findSaturnDisc(root, join(root, "dev-fixtures", "Saturn", "Other.bin")),
      Error,
      "not a Dezaemon 2 disc",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("a cart's game goes onto the disc: renamed tracks, a cue naming them, and the zip", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const { cue, track2 } = await writeDisc(join(dir, "disc"));
    const cart = join(dir, "Dez 2 - foo.sav");
    await buildSav({ out: cart });
    const [game] = await cartGames(await Deno.readFile(cart));
    assertEquals(game.slot, 1);

    const out = join(dir, "out");
    const result = await injectDisc({ sav: cart, disc: cue, out, zip: true });
    assertEquals(result.dir, out);
    assertEquals(result.savPath, null, "a --sav run writes no second cart");
    assertEquals(result.tracks.map((t) => basename(t)), [
      `Dezaemon 2 (${result.name}) (Track 1).bin`,
      `Dezaemon 2 (${result.name}) (Track 2).bin`,
    ]);
    const cueText = await Deno.readTextFile(result.cuePath);
    assertEquals(parseCueFiles(cueText), result.tracks.map((t) => basename(t)));
    assert(
      cueText.includes("INDEX 01 00:02:00"),
      "the audio track's timing is kept",
    );

    const written = await Deno.readFile(result.tracks[0]);
    const back = readDiscGame(written);
    assertEquals(
      result.name,
      "foo",
      "named after the cart's file, not its comment",
    );
    assert(
      same(back.sections, game.sections!),
      "the disc boots holding the cart's game",
    );
    assertEquals(back.menu, "patched");
    assertEquals(
      await Deno.readFile(result.tracks[1]),
      await Deno.readFile(track2),
    );

    const entries = await unzip(await Deno.readFile(result.zipPath!));
    assertEquals(
      entries.map((e) => e.path),
      ["Dezaemon 2.cue", ...result.tracks.map((t) => basename(t))],
    );
    assertEquals(entries[1].data, written);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a level is built once into both the disc and a cart beside it", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const { cue } = await writeDisc(join(dir, "disc"));
    const out = join(dir, "out");
    const result = await injectDisc({ disc: cue, out, menu: false });
    assertEquals(result.name, "foo");
    assert(result.savPath, "the cart is written beside the disc");
    assertEquals(basename(result.savPath), "Dez 2 - foo.sav");
    const [cartGame] = await cartGames(await Deno.readFile(result.savPath));
    const back = readDiscGame(await Deno.readFile(result.tracks[0]));
    assert(
      same(back.sections, cartGame.sections!),
      "disc and cart hold the same bytes",
    );
    assertEquals(back.menu, "stock", "menu: false leaves the menu alone");
    assertEquals(result.zipPath, null);
    // Nothing else is left behind in the output folder.
    const names = [...Deno.readDirSync(out)].map((e) => e.name).sort();
    assertEquals(names, [
      "Dez 2 - foo.sav",
      "Dezaemon 2 (foo) (Track 1).bin",
      "Dezaemon 2 (foo) (Track 2).bin",
      "Dezaemon 2 (foo).cue",
    ]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a cart slot that is empty is refused with what the cart does hold", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const { cue } = await writeDisc(join(dir, "disc"));
    const cart = join(dir, "one.sav");
    await buildSav({ out: cart });
    await assertRejects(
      () =>
        injectDisc({ sav: cart, slot: 3, disc: cue, out: join(dir, "out") }),
      Error,
      "nothing in slot 3",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a cart's game is named after the cart's file, not its stock comment", () => {
  const game = { slot: 1, comment: "DEZA2 SGM", sections: null, error: null };
  assertEquals(cartGameName("x/Dez 2 - Ramsie.sav", game, 1), "Ramsie");
  assertEquals(cartGameName("Dezaemon 2 (DAIOH).sav", game, 1), "DAIOH");
  assertEquals(
    cartGameName("C:/carts/Air Land Battle.bcr", game, 1),
    "Air Land Battle",
  );
  assertEquals(
    cartGameName(".sav", game, 1),
    "DEZA2 SGM",
    "the comment, when the file says nothing",
  );
  assertEquals(
    cartGameName("Dez 2 - Mixed.sav", { ...game, slot: 2 }, 3),
    "Mixed (slot 2)",
  );
});

Deno.test("a damaged slot is listed, not fatal: the healthy game beside it still goes on the disc", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const { cue } = await writeDisc(join(dir, "disc"));
    const built = join(dir, "foo.sav");
    await buildSav({ out: built });
    const { data } = await normalize(await Deno.readFile(built));
    const [foo] = parse(data).filter(isGameSave);
    const part = formatPartition(CART_PARTITION_SIZE, CART_BLOCK_SIZE);
    placeSaveInPartition(part, CART_BLOCK_SIZE, {
      filename: gameSaveFilename(1),
      comment: "broken",
      language: 0,
      date: 0,
      payload: markerPayload("broken", 4000),
    });
    placeSaveInPartition(part, CART_BLOCK_SIZE, {
      filename: gameSaveFilename(2),
      comment: "foo",
      language: 0,
      date: 0,
      payload: foo.payload!.buffer,
    });
    const cart = join(dir, "Dez 2 - Two.bcr");
    await Deno.writeFile(cart, part);
    const games = await cartGames(part);
    assertEquals(games.map((g) => [g.slot, !!g.error]), [[1, true], [
      2,
      false,
    ]]);
    assert(
      games[0].error!.startsWith("DEZA2____01: "),
      "the error names the slot",
    );
    // No --slot: the first healthy game. --slot on the damaged one: refused by name.
    const result = await injectDisc({
      sav: cart,
      disc: cue,
      out: join(dir, "out"),
    });
    assertEquals(result.name, "Two (slot 2)");
    await assertRejects(
      () =>
        injectDisc({ sav: cart, slot: 1, disc: cue, out: join(dir, "out1") }),
      Error,
      "slot 1 is damaged",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("--keep-menu says what the written disc has when the source was already patched", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const { cue } = await writeDisc(join(dir, "disc"));
    const first = await injectDisc({ disc: cue, out: join(dir, "first") });
    const lines: string[] = [];
    const again = await injectDisc({
      disc: first.cuePath,
      out: join(dir, "again"),
      menu: false,
      log: (m) => lines.push(m),
    });
    assertEquals(
      readDiscGame(await Deno.readFile(again.tracks[0])).menu,
      "patched",
    );
    const menuLine = lines.find((l) => l.startsWith("menu:"));
    assert(menuLine?.includes("already patched"), menuLine);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a cue keeping the data and audio tracks in one .bin is refused, not half-written", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const { track1 } = await writeDisc(join(dir, "disc"));
    const one = join(dir, "disc", "One.cue");
    await Deno.writeTextFile(
      one,
      `FILE "${
        basename(track1)
      }" BINARY\r\n  TRACK 01 MODE1/2352\r\n    INDEX 01 00:00:00\r\n  TRACK 02 AUDIO\r\n    INDEX 01 00:00:40\r\n`,
    );
    assertEquals((await describeDisc(one))?.dataTrackShared, true);
    await assertRejects(
      () => injectDisc({ disc: one, out: join(dir, "out") }),
      Error,
      "one file per track",
    );
    assertEquals(
      [...Deno.readDirSync(dir)].map((e) => e.name),
      ["disc"],
      "nothing was written",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("--out never writes over a game.sav that is already there", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const { cue } = await writeDisc(join(dir, "disc"));
    const out = join(dir, "out");
    await Deno.mkdir(out);
    await Deno.writeTextFile(join(out, "game.sav"), "my own save");
    await injectDisc({ disc: cue, out });
    assertEquals(await Deno.readTextFile(join(out, "game.sav")), "my own save");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a cooked .iso whose length is a multiple of 2352 is read back as cooked", async () => {
  const dir = await Deno.makeTempDir();
  try {
    // 147 cooked sectors are 301,056 bytes = 128 raw ones: the length alone
    // would pass it for a MODE1/2352 image.
    const { image, sectors } = dezaemonVolume({ raw: false });
    const padded = new Uint8Array(Math.ceil(sectors / 147) * 147 * 2048);
    padded.set(image);
    assertEquals(padded.length % 2352, 0);
    const iso = join(dir, "Cooked.iso");
    await Deno.writeFile(iso, padded);
    const result = await injectDisc({ disc: iso, out: join(dir, "out") });
    assertEquals(result.tracks.map((t) => basename(t)), [
      "Dezaemon 2 (foo).iso",
    ]);
    assertEquals(
      readDiscGame(await Deno.readFile(result.tracks[0])).menu,
      "patched",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a bare .bin that runs on into the audio track is refused", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const { track1, track2 } = await writeDisc(join(dir, "disc"));
    // The whole disc in one file with no cue beside it: data, then audio.
    const whole = join(dir, "whole", "Whole.bin");
    await Deno.mkdir(join(dir, "whole"));
    const a = await Deno.readFile(track1), b = await Deno.readFile(track2);
    const both = new Uint8Array(a.length + b.length);
    both.set(a);
    both.set(b, a.length);
    await Deno.writeFile(whole, both);
    assertEquals((await describeDisc(whole))?.dataTrackShared, true);
    assertEquals(
      (await describeDisc(track1))?.dataTrackShared,
      false,
      "the data track alone is fine",
    );
    await assertRejects(
      () => injectDisc({ disc: whole, out: join(dir, "out") }),
      Error,
      "one file per track",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a run that fails leaves the output folder exactly as it was", async () => {
  const dir = await Deno.makeTempDir();
  try {
    // A menu overlay the patch does not know: the injection refuses it, after
    // the cart is already built.
    const { cue } = await writeDisc(join(dir, "disc"), {
      menu: pattern(30000, 9),
    });
    const out = join(dir, "out");
    await Deno.mkdir(out);
    await Deno.writeTextFile(join(out, "Dez 2 - foo.sav"), "an older cart");
    await assertRejects(
      () => injectDisc({ disc: cue, out }),
      Error,
      "not the retail overlay",
    );
    assertEquals([...Deno.readDirSync(out)].map((e) => e.name), [
      "Dez 2 - foo.sav",
    ]);
    assertEquals(
      await Deno.readTextFile(join(out, "Dez 2 - foo.sav")),
      "an older cart",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("--keep-menu on a menu the patch does not know says so instead of calling it stock", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const { cue } = await writeDisc(join(dir, "disc"), {
      menu: pattern(30000, 9),
    });
    const lines: string[] = [];
    const result = await injectDisc({
      disc: cue,
      out: join(dir, "out"),
      menu: false,
      log: (m) => lines.push(m),
    });
    const menuLine = lines.find((l) => l.startsWith("menu:"))!;
    assert(menuLine.includes("not an overlay this patch knows"), menuLine);
    assert(!menuLine.includes(", stock"), menuLine);
    assert(
      result.warnings.some((w) =>
        w.includes("not an overlay this patch knows")
      ),
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
