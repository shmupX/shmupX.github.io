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
