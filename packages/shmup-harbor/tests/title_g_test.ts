// scripts/build-sav.ts ownTitleG — the game's own titleG.gif found where the
// runtime finds it (its game_ui set, else an older save's level atlas), and a
// cart built from a game that wears only its G on its titles wearing it on the
// Saturn's title page too (TITLE 1, packages/shmup-engine/src/write/
// game-to-save.js). gs is the game this is for; foo, which has no title art of
// its own, stands in for it here with a G added.

import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import { encodeBase64 } from "@std/encoding/base64";
import { join } from "@std/path";
import { buildSav, type LevelRecord, ownTitleG } from "../scripts/build-sav.ts";
import { encodePng, newRaster } from "../lib/ps2/png.ts";
import { repoRoot } from "../lib/repo-root.ts";

/** A 40x30 sheet with an orange 20x10 plate at (10, 12); the rest clear. */
async function sheetDataUrl(): Promise<string> {
  const r = newRaster(40, 30);
  for (let y = 12; y < 22; y++) {
    for (let x = 10; x < 30; x++) {
      r.data.set([255, 128, 0, 255], (y * 40 + x) * 4);
    }
  }
  return `data:image/png;base64,${encodeBase64(await encodePng(r))}`;
}

const frame = { x: 10, y: 12, w: 20, h: 10 };

Deno.test("ownTitleG cuts the G out of the game_ui set, under its Firebase-encoded name", async () => {
  const record: LevelRecord = {
    uiAtlases: {
      game_ui: {
        imageDataURL: await sheetDataUrl(),
        frames: { "titleG․gif": { frame } },
      },
    },
  };
  const g = await ownTitleG(record, {});
  assert(g);
  assertEquals([g.w, g.h], [20, 10]);
  assertEquals(Array.from(g.rgba.subarray(0, 4)), [255, 128, 0, 255]);
});

Deno.test("ownTitleG falls back to an older save's copy in the level atlas, else none", async () => {
  const own = { w: 4, h: 4, rgba: new Uint8Array(64).fill(255) };
  assertStrictEquals(await ownTitleG({}, { "titleG.png": own }), own);
  assertStrictEquals(await ownTitleG({}, { "enemyA.gif": own }), null);
  // A set with no G, and a G whose sheet will not decode, are both "none".
  assertStrictEquals(
    await ownTitleG({
      uiAtlases: {
        game_ui: {
          imageDataURL: await sheetDataUrl(),
          frames: { "logo.gif": { frame } },
        },
      },
    }, {}),
    null,
  );
  const lines: string[] = [];
  assertStrictEquals(
    await ownTitleG(
      {
        uiAtlases: {
          game_ui: {
            imageDataURL: "data:image/png;base64,AAAA",
            frames: { "titleG.gif": { frame } },
          },
        },
      },
      {},
      (m) => lines.push(m),
    ),
    null,
  );
  assert(lines.some((l) => l.includes("could not be decoded")));
});

Deno.test("a game that wears only its G gets it as the cart's title page", async () => {
  const dir = await Deno.makeTempDir();
  try {
    // foo with its own logo and subtitle taken away: a game like gs.
    const foo = {
      ...JSON.parse(
        await Deno.readTextFile(
          join(repoRoot(), "static", "games", "2028-ai", "foo.json"),
        ),
      ),
      logoDataURL: null,
      subTitleDataURL: null,
    };
    const withG = join(dir, "foo-with-g.json");
    await Deno.writeTextFile(
      withG,
      JSON.stringify({
        ...foo,
        uiAtlases: {
          game_ui: {
            imageDataURL: await sheetDataUrl(),
            frames: { "titleG․gif": { frame } },
          },
        },
      }),
    );
    const lines: string[] = [];
    const built = await buildSav({
      level: withG,
      out: join(dir, "g.sav"),
      log: (m) => lines.push(m),
    });
    const title = built.report.title as { source: string; title1: boolean };
    assertStrictEquals(title.source, "titleG");
    assert(title.title1);
    assert(lines.some((l) => l.startsWith("title: the game's own titleG.gif")));
    // Without the G, that cart has no title page at all, as before.
    const without = join(dir, "foo-bare.json");
    await Deno.writeTextFile(without, JSON.stringify(foo));
    const bare = await buildSav({ level: without, out: join(dir, "bare.sav") });
    assertStrictEquals(
      (bare.report.title as { source: string }).source,
      "none",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a logo or subtitle the game replaced in game_ui is its title, over the G", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const foo = {
      ...JSON.parse(
        await Deno.readTextFile(
          join(repoRoot(), "static", "games", "2028-ai", "foo.json"),
        ),
      ),
      logoDataURL: null,
      subTitleDataURL: null,
    };
    const second = { x: 10, y: 12, w: 20, h: 5 };
    const lower = { x: 10, y: 17, w: 20, h: 5 };
    const level = join(dir, "foo-with-plates.json");
    await Deno.writeTextFile(
      level,
      JSON.stringify({
        ...foo,
        uiAtlases: {
          game_ui: {
            imageDataURL: await sheetDataUrl(),
            frames: {
              "titleG․gif": { frame },
              "logo․gif": { frame: second },
              "subTitleEn․gif": { frame: lower },
            },
          },
        },
      }),
    );
    const built = await buildSav({ level, out: join(dir, "plates.sav") });
    const title = built.report.title as {
      source: string;
      title1: boolean;
      title2: boolean;
    };
    assertStrictEquals(
      title.source,
      "uploaded",
      "the game's own logo and subtitle, as the browser and the PS2 show them",
    );
    assert(title.title1 && title.title2);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
