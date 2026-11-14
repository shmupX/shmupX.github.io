// A stage's music, picked by how long the stage runs.
//
// 2028.Ai's music was a 21-minute recording transcribed onto the Dezaemon 2
// tone bank. It is a recording again, in three cuts: one for a stage of about
// a minute, one for a stage of two minutes or more, one for four or more. A
// level's customAudioURLs names them by length rather than by boss —
// stage_bgm, stage_bgm_2min, stage_bgm_4min — and the runtime
// (game.bundle.js, a vendored artifact patched by hand — README) plays each
// stage the longest one it fills, from the top, and downloads only the cuts
// some stage of the game will play. title_bgm is the title's, the hidden
// boss has a theme of his own, and boss<N>_bgm is the fight with
// stage N's boss, which takes over from the stage's music as he arrives.
//
// The helpers are run out of the real bundle; the database script
// (scripts/2028-ai/stage-bgm.ts) runs against a stand-in, never the real one.

import { assert, assertEquals, assertRejects } from "@std/assert";
import { setDatabaseUrl } from "../mcp/lib/rtdb.ts";
import {
  apply,
  plan,
  revert,
  SOUNDTRACK,
  toneBank,
} from "../scripts/2028-ai/stage-bgm.ts";

const BUNDLE = "static/games/2028-ai/game.bundle.js";
const LOADER = "static/phaser-plugins/level-loader.js";

const read = async (p: string) =>
  (await Deno.readTextFile(new URL(`../${p}`, import.meta.url)))
    .replaceAll("\r\n", "\n");

/** One top-level function of the bundle's IIFE, by name, as source text. */
function functionSource(js: string, name: string): string {
  const start = js.indexOf(`\n  function ${name}(`);
  assert(start >= 0, `no ${name} in ${BUNDLE}`);
  const end = js.indexOf("\n  }\n", start);
  assert(end > start, `${name} does not close`);
  return js.slice(start, end + 4);
}

/** One `var NAME = ...;` line of the bundle's IIFE. */
function constSource(js: string, name: string): string {
  const m = new RegExp(`\\n  var ${name} = [^\\n]+;\\n`).exec(js);
  assert(m, `no ${name} in ${BUNDLE}`);
  return m[0];
}

type Recipe = Record<string, unknown>;
interface Helpers {
  stageRunSeconds(recipe: Recipe | null, stageId: number): number;
  stageBgmMinutes(key: string): number;
  stageBgmTrack(keys: string[], seconds: number): string | null;
  stagePlaysAudioKey(key: string, recipe: Recipe, keys: string[]): boolean;
}

async function helpers(): Promise<Helpers> {
  const js = await read(BUNDLE);
  const names = [
    "clampStageId",
    "recipeStageIds",
    "stageRunSeconds",
    "stageBgmMinutes",
    "stageBgmTrack",
    "stagePlaysAudioKey",
  ];
  const consts = [
    "MAX_STAGE_ID",
    "SATURN_TICKS_PER_FRAME",
    "STAGE_TICKS_PER_SECOND",
    "STAGE_WAVE_TICKS",
    "STAGE_BOSS_SECONDS",
    "STAGE_BGM_KEY",
  ];
  return new Function(
    consts.map((c) => constSource(js, c)).join("") +
      names.map((n) => functionSource(js, n)).join("") +
      "\nreturn { stageRunSeconds, stageBgmMinutes, stageBgmTrack, stagePlaysAudioKey };",
  )() as Helpers;
}

const rows = (n: number) => Array.from({ length: n }, () => ["00"]);
const TRACKS = Object.keys(SOUNDTRACK);

Deno.test("a stage runs its wave list at 80 ticks a row, and half a minute of boss", async () => {
  const h = await helpers();
  const boss = { bossData: { boss0: { hp: 100 } } };
  // 120 ticks a second: 45 rows are 30 seconds.
  assertEquals(h.stageRunSeconds({ stage0: { enemylist: rows(45) } }, 0), 30);
  assertEquals(
    h.stageRunSeconds({ stage0: { enemylist: rows(45) }, ...boss }, 0),
    60,
  );
  // Only the stage asked about, and only its own boss.
  assertEquals(
    h.stageRunSeconds({ stage1: { enemylist: rows(90) }, ...boss }, 1),
    60,
  );
  assertEquals(h.stageRunSeconds({ stage0: { enemylist: [] } }, 0), 0);
  assertEquals(h.stageRunSeconds({}, 3), 0);
  assertEquals(h.stageRunSeconds(null, 0), 0);
  // An import's rows stand on its scroll: the last row's number, at its own
  // frames a row, two ticks a Saturn frame.
  assertEquals(
    h.stageRunSeconds({
      stage0: {
        enemylist: rows(3),
        waveRows: [900, 40, 10],
        waveInterval: 8,
      },
    }, 0),
    900 * 8 * 2 / 120,
  );
});

Deno.test("2028.Ai's own five stages each run about a minute", async () => {
  const h = await helpers();
  const base = JSON.parse(await read("static/games/2028-ai/assets/game.json"));
  const seconds = [0, 1, 2, 3, 4].map((id) =>
    Math.round(h.stageRunSeconds(base, id))
  );
  assertEquals(seconds, [61, 57, 50, 55, 56]);
});

Deno.test("a key says from what length it plays", async () => {
  const h = await helpers();
  assertEquals(h.stageBgmMinutes("stage_bgm"), 0);
  assertEquals(h.stageBgmMinutes("stage_bgm_2min"), 2);
  assertEquals(h.stageBgmMinutes("stage_bgm_4min"), 4);
  assertEquals(h.stageBgmMinutes("stage_bgm_10min"), 10);
  for (
    const key of [
      "boss_bison_bgm",
      "title_bgm",
      "stage_bgm_",
      "stage_bgm_2",
      "stage_bgm_min",
      "my_stage_bgm",
      "stage_bgm_2min_b",
    ]
  ) {
    assertEquals(h.stageBgmMinutes(key), -1, key);
  }
});

Deno.test("a stage plays the longest cut it fills", async () => {
  const h = await helpers();
  const pick = (seconds: number) => h.stageBgmTrack(TRACKS, seconds);
  assertEquals(pick(0), "stage_bgm");
  assertEquals(pick(61), "stage_bgm");
  assertEquals(pick(119.9), "stage_bgm");
  assertEquals(pick(120), "stage_bgm_2min");
  assertEquals(pick(239.9), "stage_bgm_2min");
  assertEquals(pick(240), "stage_bgm_4min");
  assertEquals(pick(3600), "stage_bgm_4min");
  // Whatever order the keys come in.
  assertEquals(h.stageBgmTrack([...TRACKS].reverse(), 130), "stage_bgm_2min");
  // A level that names no stage track keeps its themes.
  assertEquals(h.stageBgmTrack(["boss_bison_bgm", "title_bgm"], 500), null);
  // One that names only a long cut plays it on its long stages alone.
  assertEquals(h.stageBgmTrack(["stage_bgm_4min"], 100), null);
  assertEquals(h.stageBgmTrack(["stage_bgm_4min"], 300), "stage_bgm_4min");
});

Deno.test("the loader is told to fetch only the cuts some stage plays", async () => {
  const h = await helpers();
  const boss = { boss0: {}, boss1: {} };
  const wanted = (recipe: Recipe) =>
    TRACKS.filter((k) => h.stagePlaysAudioKey(k, recipe, TRACKS));
  const always = TRACKS.filter((k) => h.stageBgmMinutes(k) < 0);
  // 2028.Ai itself: every stage about a minute, so neither longer cut.
  const base = JSON.parse(await read("static/games/2028-ai/assets/game.json"));
  assertEquals(wanted(base), [...always, "stage_bgm"].sort());
  // A two-minute stage beside a short one: the first two cuts.
  assertEquals(
    wanted({
      stage0: { enemylist: rows(46) },
      stage1: { enemylist: rows(135) },
      bossData: boss,
    }),
    [...always, "stage_bgm", "stage_bgm_2min"].sort(),
  );
  // One four-minute stage: its cut alone, not the ones it outgrew.
  assertEquals(
    wanted({ stage0: { enemylist: rows(315) }, bossData: boss }),
    [...always, "stage_bgm_4min"].sort(),
  );
  // A sound that is not a stage track is none of this function's business.
  assert(h.stagePlaysAudioKey("voice_titlecall", {}, TRACKS));
});

Deno.test("2028.Ai's baked record names the soundtrack, and no tone-bank one", async () => {
  const foo = JSON.parse(await read("static/games/2028-ai/foo.json"));
  for (const [key, url] of Object.entries(SOUNDTRACK)) {
    assertEquals(foo.customAudioURLs[key], url, key);
  }
  assertEquals(SOUNDTRACK.stage_bgm, "https://easierbycode.com/1.mp3");
  assertEquals(SOUNDTRACK.stage_bgm_2min, "https://easierbycode.com/2.mp3");
  assertEquals(SOUNDTRACK.stage_bgm_4min, "https://easierbycode.com/4.mp3");
  // The title plays the four-minute cut.
  assertEquals(SOUNDTRACK.title_bgm, SOUNDTRACK.stage_bgm_4min);
  // The hidden boss has Diamond Eyes, whatever the stage's length.
  assertEquals(
    SOUNDTRACK.boss_goki_bgm,
    "https://easierbycode.com/diamond-eyes.mp3",
  );
  // The third boss, and only he, has a track of his own.
  assertEquals(SOUNDTRACK.boss2_bgm, "https://easierbycode.com/boss.mp3");
  assertEquals(
    Object.keys(foo.customAudioURLs).filter((k) => /^boss\d+_bgm$/.test(k)),
    ["boss2_bgm"],
  );
  // Every music entry of the record is one the script writes.
  for (const [key, url] of Object.entries(foo.customAudioURLs)) {
    if (/bgm/.test(key)) assert(key in SOUNDTRACK, key + ": " + url);
  }
  assertEquals(foo.dezaemonBgm, undefined);
});

Deno.test("the game scene plays the stage track, starts it over each stage, and gives the hidden boss his own", async () => {
  const js = await read(BUNDLE);
  const flat = js.replace(/\s+/g, " ");
  // The stage's music is asked for by length first, its theme as the fallback.
  assert(
    flat.includes(
      'var key = stageBgmKey(this, stageId, "boss_" + name + "_bgm");',
    ),
    "playBossBgm does not ask for the stage track",
  );
  assert(
    flat.includes(
      "return stageBgmTrack(keys, seconds) || themeKey;",
    ),
    "stageBgmKey does not fall back on the theme",
  );
  // Only what the level loaded can be picked.
  assert(
    functionSource(js, "stageBgmKey").includes(
      "keys = scene.cache.audio.getKeys();",
    ),
  );
  // A theme two stages share still pauses and resumes; a stage track does not.
  assert(
    flat.includes(
      "var sameBgm = stageBgmMinutes(nextKey) < 0 && sameBgmTrack(currentKey, nextKey);",
    ),
    "a stage track carries over into the next stage",
  );
  // Akuma's arrival swaps to his theme, from a stage track as from a stage
  // theme, unless his is the very track already playing.
  assert(
    flat.includes(
      'if (!scene._dezaBgm && !sameBgmTrack(scene.stageBgmName, "boss_goki_bgm")) {',
    ),
    "the hidden boss restarts a track he shares with the stage",
  );
  assert(
    flat.includes(
      'scene.stageBgmName = "boss_goki_bgm"; scene.playBgm("boss_goki_bgm", 0.4);',
    ),
    "the hidden boss does not play his own theme",
  );
});

Deno.test("sameBgmTrack: one key, or two keys the level gave one source", async () => {
  const js = await read(BUNDLE);
  const same = new Function(
    "gameState",
    functionSource(js, "sameBgmTrack") + "\nreturn sameBgmTrack;",
  )({
    bgmSourceURLs: {
      boss_bison_bgm: "https://example.com/a.mp3",
      boss_barlog_bgm: "https://example.com/a.mp3",
      boss_sagat_bgm: "https://example.com/b.mp3",
    },
  }) as (a: string, b: string) => boolean;
  assert(same("boss_bison_bgm", "boss_barlog_bgm"));
  assertEquals(same("boss_bison_bgm", "boss_sagat_bgm"), false);
  // Stock themes have no source in the map: two of them are two tracks.
  assertEquals(same("boss_vega_bgm", "boss_goki_bgm"), false);
  assert(same("stage_bgm", "stage_bgm"));
  // 2028.Ai's hidden boss: his theme, Diamond Eyes, is no stage's cut, so it
  // takes over from whichever cut the stage plays.
  const foo = new Function(
    "gameState",
    functionSource(js, "sameBgmTrack") + "\nreturn sameBgmTrack;",
  )({ bgmSourceURLs: SOUNDTRACK }) as (a: string, b: string) => boolean;
  assertEquals(foo("stage_bgm", "boss_goki_bgm"), false);
  assertEquals(foo("stage_bgm_2min", "boss_goki_bgm"), false);
  assertEquals(foo("stage_bgm_4min", "boss_goki_bgm"), false);
  assertEquals(same("", ""), false);
  assertEquals(same("boss_bison_bgm", ""), false);
});

Deno.test("a boss with a track of his own takes the music over as he arrives", async () => {
  const js = await read(BUNDLE);
  const flat = js.replace(/\s+/g, " ");
  // Asked once the stage is known to have a boss, before he is built.
  assert(
    flat.includes(
      "if (!bossData) { scene.stageClear(); return; } " +
        "// His own music, where the level names one for this stage's boss. " +
        "playBossFightBgm(scene, stageId);",
    ),
    "bossAdd does not start the boss's own music",
  );
  const run = (
    opts: {
      stageId: number;
      playing: string;
      toneBank?: boolean;
      lowMode?: boolean;
      urls?: Record<string, string>;
    },
  ) => {
    const log: string[] = [];
    const cached = new Set(["boss2_bgm", "stage_bgm"]);
    const scene = {
      _dezaBgm: opts.toneBank ? {} : null,
      stageBgmName: opts.playing,
      cache: { audio: { exists: (k: string) => cached.has(k) } },
      sound: {
        get: (k: string) => ({
          isPlaying: true,
          stop: () => log.push("stop " + k),
        }),
      },
      playBgm: (k: string, v: number) => log.push("play " + k + " " + v),
    };
    const took = new Function(
      "scene",
      "stageId",
      "gameState",
      functionSource(js, "sameBgmTrack") +
        functionSource(js, "playBossFightBgm") +
        "\nreturn playBossFightBgm(scene, stageId);",
    )(scene, opts.stageId, {
      lowModeFlg: !!opts.lowMode,
      bgmSourceURLs: opts.urls ?? SOUNDTRACK,
    }) as boolean;
    return { took, log, now: scene.stageBgmName };
  };
  // The third boss: the stage's track stops and his starts.
  assertEquals(run({ stageId: 2, playing: "stage_bgm" }), {
    took: true,
    log: ["stop stage_bgm", "play boss2_bgm 0.4"],
    now: "boss2_bgm",
  });
  // Any other boss keeps the stage's music.
  for (const stageId of [0, 1, 3, 4]) {
    assertEquals(run({ stageId, playing: "stage_bgm" }), {
      took: false,
      log: [],
      now: "stage_bgm",
    });
  }
  // A tone-bank soundtrack has its own boss slot, and low mode has no music.
  assertEquals(
    run({ stageId: 2, playing: "__dezaemon__", toneBank: true }).took,
    false,
  );
  assertEquals(
    run({ stageId: 2, playing: "stage_bgm", lowMode: true }).log,
    [],
  );
  // Where the stage is on his very track already, it plays on.
  assertEquals(
    run({
      stageId: 2,
      playing: "stage_bgm",
      urls: { stage_bgm: "https://x/a.mp3", boss2_bgm: "https://x/a.mp3" },
    }),
    { took: false, log: [], now: "stage_bgm" },
  );
});

Deno.test("the title plays title_bgm where the level has no title tape", async () => {
  const js = await read(BUNDLE);
  const flat = js.replace(/\s+/g, " ");
  assert(
    flat.includes(
      'if (!startDezaemonBgm(this, "title")) playTitleBgm(this);',
    ),
    "the title does not play its track",
  );
  assert(
    flat.includes('this.events.once("shutdown", () => stopTitleBgm(this));'),
    "the title's track outlives the title",
  );
  const played: { key: string; config: { loop: boolean } }[] = [];
  const stopped: string[] = [];
  const run = (cached: boolean) => {
    const sound = {
      isPlaying: false,
      play(config: { loop: boolean }) {
        played.push({ key: "title_bgm", config });
        this.isPlaying = true;
      },
      stop() {
        stopped.push("title_bgm");
        this.isPlaying = false;
      },
    };
    const scene = {
      cache: { audio: { exists: (k: string) => cached && k === "title_bgm" } },
      sound: { get: () => null, add: () => sound },
    };
    return new Function(
      "scene",
      constSource(js, "TITLE_BGM_KEY") +
        "var cmgBgmVol = function(v) { return v; };" +
        functionSource(js, "playTitleBgm") +
        "\nreturn playTitleBgm(scene);",
    )(scene) as boolean;
  };
  assertEquals(run(false), false);
  assertEquals(played.length, 0);
  assertEquals(run(true), true);
  assertEquals(played.length, 1);
  assertEquals(played[0].config.loop, true);
});

Deno.test("the level loader — the plugin and the bundle's inlined copy — skips a track the game will not play", async () => {
  for (const path of [LOADER, BUNDLE]) {
    const flat = (await read(path)).replace(/\s+/g, " ");
    assert(
      flat.includes(
        'if (typeof opts.wants === "function" && !opts.wants(uKey, recipe, allKeys)) continue;',
      ),
      path + ": every custom track is downloaded",
    );
    // Named all the same, for whoever lists the level's music: the source
    // map is filled in before the skip.
    assert(
      flat.includes(
        "sourceURLs[uKey] = uUrl; // A track the game says it will not play",
      ),
      path + ": a skipped track is left out of the level's music",
    );
    assert(
      flat.includes("this._loadAudio(data, o.audio, o.lowMode, recipe),"),
      path + ": the loader is not handed the merged recipe",
    );
    assert(
      flat.includes(
        "const sourceURLs = this._queueAudioOverrides(levelData, opts, recipe);",
      ),
      path,
    );
  }
  const bundle = await read(BUNDLE);
  assert(
    bundle.includes(
      "audio: { stockPaths: RESOURCE_PATHS, wants: stagePlaysAudioKey },",
    ),
    "the game does not tell the loader which tracks it plays",
  );
});

// ---- The database record -------------------------------------------------

type Tree = Record<string, unknown>;

/** A stable stamp for a node's current value; RTDB's ETag plays this part. */
function stamp(node: unknown): string {
  const text = JSON.stringify(node ?? null);
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = (h * 33) ^ text.charCodeAt(i);
  return (h >>> 0).toString(36);
}

/** Just enough RTDB REST: GET/PUT on <node>.json, with ETags; null deletes. */
function fakeDb(seed: Tree) {
  const root: Tree = structuredClone(seed);
  const segments = (pathname: string) =>
    pathname.slice(0, -".json".length).split("/").filter(Boolean).map(
      decodeURIComponent,
    );
  const read = (path: string[]): unknown =>
    path.reduce<unknown>(
      (node, key) =>
        node && typeof node === "object" ? (node as Tree)[key] : undefined,
      root,
    ) ?? null;
  const write = (path: string[], value: unknown) => {
    let node = root;
    for (const key of path.slice(0, -1)) {
      if (!node[key] || typeof node[key] !== "object") node[key] = {};
      node = node[key] as Tree;
    }
    if (value === null) delete node[path[path.length - 1]];
    else node[path[path.length - 1]] = value;
  };
  const server = Deno.serve({ port: 0, onListen() {} }, async (req) => {
    const path = segments(new URL(req.url).pathname);
    if (req.method === "GET") {
      const node = read(path);
      const headers: Record<string, string> = {};
      if (req.headers.get("x-firebase-etag") === "true") {
        headers.etag = stamp(node);
      }
      return Response.json(node, { headers });
    }
    if (req.method === "PUT") {
      const expected = req.headers.get("if-match");
      if (expected !== null && expected !== stamp(read(path))) {
        return new Response("precondition failed", { status: 412 });
      }
      write(path, await req.json());
      return Response.json(null);
    }
    return new Response("unsupported", { status: 405 });
  });
  const { port } = server.addr as Deno.NetAddr;
  return {
    url: `http://127.0.0.1:${port}`,
    read: (path: string) => read(path.split("/")),
    write: (path: string, value: unknown) => write(path.split("/"), value),
    close: () => server.shutdown(),
  };
}

async function withDb(
  seed: Tree,
  run: (db: ReturnType<typeof fakeDb>) => Promise<void>,
) {
  const db = fakeDb(seed);
  setDatabaseUrl(db.url);
  try {
    await run(db);
  } finally {
    setDatabaseUrl(null);
    await db.close();
  }
}

const VOICES = {
  boss_vega_voice_projectile:
    "https://easierbycode.com/assets/sounds/tunotoru44.mp3",
  voice_titlecall: "https://easierbycode.com/assets/sounds/title_voicecall.mp3",
};
const FOO = "shmupX/levels/foo";

Deno.test("the kept tone-bank soundtrack is the one piece the record carried", async () => {
  const kept = await toneBank() as {
    songs: string[];
    sequence: number[];
    special: number[];
    stages: number[][];
  };
  assertEquals(kept.songs.length, 21);
  assertEquals(kept.sequence, Array.from({ length: 21 }, (_, i) => i));
  assertEquals(kept.special, [0, 21, 21, 20]);
  assertEquals(kept.stages.length, 5);
});

Deno.test("--apply swaps the tone-bank soundtrack for the recording, and only once", async () => {
  const kept = await toneBank();
  await withDb({
    shmupX: {
      levels: {
        foo: { name: "foo", customAudioURLs: VOICES, dezaemonBgm: kept },
      },
    },
    // cmg's root-level copy, which nothing here may touch.
    levels: { foo: { dezaemonBgm: kept } },
  }, async (db) => {
    const p = await plan();
    assertEquals(p.state, "the tone-bank soundtrack");
    assertEquals(p.missing, Object.keys(SOUNDTRACK));
    // A dry run is a read.
    assertEquals(db.read(`${FOO}/customAudioURLs`), VOICES);

    const written = await apply(p);
    assertEquals(written, [`${FOO}/customAudioURLs`, `${FOO}/dezaemonBgm`]);
    assertEquals(db.read(`${FOO}/customAudioURLs`), {
      ...VOICES,
      ...SOUNDTRACK,
    });
    assertEquals(db.read(`${FOO}/dezaemonBgm`), null);
    assert(typeof db.read(`${FOO}/savedAt`) === "number");
    assertEquals(db.read("levels/foo/dezaemonBgm"), kept);

    const again = await plan();
    assertEquals(again.state, "already as planned");
    assertEquals(await apply(again), []);
  });
});

Deno.test("--revert puts the tone-bank soundtrack back and leaves another's entry alone", async () => {
  const kept = await toneBank();
  await withDb({
    shmupX: { levels: { foo: { customAudioURLs: VOICES, dezaemonBgm: kept } } },
  }, async (db) => {
    await apply(await plan());
    // Someone has since pointed a stage's theme elsewhere.
    db.write(`${FOO}/customAudioURLs/boss_fang_bgm`, "https://example.com/x");

    const written = await revert();
    assertEquals(written, [`${FOO}/customAudioURLs`, `${FOO}/dezaemonBgm`]);
    assertEquals(db.read(`${FOO}/customAudioURLs`), {
      ...VOICES,
      boss_fang_bgm: "https://example.com/x",
    });
    assertEquals(db.read(`${FOO}/dezaemonBgm`), kept);
    // Run again, it writes nothing.
    assertEquals(await revert(), []);
  });
});

Deno.test("--apply refuses a soundtrack --revert could not put back, and a raced save", async () => {
  const kept = await toneBank() as Tree;
  const edited = { ...kept, sfxSet: 2 };
  await withDb({
    shmupX: {
      levels: { foo: { customAudioURLs: VOICES, dezaemonBgm: edited } },
    },
  }, async (db) => {
    const p = await plan();
    assertEquals(p.state, "another tone-bank soundtrack");
    await assertRejects(() => apply(p), Error, "--force");
    assertEquals(db.read(`${FOO}/dezaemonBgm`), edited);
    assertEquals(db.read(`${FOO}/customAudioURLs`), VOICES);
    await assertRejects(() => revert(), Error, "--force");

    await apply(p, { force: true });
    assertEquals(db.read(`${FOO}/dezaemonBgm`), null);
  });
  await withDb({
    shmupX: { levels: { foo: { customAudioURLs: VOICES, dezaemonBgm: kept } } },
  }, async (db) => {
    const p = await plan();
    // The editor saves the level between the read and the write.
    db.write(`${FOO}/customAudioURLs/voice_ko`, "https://example.com/ko");
    await assertRejects(() => apply(p), Error, "ETag");
    assertEquals(db.read(`${FOO}/dezaemonBgm`), kept);
  });
});

Deno.test("a record with no soundtrack at all gets the recording", async () => {
  await withDb({ shmupX: { levels: { foo: { name: "foo" } } } }, async (db) => {
    const p = await plan();
    assertEquals(p.state, "no soundtrack");
    assertEquals(await apply(p), [`${FOO}/customAudioURLs`]);
    assertEquals(db.read(`${FOO}/customAudioURLs`), { ...SOUNDTRACK });
  });
});
