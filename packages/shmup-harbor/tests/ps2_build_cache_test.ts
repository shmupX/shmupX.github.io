// What a PS2 rebuild reuses from the last one.
//
// Most of a build was spent on things that had not changed: ffmpeg decoding
// the base game's sixty effects and nine tracks again (half a minute), and
// downloading the level's whole record again (186 KB for gs, a quarter of a
// build over a slow connection). The sound packs are now kept under a key of
// everything that makes them (cachedSoundPack), and the level is revalidated
// with Firebase's ETag rather than fetched again (fetchLevelRecord). Both
// have to notice a change as surely as they skip the work without one.

import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { fetchLevelRecord } from "../lib/ps2/build.ts";
import { cachedSoundPack, type SoundPack } from "../lib/ps2/sound-pack.ts";

const encoder = new TextEncoder();

async function soundTree(): Promise<{ gameDir: string; cacheDir: string }> {
  const root = await Deno.makeTempDir({ prefix: "shmupx-cache-" });
  const sounds = join(root, "game", "assets", "sounds", "ui");
  await Deno.mkdir(sounds, { recursive: true });
  await Deno.writeTextFile(join(sounds, "se_decision.mp3"), "one");
  return { gameDir: join(root, "game"), cacheDir: join(root, "cache") };
}

function maker(label: string) {
  let runs = 0;
  return {
    get runs() {
      return runs;
    },
    make: (): Promise<SoundPack> => {
      runs++;
      return Promise.resolve({
        files: [{
          path: "assets/sounds/se_decision.adp",
          data: encoder.encode(`${label} ${runs}`),
        }],
        keys: ["se_decision"],
        notes: [`${label}: made ${runs}`],
      });
    },
  };
}

Deno.test("a sound pack is made once and reused while nothing that makes it moves", async () => {
  const { gameDir, cacheDir } = await soundTree();
  const sfx = maker("sfx");
  const first = await cachedSoundPack(cacheDir, "sfx", gameDir, {}, sfx.make);
  assertEquals(first.reused, false);
  const again = await cachedSoundPack(cacheDir, "sfx", gameDir, {}, sfx.make);
  assertEquals(again.reused, true);
  assertEquals(sfx.runs, 1);
  // The very pack the first build made: files, keys and its notes for the log.
  assertEquals(again.pack, first.pack);

  // The music keeps a pack of its own.
  const bgm = maker("bgm");
  await cachedSoundPack(cacheDir, "bgm", gameDir, {}, bgm.make);
  assertEquals(bgm.runs, 1);
  assertEquals(
    (await cachedSoundPack(cacheDir, "sfx", gameDir, {}, sfx.make)).reused,
    true,
  );
});

Deno.test("a changed source, a new one or other settings make the pack again", async () => {
  const { gameDir, cacheDir } = await soundTree();
  const sfx = maker("sfx");
  const run = (settings = {}) =>
    cachedSoundPack(cacheDir, "sfx", gameDir, settings, sfx.make);
  await run();

  const source = join(gameDir, "assets", "sounds", "ui", "se_decision.mp3");
  await Deno.writeTextFile(source, "a longer take");
  assertEquals((await run()).reused, false);

  await Deno.writeTextFile(join(gameDir, "assets", "sounds", "new.wav"), "x");
  assertEquals((await run()).reused, false);

  assertEquals((await run({ budgetBytes: 2048 })).reused, false);
  assertEquals((await run({ budgetBytes: 2048 })).reused, true);
  assertEquals(sfx.runs, 4);
});

Deno.test("a host without ffmpeg keeps nothing, so the next build tries again", async () => {
  const { gameDir, cacheDir } = await soundTree();
  const none = await cachedSoundPack(
    cacheDir,
    "sfx",
    gameDir,
    {},
    () => Promise.resolve(null),
  );
  assertEquals(none, { pack: null, reused: false });
  const sfx = maker("sfx");
  assertEquals(
    (await cachedSoundPack(cacheDir, "sfx", gameDir, {}, sfx.make)).reused,
    false,
  );
});

// --- the level -------------------------------------------------------------

const GS = { name: "gs", enemylist: [["00"]], savedAt: 1 };

/** A stand-in for Firebase that records what it was asked. */
function firebase(
  answer: (headers: Headers) => Response | Promise<Response>,
) {
  const asked: Headers[] = [];
  const urls: string[] = [];
  const fetcher = ((url: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    asked.push(headers);
    urls.push(String(url));
    return Promise.resolve(answer(headers));
  }) as typeof fetch;
  return { asked, urls, fetcher };
}

const quiet = () => {};

Deno.test("an unchanged level is revalidated, not downloaded again", async () => {
  const cacheDir = await Deno.makeTempDir({ prefix: "shmupx-level-" });
  const fb = firebase((headers) =>
    headers.get("If-None-Match") === "tag-1"
      ? new Response(null, { status: 304 })
      : Response.json(GS, { headers: { ETag: "tag-1" } })
  );
  assertEquals(await fetchLevelRecord("gs", cacheDir, quiet, fb.fetcher), GS);
  assertEquals(fb.asked[0].get("X-Firebase-ETag"), "true");
  assertEquals(fb.asked[0].get("If-None-Match"), null);
  // shmupX's own copy of the level, never the root one, which is cmg's.
  assert(fb.urls[0].endsWith("/shmupX/levels/gs.json"), fb.urls[0]);

  const said: string[] = [];
  const again = await fetchLevelRecord(
    "gs",
    cacheDir,
    (m) => said.push(m),
    fb.fetcher,
  );
  assertEquals(again, GS);
  assertEquals(fb.asked[1].get("If-None-Match"), "tag-1");
  assert(said.some((m) => m.includes("unchanged since the last build")));
});

Deno.test("a level that changed is downloaded and kept in place of the old copy", async () => {
  const cacheDir = await Deno.makeTempDir({ prefix: "shmupx-level-" });
  let version = 1;
  const fb = firebase((headers) =>
    headers.get("If-None-Match") === `tag-${version}`
      ? new Response(null, { status: 304 })
      : Response.json({ ...GS, savedAt: version }, {
        headers: { ETag: `tag-${version}` },
      })
  );
  await fetchLevelRecord("gs", cacheDir, quiet, fb.fetcher);
  version = 2; // saved again in the editor
  const fresh = await fetchLevelRecord("gs", cacheDir, quiet, fb.fetcher);
  assertEquals((fresh as { savedAt?: number } | null)?.savedAt, 2);
  // And it is the new copy that is kept.
  await fetchLevelRecord("gs", cacheDir, quiet, fb.fetcher);
  assertEquals(fb.asked[2].get("If-None-Match"), "tag-2");
});

Deno.test("without Firebase the kept copy is used, and said to be", async () => {
  const cacheDir = await Deno.makeTempDir({ prefix: "shmupx-level-" });
  const online = firebase(() =>
    Response.json(GS, { headers: { ETag: "tag-1" } })
  );
  await fetchLevelRecord("gs", cacheDir, quiet, online.fetcher);

  for (
    const offline of [
      firebase(() => Promise.reject(new TypeError("connection reset"))),
      firebase(() => new Response("busy", { status: 503 })),
    ]
  ) {
    const said: string[] = [];
    const record = await fetchLevelRecord(
      "gs",
      cacheDir,
      (m) => said.push(m),
      offline.fetcher,
    );
    assertEquals(record, GS);
    assert(said.some((m) => m.includes("using the copy from")), said.join());
  }

  // With nothing kept, there is nothing to fall back on.
  const empty = await Deno.makeTempDir({ prefix: "shmupx-level-" });
  await assertRejects(() =>
    fetchLevelRecord(
      "gs",
      empty,
      quiet,
      firebase(() => Promise.reject(new TypeError("offline"))).fetcher,
    )
  );
});
