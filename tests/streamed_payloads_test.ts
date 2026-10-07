// What the packaged app leaves out of its binary, and how it does without
// (lib/streamed-payloads.ts). Each half is easy to break without noticing:
// a romset the binary drops but the server will not proxy plays nothing, and
// a BGM the loader still looks for locally plays silence.

import { assert, assertEquals } from "@std/assert";
import {
  isLeftOut,
  ROMSET_PATH,
  STREAM_ORIGIN,
  streamedRomsets,
  streamFromDeploy,
} from "../lib/streamed-payloads.ts";

const read = (p: string) =>
  Deno.readTextFile(new URL(`../${p}`, import.meta.url));

Deno.test("every arcade row's romset is one the packaged app streams", async () => {
  const eshop = JSON.parse(await read("data/eshop.json"));
  const arcade = eshop.filter((e: { kind: string }) => e.kind === "arcade");
  assert(arcade.length > 0, "no arcade rows to check");
  assertEquals(
    streamedRomsets(eshop),
    arcade.map((e: { romUrl: string }) => e.romUrl),
  );
  // A web row's archive is not a romset: it stays in the binary.
  assertEquals(ROMSET_PATH.test("/games/2019-web.zip"), false);
  assertEquals(ROMSET_PATH.test("/games/2028-ai/game.bundle.js"), false);
});

Deno.test("the left-out paths are the custom BGM and the Mario archive, nothing beside them", () => {
  assert(isLeftOut("/games/2028-ai/assets/custom-bgm/manifest.json"));
  assert(isLeftOut("/games/2028-ai/assets/custom-bgm/614ade7f06c50da0.mp3"));
  assert(isLeftOut("/games/super-mario-sp-web.zip"));
  assertEquals(
    isLeftOut("/games/2028-ai/assets/sounds/boss_bison_bgm.mp3"),
    false,
  );
  assertEquals(isLeftOut("/games/super-mario-sp/emulatorjs/loader.js"), false);
  assertEquals(isLeftOut("/games/2019-web.zip"), false);
});

Deno.test("a streamed romset carries the range through and the deploy's answer back", async () => {
  let asked: { url: string; method?: string; range: string | null } | null =
    null;
  const fake = ((url: string, init?: RequestInit) => {
    asked = {
      url,
      method: init?.method,
      range: new Headers(init?.headers).get("range"),
    };
    return Promise.resolve(
      new Response("Z", {
        status: 206,
        headers: {
          "content-type": "application/zip",
          "content-range": "bytes 0-0/928000",
          "set-cookie": "not=ours",
        },
      }),
    );
  }) as typeof fetch;
  const req = new Request(
    "http://127.0.0.1/games/zunzunkyou-no-yabou/zunkyou.zip",
    {
      headers: { range: "bytes=0-0" },
    },
  );
  const res = await streamFromDeploy(
    req,
    "/games/zunzunkyou-no-yabou/zunkyou.zip",
    fake,
  );
  assertEquals(asked, {
    url: STREAM_ORIGIN + "/games/zunzunkyou-no-yabou/zunkyou.zip",
    method: "GET",
    range: "bytes=0-0",
  });
  assertEquals(res.status, 206);
  assertEquals(res.headers.get("content-range"), "bytes 0-0/928000");
  assertEquals(res.headers.get("set-cookie"), null);
  assertEquals(await res.text(), "Z");
});

Deno.test("an unreachable deploy reads as a 502, not a thrown request", async () => {
  const offline =
    (() => Promise.reject(new TypeError("offline"))) as typeof fetch;
  const req = new Request("http://127.0.0.1/games/metamoqester/metmqstr.zip");
  const res = await streamFromDeploy(
    req,
    "/games/metamoqester/metmqstr.zip",
    offline,
  );
  assertEquals(res.status, 502);
  assert((await res.text()).includes("offline"));
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
