// Loop 2: the runs after one that beat a game's bonus level.
//
// foo names RonaGun (hellophaser) as its secret level, the bonus level that
// plays after its ending. A run that beats it puts the game on loop 2 for
// good in that browser, and loop 2 unlocks a new track: 2028.Ai's stage
// music, stage_bgm (1.mp3), gives way to stage_bgm_loop2 (bgm.mp3) from the
// next run on. The track is fetched behind the game once the loop is on,
// never with the level, and the launcher's Guide is told so it can offer it
// (tests/osd_bgm_test.ts has that end).
//
// The helpers are run out of the real bundle (game.bundle.js, a vendored
// artifact patched by hand — README), over stand-ins for the browser.

import { assert, assertEquals } from "@std/assert";
import { SOUNDTRACK } from "../scripts/2028-ai/stage-bgm.ts";

const BUNDLE = "static/games/2028-ai/game.bundle.js";

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

const BGM_1 = "https://easierbycode.com/1.mp3";
const BGM_LOOP2 = "https://easierbycode.com/bgm.mp3";

type State = Record<string, unknown>;

/** A localStorage with nothing behind it but a Map. */
function fakeStorage(seed: Record<string, string> = {}) {
  const kept = new Map(Object.entries(seed));
  return {
    kept,
    getItem: (k: string) => kept.has(k) ? kept.get(k)! : null,
    setItem: (k: string, v: string) => void kept.set(k, String(v)),
  };
}

interface Loop2 {
  isLoop2BgmKey(key: string): boolean;
  loop1BgmKey(key: string): string;
  readLoop2Games(): string[];
  loop2BgmKey(keys: string[], key: string): string;
  loop2BgmURLs(): Record<string, string>;
  syncLoop2(game: unknown): void;
  unlockLoop2(game: unknown): boolean;
  beatBonusLevel(recipe: unknown): boolean;
  stageBgmKey(scene: unknown, stageId: number, theme: string): string;
  loop2TakeOver(game: unknown, key: string): boolean;
}

/** The stage scene, as loop2TakeOver reads it, and what it was told. */
function fakeStage(
  opts: { playing?: string; isPlaying?: boolean; cleared?: boolean } = {},
) {
  const log: string[] = [];
  const key = opts.playing ?? "stage_bgm";
  const scene = {
    sys: { settings: { active: true } },
    stageCleared: !!opts.cleared,
    stageBgmName: key,
    sound: {
      get: (k: string) =>
        k === key
          ? {
            isPlaying: opts.isPlaying ?? true,
            __cmgBgmBase: 0.4,
            stop: () => log.push("stop " + k),
          }
          : null,
    },
    playBgm: (k: string, v: number) => log.push("play " + k + " " + v),
  };
  return { scene, log };
}

/** A game with a Web Audio context and an audio cache, for loadLoop2Bgm. */
function fakeGame(
  manifest: Record<string, string> = {},
  stage: unknown = null,
) {
  const cache = new Map<string, unknown>();
  return {
    scene: { getScene: () => stage },
    cache: {
      audio: {
        exists: (k: string) => cache.has(k),
        add: (k: string, v: unknown) => void cache.set(k, v),
        getKeys: () => [...cache.keys()],
      },
      json: {
        exists: (k: string) => k === "custom-bgm-manifest",
        get: () => manifest,
      },
    },
    sound: {
      context: {
        decodeAudioData: (bytes: ArrayBuffer) =>
          Promise.resolve({ decoded: new TextDecoder().decode(bytes) }),
      },
    },
    audio: cache,
  };
}

async function load(
  opts: {
    state?: State;
    storage?: ReturnType<typeof fakeStorage>;
    embedded?: boolean;
    files?: Record<string, string>;
  } = {},
) {
  const js = await read(BUNDLE);
  const state: State = {
    gameId: "foo",
    lowModeFlg: false,
    shortFlg: false,
    bgmSourceURLs: { stage_bgm: BGM_1, stage_bgm_loop2: BGM_LOOP2 },
    ...opts.state,
  };
  const storage = opts.storage ?? fakeStorage();
  const posted: unknown[] = [];
  const parent = { postMessage: (m: unknown) => posted.push(m) };
  const win: { parent: unknown } = { parent };
  if (opts.embedded === false) win.parent = win;
  const fetched: string[] = [];
  const files = opts.files ?? { [BGM_LOOP2]: "bgm" };
  const fetchStub = (url: string) => {
    fetched.push(url);
    const body = files[url];
    return Promise.resolve(
      body === undefined
        ? new Response("missing", { status: 404 })
        : new Response(body),
    );
  };
  const document = {
    getElementById: (id: string) =>
      id === "baseUrl" ? { textContent: " /games/2028-ai/ " } : null,
  };
  const DEFAULTS = {
    audio: {
      customBgmDir: "assets/custom-bgm/",
      manifestKey: "custom-bgm-manifest",
      baseUrlElementId: "baseUrl",
    },
  };
  const consts = [
    "MAX_STAGE_ID",
    "SATURN_TICKS_PER_FRAME",
    "STAGE_TICKS_PER_SECOND",
    "STAGE_WAVE_TICKS",
    "STAGE_BOSS_SECONDS",
    "STAGE_BGM_KEY",
    "LOOP2_BGM_SUFFIX",
    "LOOP2_STORAGE_KEY",
    "loop2BgmLoading",
  ];
  const names = [
    "customBgmFileName",
    "clampStageId",
    "secretSpan",
    "recipeStageIds",
    "stageRunSeconds",
    "stageBgmMinutes",
    "stageBgmTrack",
    "recipeData",
    "stageBgmKey",
    "isLoop2BgmKey",
    "loop1BgmKey",
    "readLoop2Games",
    "onLoop2",
    "loop2BgmKey",
    "loop2BgmURLs",
    "cmgAnnounceLoop2Bgm",
    "loadLoop2Bgm",
    "syncLoop2",
    "unlockLoop2",
    "beatBonusLevel",
    "loop2TakeOver",
  ];
  const api = new Function(
    "gameState",
    "localStorage",
    "window",
    "fetch",
    "document",
    "DEFAULTS",
    "console",
    "SECRET_AUDIO_PREFIX",
    consts.map((c) => constSource(js, c)).join("") +
      names.map((n) => functionSource(js, n)).join("") +
      "\nreturn { " + names.join(", ") + " };",
  )(
    state,
    storage,
    win,
    fetchStub,
    document,
    DEFAULTS,
    { warn: () => {} },
    "secret:",
  ) as Loop2 & { customBgmFileName(url: string): string };
  return { api, state, storage, posted, fetched };
}

const settle = () => new Promise((r) => setTimeout(r, 10));

Deno.test("a loop-2 key names the key it stands in for", async () => {
  const { api } = await load();
  assert(api.isLoop2BgmKey("stage_bgm_loop2"));
  assert(api.isLoop2BgmKey("title_bgm_loop2"));
  for (const k of ["stage_bgm", "_loop2", "stage_bgm_loop", "loop2_bgm"]) {
    assertEquals(api.isLoop2BgmKey(k), false, k);
  }
  assertEquals(api.loop1BgmKey("stage_bgm_loop2"), "stage_bgm");
  assertEquals(api.loop1BgmKey("stage_bgm"), "stage_bgm");
  assertEquals(api.loop1BgmKey("boss_goki_bgm"), "boss_goki_bgm");
});

Deno.test("2028.Ai's loop 2 unlocks bgm.mp3, in 1.mp3's place", async () => {
  assertEquals(SOUNDTRACK.stage_bgm, BGM_1);
  assertEquals(SOUNDTRACK.stage_bgm_loop2, BGM_LOOP2);
  const foo = JSON.parse(await read("static/games/2028-ai/foo.json"));
  assertEquals(foo.customAudioURLs.stage_bgm_loop2, BGM_LOOP2);
  assertEquals(foo.customAudioURLs.stage_bgm, BGM_1);
  // The loop is reachable: foo has a bonus level to beat.
  assertEquals(foo.secretLevel, "hellophaser");
});

Deno.test("on loop 2 a stage plays the loop-2 track, once it has landed", async () => {
  const recipe = {
    stage0: { enemylist: [["00"]] },
    stage4: { enemylist: [["00"]] },
    stage5: { enemylist: [["00"]] },
    secretLevel: {
      first: 5,
      count: 1,
      stages: [0],
      audioKeys: ["boss_bison_bgm"],
    },
  };
  const scene = (keys: string[]) => ({
    recipe,
    cache: { audio: { getKeys: () => keys } },
  });
  const both = ["stage_bgm", "stage_bgm_loop2", "stage4_bgm"];
  const loop1 = (await load()).api;
  assertEquals(
    loop1.stageBgmKey(scene(both), 0, "boss_bison_bgm"),
    "stage_bgm",
  );
  const { api } = await load({ state: { loop2: true } });
  assertEquals(
    api.stageBgmKey(scene(both), 0, "boss_bison_bgm"),
    "stage_bgm_loop2",
  );
  // Still on its way: the track it replaces.
  assertEquals(
    api.stageBgmKey(scene(["stage_bgm"]), 0, "boss_bison_bgm"),
    "stage_bgm",
  );
  // A stage's own track has no loop-2 one here, so it plays on as it is.
  assertEquals(api.stageBgmKey(scene(both), 4, "boss_fang_bgm"), "stage4_bgm");
  assertEquals(
    api.stageBgmKey(
      scene([...both, "stage4_bgm_loop2"]),
      4,
      "boss_fang_bgm",
    ),
    "stage4_bgm_loop2",
  );
  // The bonus level plays its own music, loop or no loop.
  assertEquals(
    api.stageBgmKey(scene(both), 5, "boss_bison_bgm"),
    "secret:boss_bison_bgm",
  );
  // And a loop-2 key is never asked for its own loop-2 track.
  assertEquals(api.loop2BgmKey(both, "stage_bgm_loop2"), "stage_bgm_loop2");
});

Deno.test("the bonus level is beaten when the run is past its last stage", async () => {
  const { api, state } = await load();
  const recipe = { secretLevel: { first: 5, count: 2 } };
  for (
    const [stageId, beaten] of [[4, false], [5, false], [6, false], [7, true]]
  ) {
    state.stageId = stageId;
    assertEquals(api.beatBonusLevel(recipe), beaten, String(stageId));
  }
  // A game with no bonus level has no loop 2.
  state.stageId = 9;
  assertEquals(api.beatBonusLevel({}), false);
  assertEquals(api.beatBonusLevel(null), false);
});

Deno.test("beating it unlocks loop 2 for the game, kept, fetched and announced", async () => {
  const { api, state, storage, posted, fetched } = await load();
  const game = fakeGame();
  // Loop 1: nothing stored, nothing fetched, nothing said.
  api.syncLoop2(game);
  assertEquals(state.loop2, false);
  assertEquals(fetched, []);
  assertEquals(posted, []);
  // The run that beat the bonus level.
  assertEquals(api.unlockLoop2(game), true);
  assertEquals(state.loop2, true);
  assertEquals(storage.kept.get("cmg-loop2"), '["foo"]');
  assertEquals(posted, [{ type: "cmg-bgm-unlock", urls: [BGM_LOOP2] }]);
  await settle();
  assertEquals(fetched, [BGM_LOOP2]);
  assertEquals(game.audio.get("stage_bgm_loop2"), { decoded: "bgm" });
  // Beaten again: no news, and nothing fetched twice.
  assertEquals(api.unlockLoop2(game), false);
  await settle();
  assertEquals(fetched, [BGM_LOOP2]);
  assertEquals(storage.kept.get("cmg-loop2"), '["foo"]');
});

Deno.test("a later boot of the game comes back on loop 2; another game does not", async () => {
  const storage = fakeStorage({ "cmg-loop2": '["foo"]' });
  const again = await load({ storage });
  const game = fakeGame();
  again.api.syncLoop2(game);
  assertEquals(again.state.loop2, true);
  assertEquals(again.posted, [{ type: "cmg-bgm-unlock", urls: [BGM_LOOP2] }]);
  await settle();
  assertEquals(game.audio.has("stage_bgm_loop2"), true);

  const other = await load({ storage, state: { gameId: "dezafoo" } });
  other.api.syncLoop2(fakeGame());
  assertEquals(other.state.loop2, false);
  assertEquals(other.fetched, []);
  // A stored list that is not one is no unlock.
  const junk = await load({ storage: fakeStorage({ "cmg-loop2": "{" }) });
  assertEquals(junk.api.readLoop2Games(), []);
});

Deno.test("a game with no id keeps loop 2 for the page only", async () => {
  const { api, state, storage } = await load({ state: { gameId: null } });
  api.unlockLoop2(fakeGame());
  assertEquals(state.loop2, true);
  assertEquals(storage.kept.has("cmg-loop2"), false);
});

Deno.test("landing mid-stage, the loop-2 track takes over from the one it replaces", async () => {
  // A run that opened straight onto a stage, before the track was in.
  const { api } = await load({ state: { loop2: true } });
  const stage = fakeStage();
  api.syncLoop2(fakeGame({}, stage.scene));
  await settle();
  assertEquals(stage.log, ["stop stage_bgm", "play stage_bgm_loop2 0.4"]);
  assertEquals(stage.scene.stageBgmName, "stage_bgm_loop2");
  // Not over a boss's own track, a paused or cleared stage, or itself.
  const cases = [
    fakeStage({ playing: "boss2_bgm" }),
    fakeStage({ playing: "boss_goki_bgm" }),
    fakeStage({ isPlaying: false }),
    fakeStage({ cleared: true }),
    fakeStage({ playing: "stage_bgm_loop2" }),
  ];
  for (const c of cases) {
    assertEquals(
      api.loop2TakeOver(fakeGame({}, c.scene), "stage_bgm_loop2"),
      false,
    );
    assertEquals(c.log, []);
  }
  // No stage scene up at all (the title, the ending).
  assertEquals(api.loop2TakeOver(fakeGame(), "stage_bgm_loop2"), false);
});

Deno.test("the deploy's downloaded copy is fetched first, the source URL after", async () => {
  const probe = await load();
  const file = probe.api.customBgmFileName(BGM_LOOP2);
  const local = "/games/2028-ai/assets/custom-bgm/" + file;
  // Listed and there.
  const there = await load({
    state: { loop2: true },
    files: { [local]: "local" },
  });
  const game = fakeGame({ stage_bgm_loop2: file });
  there.api.syncLoop2(game);
  await settle();
  assertEquals(there.fetched, [local]);
  assertEquals(game.audio.get("stage_bgm_loop2"), { decoded: "local" });
  // Listed and missing: the source.
  const gone = await load({ state: { loop2: true } });
  const game2 = fakeGame({ stage_bgm_loop2: file });
  gone.api.syncLoop2(game2);
  await settle();
  assertEquals(gone.fetched, [local, BGM_LOOP2]);
  assertEquals(game2.audio.get("stage_bgm_loop2"), { decoded: "bgm" });
  // Neither: the stage keeps the track it would have replaced, and a later
  // boot of the loop tries again.
  const none = await load({ state: { loop2: true }, files: {} });
  const game3 = fakeGame();
  none.api.syncLoop2(game3);
  await settle();
  assertEquals(game3.audio.has("stage_bgm_loop2"), false);
  none.api.syncLoop2(game3);
  await settle();
  assertEquals(none.fetched, [BGM_LOOP2, BGM_LOOP2]);
});

Deno.test("low mode, a standalone page and a level with no loop-2 track", async () => {
  const low = await load({ state: { loop2: true, lowModeFlg: true } });
  low.api.syncLoop2(fakeGame());
  assertEquals(low.fetched, []);
  // Standalone: fetched, but there is no launcher to tell.
  const alone = await load({ state: { loop2: true }, embedded: false });
  alone.api.syncLoop2(fakeGame());
  assertEquals(alone.posted, []);
  // A game whose level names none is on loop 2 all the same, with nothing
  // to fetch or announce.
  const plain = await load({ state: { bgmSourceURLs: { stage_bgm: BGM_1 } } });
  plain.api.unlockLoop2(fakeGame());
  assertEquals(plain.state.loop2, true);
  assertEquals(plain.fetched, []);
  assertEquals(plain.posted, []);
});

Deno.test("the boot syncs the loop and the ending unlocks it", async () => {
  const js = await read(BUNDLE);
  const flat = js.replace(/\s+/g, " ");
  // The boot: once the game is known, before the album goes to the deck.
  const boot = flat.indexOf("startGameScores(gameForLevelResult(result));");
  const sync = flat.indexOf("syncLoop2(game);", boot);
  const album = flat.indexOf(
    "cmgBroadcastMusicAlbum(result, result.bgmSourceURLs);",
    boot,
  );
  assert(boot > 0 && sync > boot && album > sync);
  // The ending, whichever card leads it.
  const ending = flat.indexOf("var PhaserEndingScene = class extends");
  const unlock = flat.indexOf(
    "var loop2First = beatBonusLevel(gameState._phaserRecipe) && unlockLoop2(game);",
    ending,
  );
  const roll = flat.indexOf("this._dezaStaffRoll(function()", ending);
  assert(ending > 0 && unlock > ending && roll > unlock);
  assert(flat.includes('"NEW BGM UNLOCKED"'));
  // The level loader never downloads a loop-2 track itself.
  assert(
    functionSource(js, "stagePlaysAudioKey").includes(
      "if (isLoop2BgmKey(key)) return false;",
    ),
  );
  // A loop-2 track restarts with every stage, as the stage track it
  // replaces does.
  assert(
    flat.includes(
      "var sameBgm = stageBgmMinutes(loop1BgmKey(nextKey)) < 0 && sameBgmTrack(currentKey, nextKey);",
    ),
  );
});
