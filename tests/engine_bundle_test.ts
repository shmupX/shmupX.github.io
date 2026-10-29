// The committed browser bundle, static/engine/shmup-engine.js, is what the
// level editor (and the model viewer) actually run. Nothing regenerates it in
// CI, so this is the guard against a mod.js change shipped without
// `deno task engine:bundle`.

import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import * as bundle from "../static/engine/shmup-engine.js";
import * as source from "../packages/shmup-engine/mod.js";
import { join } from "@std/path";
import { decodePng } from "../packages/shmup-harbor/lib/ps2/png.ts";
import {
  ATHENA_FONT_PATH,
  loadAthenaFont,
} from "../packages/shmup-harbor/lib/bitmap-font.ts";
import {
  decodeStoryPicture,
  storyBackdrops,
} from "../packages/shmup-harbor/lib/story-panels.ts";
import { repoRoot } from "../packages/shmup-harbor/lib/repo-root.ts";

Deno.test("the engine bundle carries every name mod.js exports", () => {
  const missing = Object.keys(source).filter((name) => !(name in bundle));
  assertStrictEquals(
    missing.length,
    0,
    `stale bundle, missing: ${missing.join(", ")}`,
  );
});

Deno.test("the bundle's model surface works", () => {
  const b = bundle as unknown as Record<string, CallableFunction>;
  assert(typeof b.buildModelMesh === "function");
  assertStrictEquals(b.rgb555ToHex(0x7fff), 0xffffff);
  const mesh = b.buildModelMesh({
    parts: [{
      shapeFamily: 5,
      meshIndex: 0,
      colorSet: 0,
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
    }],
  });
  assertStrictEquals(mesh.triCount, 12);
});

// The editor's MUSIC mode runs the bundle's song model. A name check alone
// passes a bundle built before a behaviour change, so this plays a few edits
// through the bundle and the source side by side.
Deno.test("the bundle's song model edits and records exactly as the source does", () => {
  type Song = Uint8Array;
  type Music = {
    emptySong: () => Song;
    placeNote: (b: Song, n: Record<string, number>) => Song;
    setRhythm: (b: Song, m: number, r: Record<string, number>) => Song;
    songStreams: (b: Song) => unknown;
    songShape: (b: Song) => { canonical: boolean };
    bgmFromSave: (s: unknown, sec6: Uint8Array, n: number) => Record<string, unknown>;
    emptySongBank: () => Uint8Array;
  };
  const b = bundle as unknown as Music;
  const s = source as unknown as Music;
  const compose = (m: Music) => {
    let song = m.placeNote(m.emptySong(), { part: 0, step: 3, len: 5, pitch: 25, inst: 13 });
    song = m.setRhythm(song, 1, { bank: 3, pattern: 1, chord: 2, key: 9 });
    const sec6 = m.emptySongBank();
    sec6.set(song, 4228 * 2);
    return {
      song: [...song],
      streams: m.songStreams(song),
      canonical: m.songShape(song).canonical,
      record: m.bgmFromSave({ bgmTable: new Array(24).fill(2), sfxSet: 1 }, sec6, 1),
    };
  };
  const fromBundle = compose(b);
  assertEquals(fromBundle, compose(s));
  assert("bank" in fromBundle.record && "table" in fromBundle.record, "a stale record shape");
});

// …and the editor's EXPORT .SAV writes a record's banked slots and raw table
// through the bundle's buildSaveFromGame, not only the slots it plays.
Deno.test("the bundle's export writes the whole song bank and the raw BGM table", async () => {
  const level = JSON.parse(
    await Deno.readTextFile(new URL("../static/games/2028-ai/foo.json", import.meta.url)),
  );
  const b = bundle as unknown as {
    emptySong: () => Uint8Array;
    placeNote: (s: Uint8Array, n: Record<string, number>) => Uint8Array;
    bytesToB64: (s: Uint8Array) => string;
    buildSaveFromGame: (l: unknown, art: unknown, o?: unknown) => { sections: Uint8Array[] };
  };
  const banked = b.placeNote(b.emptySong(), { part: 2, step: 9, len: 2, pitch: 40, inst: 21 });
  const table = Array.from({ length: 24 }, (_, i) => 23 - i);
  level.dezaemonBgm = { sfxSet: 3, songs: {}, bank: { 17: b.bytesToB64(banked) }, table };
  const { sections } = b.buildSaveFromGame(level, {}, { warn: () => {} });
  assertEquals([...sections[6].subarray(17 * 4228, 18 * 4228)], [...banked]);
  const at = 0x5a780;
  assertEquals([...sections[5].subarray(at + 0x41, at + 0x59)], table);
  assertStrictEquals(sections[5][at + 0x59], 3);
});

// The editor composes a cart's story with the bundle's storyBackdrops, the
// CLI builds with the workspace's (packages/shmup-harbor/lib/story-panels.ts).
// Handed the same face and the same decoded pictures, the two must draw the
// same backdrops, pixel for pixel, or a cart from the editor would open its
// stages on a different story than `build:sav` puts there.
Deno.test("the bundle composes a story exactly as the CLI does", async () => {
  const root = repoRoot();
  const foo = JSON.parse(
    await Deno.readTextFile(join(root, "static/games/2028-ai/foo.json")),
  );
  const b = bundle as unknown as {
    bitmapFontFromSheet: (sheet: unknown) => unknown;
    storyBackdrops: (sd: unknown, opts: unknown) => Promise<unknown[]>;
  };
  const sheet = await decodePng(
    await Deno.readFile(join(root, ATHENA_FONT_PATH)),
  );
  const page = await b.storyBackdrops(foo.storyData, {
    font: b.bitmapFontFromSheet(sheet),
    decodePicture: decodeStoryPicture,
  });
  const cli = await storyBackdrops(foo.storyData, {
    font: await loadAthenaFont(root),
  });
  assert(cli.length > 0, "foo tells a story");
  assertEquals(page, cli);
});
