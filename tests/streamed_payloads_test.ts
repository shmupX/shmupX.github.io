// What the packaged app leaves out of its binary, and how it does without
// (lib/streamed-payloads.ts). Each half is easy to break without noticing:
// a romset the binary drops but the server will not keep plays nothing, and
// a BGM the loader still looks for locally plays silence.

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  arcadeFiles,
  CORE_ORIGIN,
  ENGINE_ORIGIN,
  excludedFromBinary,
  isLeftOut,
  keepArcadeBoard,
  KEPT_CORES,
  keptFromDeploy,
  keptManifest,
  keptRomsets,
  localizeCatalog,
  ROMSET_PATH,
  sourceFor,
  STREAM_ORIGIN,
} from "../lib/streamed-payloads.ts";

const read = (p: string) =>
  Deno.readTextFile(new URL(`../${p}`, import.meta.url));

Deno.test("every arcade row's romset is one the packaged app keeps", async () => {
  const eshop = JSON.parse(await read("data/eshop.json"));
  const arcade = eshop.filter((e: { kind: string }) => e.kind === "arcade");
  assert(arcade.length > 0, "no arcade rows to check");
  const romUrls = arcade.map((e: { romUrl: string }) => e.romUrl);
  assertEquals(keptRomsets(eshop), romUrls);
  for (const url of romUrls) assert(keptFromDeploy(url), url);
  // A web row's archive is not a romset: it stays in the binary.
  assertEquals(ROMSET_PATH.test("/games/2019-web.zip"), false);
  assertEquals(keptFromDeploy("/games/2019-web.zip"), false);
  assertEquals(keptFromDeploy("/games/2028-ai/game.bundle.js"), false);
});

Deno.test("the custom BGM is kept, the Mario archive left out, nothing beside them", async () => {
  assert(keptFromDeploy("/games/2028-ai/assets/custom-bgm/manifest.json"));
  assert(
    keptFromDeploy("/games/2028-ai/assets/custom-bgm/614ade7f06c50da0.mp3"),
  );
  assertEquals(
    keptFromDeploy("/games/2028-ai/assets/sounds/boss_bison_bgm.mp3"),
    false,
  );
  assert(isLeftOut("/games/super-mario-sp-web.zip"));
  assertEquals(isLeftOut("/games/super-mario-sp/emulatorjs/loader.js"), false);
  assertEquals(isLeftOut("/games/2019-web.zip"), false);
  // The Switch pack's content is never embedded: the core, the keys and the
  // cartridge folder, list included. The player page is the binary's own.
  assert(isLeftOut("/switch/core/switch_core.wasm"));
  assert(isLeftOut("/switch/keys/prod.keys"));
  assert(isLeftOut("/NintendoSwitch/Game (USA).xci"));
  assert(isLeftOut("/NintendoSwitch/manifest.json"));
  assert(isLeftOut("/NintendoSwitch"), "the folder itself, as an --exclude");
  assertEquals(isLeftOut("/switch/play.html"), false);
  assertEquals(isLeftOut("/NintendoSwitchy"), false);
  // What build-desktop excludes is exactly what the server answers for.
  const eshop = JSON.parse(await read("data/eshop.json"));
  for (const p of excludedFromBinary(eshop)) {
    assert(keptFromDeploy(p + "/x") || keptFromDeploy(p) || isLeftOut(p), p);
  }
});

Deno.test("the level loader — the plugin and the bundle's inlined copy — streams a track its manifest does not list", async () => {
  for (
    const path of [
      "static/phaser-plugins/level-loader.js",
      "static/games/2028-ai/game.bundle.js",
    ]
  ) {
    const js = await read(path);
    // Phaser takes the first decodable URL and never falls back on a 404, so a
    // guessed local path would be silence once custom-bgm/ is left out.
    assertEquals(js.includes('manifest[uKey] || uKey + ".mp3"'), false, path);
    assertEquals(js.includes('manifest[uKey] || (uKey + ".mp3")'), false, path);
    assert(
      js.includes(
        "scene.load.audio(uKey, [baseUrl + customBgmDir + manifest[uKey], uUrl]);",
      ),
      path + ": the listed local copy no longer comes first",
    );
    assert(
      js.includes("scene.load.audio(uKey, uUrl);"),
      path + ": no streaming road",
    );
    assert(
      js.includes('scene.load.on("loaderror", restoreStock);'),
      path + ": a failed stream does not fall back to the stock sound",
    );
    // One download per track, not per key: four bosses share one 41 MB file,
    // and four parallel streams of it were 170 MB before the title screen.
    assert(
      js.includes(
        'scene.load.once("filecomplete-audio-" + lead, fileUnder[lead]);',
      ),
      path + ": keys sharing a track each download it",
    );
  }
  const bundle = await read("static/games/2028-ai/game.bundle.js");
  assert(
    bundle.includes("audio: { stockPaths: RESOURCE_PATHS },"),
    "the game does not hand the loader its stock sounds",
  );
});

Deno.test("each kept path comes from the host that serves it", () => {
  assertEquals(
    sourceFor("/games/guardians-denjin-makai-ii/grdians.zip"),
    STREAM_ORIGIN + "/games/guardians-denjin-makai-ii/grdians.zip",
  );
  assertEquals(
    sourceFor("/games/2028-ai/assets/custom-bgm/manifest.json"),
    STREAM_ORIGIN + "/games/2028-ai/assets/custom-bgm/manifest.json",
  );
  assertEquals(
    sourceFor("/arcade/play.html"),
    CORE_ORIGIN + "/arcade/play.html",
  );
  assertEquals(
    sourceFor("/arcade/emularity/engine/zunkyou.json"),
    ENGINE_ORIGIN + "/zunkyou.json",
  );
  // The player asks for the unzipped core; the engine serves the .gz.
  assertEquals(
    sourceFor("/arcade/emularity/engine/mamesegac2.wasm"),
    ENGINE_ORIGIN + "/mamesegac2.wasm.gz",
  );
  assertEquals(
    sourceFor("/arcade/emularity/engine/mamesegac2.js"),
    ENGINE_ORIGIN + "/mamesegac2.js.gz",
  );
  assertEquals(sourceFor("/arcade/emularity/engine/a/b.wasm"), null);
  assertEquals(sourceFor("/nes/play.html"), null);
  assertEquals(sourceFor("/games/2028-ai/game.bundle.js"), null);
  assertEquals(sourceFor("/"), null);
});

Deno.test("the kept cores are the catalogue's, at its origin, and only they turn local", async () => {
  const catalog = JSON.parse(await read("static/emulators.json"));
  assertEquals(catalog.origin, CORE_ORIGIN);
  for (const [id, prefixes] of Object.entries(KEPT_CORES)) {
    const core = catalog.cores.find((c: { id: string }) => c.id === id);
    assert(core, id + " is not in the catalogue");
    assertEquals(core.prefixes, prefixes);
  }
  const local = localizeCatalog(catalog);
  for (const core of local.cores) {
    const was = catalog.cores.find((c: { id: string }) => c.id === core.id);
    assertEquals(
      core.local,
      core.id in KEPT_CORES ? true : was.local,
      core.id,
    );
  }
  assertEquals(local.origin, catalog.origin);
});

Deno.test("every arcade romset is named after its board, which is what its recipe is named after", async () => {
  const eshop = JSON.parse(await read("data/eshop.json"));
  for (const e of eshop.filter((e: { kind: string }) => e.kind === "arcade")) {
    assertEquals(
      e.romUrl.slice(e.romUrl.lastIndexOf("/") + 1),
      e.rom + ".zip",
      e.id,
    );
  }
});

Deno.test("an arcade board's files are the player, its scripts, the recipe and the core it names", () => {
  const files = arcadeFiles("zunkyou", {
    driver: "zunkyou",
    wasmjs_filename: "mamesegac2.js.gz",
    wasm_filename: "mamesegac2.wasm.gz",
  });
  for (
    const f of [
      "/arcade/play.html",
      "/arcade/emularity/browserfs.min.js",
      "/arcade/emularity/loader.js",
      "/arcade/emularity/engine/zunkyou.json",
      "/arcade/emularity/engine/mamesegac2.js",
      "/arcade/emularity/engine/mamesegac2.wasm",
      "/arcade/cfg/zunkyou.cfg",
      "/arcade/nvram/zunkyou/at28c16",
    ]
  ) assert(files.includes(f), f);
  for (const f of files) {
    assert(sourceFor(f), f + " has no source to keep it from");
  }
});

Deno.test("keeping a board brings its whole player along, and skips what the hosts do not have", async () => {
  const root = await Deno.makeTempDir();
  const asked: string[] = [];
  const hosts: Record<string, string> = {
    [STREAM_ORIGIN + "/games/zunzunkyou-no-yabou/zunkyou.zip"]: "PK",
    [CORE_ORIGIN + "/arcade/play.html"]: "<html>",
    [CORE_ORIGIN + "/arcade/manifest.json"]: "[]",
    [CORE_ORIGIN + "/arcade/emularity/browserfs.min.js"]: "bfs",
    [CORE_ORIGIN + "/arcade/emularity/loader.js"]: "loader",
    [ENGINE_ORIGIN + "/zunkyou.json"]: JSON.stringify({
      driver: "zunkyou",
      wasmjs_filename: "mamesegac2.js.gz",
      wasm_filename: "mamesegac2.wasm.gz",
    }),
    [ENGINE_ORIGIN + "/mamesegac2.js.gz"]: "core-js",
    [ENGINE_ORIGIN + "/mamesegac2.wasm.gz"]: "\0asm-core",
  };
  const fetchImpl = ((url: string) => {
    asked.push(url);
    return Promise.resolve(
      url in hosts
        ? new Response(hosts[url])
        : new Response("no", { status: 404 }),
    );
  }) as typeof fetch;
  await keepArcadeBoard("/games/zunzunkyou-no-yabou/zunkyou.zip", {
    root,
    fetchImpl,
  });
  const kept = (p: string) =>
    Deno.readTextFile(join(root, ...p.slice(1).split("/")));
  assertEquals(await kept("/games/zunzunkyou-no-yabou/zunkyou.zip"), "PK");
  assertEquals(await kept("/arcade/play.html"), "<html>");
  assertEquals(
    await kept("/arcade/emularity/engine/mamesegac2.wasm"),
    "\0asm-core",
  );
  assertEquals(await kept("/arcade/emularity/engine/mamesegac2.js"), "core-js");
  // The cfg and NVRAM the host 404s are asked for and not kept.
  assert(asked.includes(CORE_ORIGIN + "/arcade/cfg/zunkyou.cfg"));
  let cfgKept = true;
  try {
    await kept("/arcade/cfg/zunkyou.cfg");
  } catch {
    cfgKept = false;
  }
  assertEquals(cfgKept, false);
});

Deno.test("the BGM manifest lists only the tracks the store holds", async () => {
  const root = await Deno.makeTempDir();
  const dir = "/games/2028-ai/assets/custom-bgm/";
  const fetchImpl = ((url: string) => {
    const path = new URL(url).pathname;
    if (path === dir + "manifest.json") {
      return Promise.resolve(Response.json({
        boss_bison_bgm: "big.mp3",
        boss_vega_bgm: "big.mp3",
        voice_titlecall: "gone.mp3",
      }));
    }
    if (path === dir + "big.mp3") return Promise.resolve(new Response("ID3"));
    return Promise.resolve(new Response("no", { status: 404 }));
  }) as typeof fetch;
  const res = await keptManifest(dir + "manifest.json", { root, fetchImpl });
  assertEquals(await res.json(), {
    boss_bison_bgm: "big.mp3",
    boss_vega_bgm: "big.mp3",
  });
  // Offline next time: the held track is still listed.
  const offline = (() => Promise.reject(new TypeError("down"))) as typeof fetch;
  const again = await keptManifest(dir + "manifest.json", {
    root,
    fetchImpl: offline,
  });
  assertEquals(Object.keys(await again.json()).sort(), [
    "boss_bison_bgm",
    "boss_vega_bgm",
  ]);
});
