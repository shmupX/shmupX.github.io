// A level's custom music comes from the level's own URL, or from a
// downloaded copy of THAT track, and never from another game's file.
//
// The site keeps a folder of downloaded tracks (assets/custom-bgm/, filled
// from 2028.Ai's foo.json by scripts/2028-ai/download-custom-bgm.ts) with a
// manifest of audio key -> file. The level loader used to take a key's
// listing as the copy of whatever a level named under that key, so RonaGun,
// which names its own song as boss_bison_bgm, played 2028.Ai's track on the
// site: the folder is 2028.Ai's, and boss_bison_bgm there is 2028.Ai's file.
// A key the cloud record had pointed elsewhere played the baked record's
// file the same way.
//
// Every downloader names a file after its track's URL (the first sixteen hex
// digits of its SHA-1, and ".mp3"), so the loader now asks the folder for the
// file of that name (customBgmFileName) and otherwise streams the track from
// its URL. Both loader copies are run here: the plugin and the one inlined in
// game.bundle.js (a vendored artifact patched by hand — README).

import { assert, assertEquals } from "@std/assert";
import {
  createLevelLoaderPlugin,
  customBgmFileName,
  DEFAULTS,
} from "../static/phaser-plugins/level-loader.js";

const BUNDLE = "static/games/2028-ai/game.bundle.js";

const read = async (p: string) =>
  (await Deno.readTextFile(new URL(`../${p}`, import.meta.url)))
    .replaceAll("\r\n", "\n");

/** The downloaders' rule, spelled with the platform's own SHA-1. */
async function nameByRule(url: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-1",
    new TextEncoder().encode(url),
  );
  const hex = Array.from(
    new Uint8Array(digest),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
  return hex.slice(0, 16) + ".mp3";
}

/** The bundle's inlined customBgmFileName. */
async function bundleFileName(): Promise<(url: string) => string> {
  const js = await read(BUNDLE);
  const start = js.indexOf("\n  function customBgmFileName(");
  assert(start >= 0, `no customBgmFileName in ${BUNDLE}`);
  const end = js.indexOf("\n  }\n", start);
  return new Function(
    js.slice(start, end + 4) + "\nreturn customBgmFileName;",
  )() as (url: string) => string;
}

type Queue = (
  this: { scene: unknown },
  level: { customAudioURLs?: Record<string, string> },
  opts: { stockPaths?: Record<string, string> },
  recipe?: unknown,
) => Record<string, string>;

/** The bundle's inlined _queueAudioOverrides, as a function of a plugin. */
async function bundleQueue(): Promise<Queue> {
  const js = await read(BUNDLE);
  const start = js.indexOf("\n      _queueAudioOverrides(levelData, opts");
  assert(start >= 0, `no _queueAudioOverrides in ${BUNDLE}`);
  const end = js.indexOf("\n      }\n", start);
  return new Function(
    "DEFAULTS",
    "customBgmFileName",
    "return ({" + js.slice(start, end + 8) + "})._queueAudioOverrides;",
  )(DEFAULTS, await bundleFileName()) as Queue;
}

const Plugin = createLevelLoaderPlugin({
  Plugins: {
    ScenePlugin: class {
      scene: unknown;
      constructor(scene: unknown) {
        this.scene = scene;
      }
    },
  },
});
const pluginQueue = Plugin.prototype._queueAudioOverrides as Queue;

type Handler = (arg?: unknown) => void;

/** A scene with the site's manifest in its cache, recording what is queued. */
function fakeScene(manifest: Record<string, string> | null) {
  const loads: [string, string | string[]][] = [];
  const handlers: Record<string, Handler[]> = {};
  const audio = new Map<string, unknown>();
  const listen = (ev: string, fn: Handler) => {
    (handlers[ev] ||= []).push(fn);
  };
  return {
    loads,
    emit(ev: string, arg?: unknown) {
      (handlers[ev] || []).slice().forEach((h) => h(arg));
    },
    scene: {
      cache: {
        json: {
          exists: (k: string) =>
            k === "custom-bgm-manifest" && manifest !== null,
          get: () => manifest,
        },
        audio: {
          exists: (k: string) => audio.has(k),
          remove: (k: string) => audio.delete(k),
          add: (k: string, v: unknown) => audio.set(k, v),
          get: (k: string) => audio.get(k),
        },
      },
      load: {
        audio: (key: string, src: string | string[]) => loads.push([key, src]),
        once: listen,
        on: listen,
        off: (ev: string, fn: Handler) => {
          handlers[ev] = (handlers[ev] || []).filter((h) => h !== fn);
        },
      },
    },
  };
}

const RONAGUN =
  "https://easierbycode.com/hellophaser/v4/title-song-vbr%20(Mastered%20with%20Thunder%20at%20100pct).7ab5d673.mp3";
const STOCK = { boss_bison_bgm: "assets/sounds/boss_bison_bgm.mp3" };
const DIR = "./assets/custom-bgm/";

/** 2028.Ai's baked music, and the manifest the site's download step writes. */
async function site() {
  const foo = JSON.parse(await read("static/games/2028-ai/foo.json"));
  const urls = foo.customAudioURLs as Record<string, string>;
  const manifest: Record<string, string> = {};
  for (const [key, url] of Object.entries(urls)) {
    manifest[key] = await nameByRule(url);
  }
  return { urls, manifest };
}

Deno.test("a track's file is named after its URL, as every downloader names it", async () => {
  const inBundle = await bundleFileName();
  const { urls } = await site();
  const samples = [
    ...new Set(Object.values(urls)),
    RONAGUN,
    "",
    "a",
    "é ünïcode ✓ " + "x".repeat(200),
    // Either side of SHA-1's padding boundaries.
    ...[55, 56, 63, 64, 119, 120].map((n) => "x".repeat(n)),
  ];
  for (const url of samples) {
    const want = await nameByRule(url);
    assertEquals(customBgmFileName(url), want, "plugin: " + url.slice(0, 40));
    assertEquals(inBundle(url), want, "bundle: " + url.slice(0, 40));
  }
  assertEquals(
    customBgmFileName("https://easierbycode.com/1.mp3"),
    "c725a1374cbe8314.mp3",
  );
  // The three writers of a custom-bgm folder: the site's build step, an
  // exported app's (build-level), and the in-game forge.
  const rule = '.slice(0, 16) + ".mp3"';
  for (
    const [path, line] of [
      [
        "scripts/2028-ai/download-custom-bgm.ts",
        '(await sha1Hex(url)).slice(0, 16) + ".mp3"',
      ],
      [
        "packages/shmup-harbor/tools/build-level/lib/download-bgm.js",
        'crypto.createHash("sha1").update(url).digest("hex")' + rule,
      ],
      [BUNDLE, "(await sha1Hex(url))" + rule],
    ]
  ) {
    assert((await read(path)).includes(line), path + " names files otherwise");
  }
});

for (
  const [copy, getQueue] of [
    ["the plugin", () => Promise.resolve(pluginQueue)],
    ["the bundle's inlined copy", bundleQueue],
  ] as [string, () => Promise<Queue>][]
) {
  Deno.test(`${copy}: RonaGun's own song is streamed from its URL, not answered with 2028.Ai's file`, async () => {
    const queue = await getQueue();
    const { manifest } = await site();
    // The key is listed, for 2028.Ai's track.
    assertEquals(manifest.boss_bison_bgm, "c725a1374cbe8314.mp3");
    const s = fakeScene(manifest);
    const sources = queue.call(
      { scene: s.scene },
      { customAudioURLs: { boss_bison_bgm: RONAGUN } },
      { stockPaths: STOCK },
    );
    assertEquals(sources, { boss_bison_bgm: RONAGUN });
    assertEquals(s.loads, [["boss_bison_bgm", RONAGUN]]);
    // A stream that fails puts the key's stock sound back, which a track
    // taken for a downloaded copy never got.
    s.emit("loaderror", { type: "audio", key: "boss_bison_bgm" });
    assertEquals(s.loads[1], ["boss_bison_bgm", STOCK.boss_bison_bgm]);
  });

  Deno.test(`${copy}: 2028.Ai's own tracks come from the downloaded folder, once each`, async () => {
    const queue = await getQueue();
    const { urls, manifest } = await site();
    const s = fakeScene(manifest);
    queue.call({ scene: s.scene }, { customAudioURLs: urls }, {});
    const distinct = [...new Set(Object.values(urls))];
    assertEquals(s.loads.length, distinct.length);
    for (const [key, src] of s.loads) {
      assertEquals(src, [DIR + manifest[key], urls[key]], key);
    }
  });

  Deno.test(`${copy}: a key the record points elsewhere follows the record, from the folder when it holds that track`, async () => {
    const queue = await getQueue();
    const { urls, manifest } = await site();
    // The record names the four-minute cut where the folder's listing for
    // the key is another track; the cut is in the folder under other keys.
    const cut = urls.stage_bgm_4min;
    assert(urls.boss_goki_bgm !== cut, "the baked record changed");
    let s = fakeScene(manifest);
    queue.call(
      { scene: s.scene },
      { customAudioURLs: { boss_goki_bgm: cut } },
      {},
    );
    assertEquals(s.loads, [[
      "boss_goki_bgm",
      [DIR + manifest.stage_bgm_4min, cut],
    ]]);
    // One the folder does not hold at all is streamed.
    s = fakeScene(manifest);
    queue.call(
      { scene: s.scene },
      { customAudioURLs: { boss_goki_bgm: "https://example.com/x.mp3" } },
      {},
    );
    assertEquals(s.loads, [["boss_goki_bgm", "https://example.com/x.mp3"]]);
  });

  Deno.test(`${copy}: with no folder, or a file not named by the rule, a track is streamed`, async () => {
    const queue = await getQueue();
    let s = fakeScene(null);
    queue.call(
      { scene: s.scene },
      { customAudioURLs: { boss_bison_bgm: RONAGUN } },
      {},
    );
    assertEquals(s.loads, [["boss_bison_bgm", RONAGUN]]);
    // Phaser takes the first source it can decode and never falls back, so
    // a name the rule does not vouch for is not offered.
    s = fakeScene({ boss_bison_bgm: "boss_bison_bgm.mp3" });
    queue.call(
      { scene: s.scene },
      { customAudioURLs: { boss_bison_bgm: RONAGUN } },
      {},
    );
    assertEquals(s.loads, [["boss_bison_bgm", RONAGUN]]);
  });
}
