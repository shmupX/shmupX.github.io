// The music player at static/music-player/ (AZLegendGolden's deck, vendored)
// and the ways a game's music reaches it: the album named on its URL
// (bgm-params.js), the album the 2028-ai runtime hands the launcher
// (cmgBroadcastMusicAlbum in game.bundle.js, a vendored artifact patched by
// hand, so it is pinned here by source), and game-bgm.js, the module a game
// routes its own BGM through.
//
// Run with: deno test tests/music_player_test.ts

import { assert, assertEquals, assertMatch } from "@std/assert";
import { STATIC_INDEXES } from "../lib/static-indexes.ts";
import { bgmAlbum, configureSound } from "../static/music-player/game-bgm.js";

const read = async (p: string) =>
  (await Deno.readTextFile(new URL(`../${p}`, import.meta.url)))
    .replaceAll("\r\n", "\n");

// ── The page ────────────────────────────────────────────────────────────────

Deno.test("every URL in the player is relative, and the bare path redirects", async () => {
  // Served from the launcher's sidebar and from a game's hidden frame alike,
  // and the one copy must work wherever the directory is mounted — which is
  // also why /music-player is a directory index (lib/static-indexes.ts).
  const html = await read("static/music-player/index.html");
  assert(!/(href|src)="\//.test(html), "index.html has a root-absolute URL");
  assert(!/azlegend\.easierbycode|easierbycode\.com/.test(html));
  for (const script of ["app.js", "audio-visualizer.js", "bgm-params.js"]) {
    const js = await read(`static/music-player/${script}`);
    assert(!js.includes('"/public/'), `${script} still points at /public/`);
  }
  const css = await read("static/music-player/styles/styles.css");
  assert(
    !css.includes("libraries/"),
    "styles.css still points at the old font directory",
  );
  assert(STATIC_INDEXES.includes("/music-player"));
  // The three files the page loads, in the order the deck needs them: the
  // visualizer and the URL helper before the player that uses both.
  const order = ["audio-visualizer.js", "bgm-params.js", "app.js"].map((f) =>
    html.indexOf(`src="./${f}"`)
  );
  assert(
    order.every((i) => i >= 0) && order[0] < order[1] && order[1] < order[2],
    "scripts out of order",
  );
  // No artist bio and no PWA button rode along.
  assert(!html.includes("bio-panel") && !html.includes("offlineButton"));
});

Deno.test("the player speaks the whole music-player: protocol and boots empty", async () => {
  const js = await read("static/music-player/app.js");
  for (
    const command of [
      '"add-albums"',
      '"select-album"',
      '"play"',
      '"pause"',
      '"resume"',
      '"stop"',
      '"next"',
      '"prev"',
      '"get-state"',
    ]
  ) assert(js.includes(`case ${command}:`), `no ${command} command`);
  for (const event of ["ready", "event", "state", "frequency"]) {
    assert(js.includes(`MESSAGE_PREFIX + "${event}"`), `no ${event} message`);
  }
  // No artist index is shipped: a missing ./albums.json is the ordinary case
  // and must not be reported as a failure.
  assertEquals(js.includes("Could not load albums"), false);
  assert(js.includes('"./albums.json"'));
  assert(js.includes("MusicPlayerBgmParams"), "the URL album is never read");
});

// ── The album on the URL ────────────────────────────────────────────────────

type BgmParams = {
  MAX_TRACKS: number;
  bgmUrlAllowed: (raw: unknown, base?: string) => string | null;
  albumFromParams: (
    params: URLSearchParams,
    base?: string,
  ) => {
    id: string;
    title: string;
    autoplay: boolean;
    tracks: { id: string; title: string; url: string }[];
  } | null;
};

async function bgmParams(): Promise<BgmParams> {
  await import("../static/music-player/bgm-params.js");
  return (globalThis as unknown as { MusicPlayerBgmParams: BgmParams })
    .MusicPlayerBgmParams;
}

const PAGE = "https://codemonkey.games/music-player/";

Deno.test("?bgm= names an album: http(s) kept, titles beside, the rest dropped", async () => {
  const { albumFromParams } = await bgmParams();
  const params = new URLSearchParams(
    "bgm=https://cdn.example/stage_1.mp3&title=Stage%20One" +
      "&bgm=javascript:alert(1)&title=Evil" +
      "&bgmURL=/games/2028-ai/assets/sounds/boss_goki_bgm.mp3" +
      "&bgm=data:audio/mpeg;base64,AAAA" +
      "&album=My%20Game",
  );
  const album = albumFromParams(params, PAGE);
  assert(album);
  assertEquals(album.title, "My Game");
  assertEquals(album.id, "url:my-game");
  assertEquals(album.autoplay, false);
  // The javascript: and data: URLs are gone; `bgmURL` counts as `bgm`, and a
  // relative path resolved against the page. Titles pair with `bgm` entries
  // in order, so the Evil title (second `bgm`) is never used — the third
  // track, from bgmURL, is read off its file name.
  assertEquals(album.tracks.map((t) => t.url), [
    "https://cdn.example/stage_1.mp3",
    "https://codemonkey.games/games/2028-ai/assets/sounds/boss_goki_bgm.mp3",
  ]);
  assertEquals(album.tracks[0].title, "Stage One");
  assertEquals(album.tracks[1].title, "boss goki bgm");
  assertEquals(album.tracks.map((t) => t.id), ["stage_1", "boss_goki_bgm"]);
});

Deno.test("an album with no playable track is no album, and a long one is cut", async () => {
  const { albumFromParams, MAX_TRACKS } = await bgmParams();
  assertEquals(albumFromParams(new URLSearchParams(""), PAGE), null);
  assertEquals(
    albumFromParams(
      new URLSearchParams("bgm=ftp://x/a.mp3&bgm=javascript:alert(1)"),
      PAGE,
    ),
    null,
  );
  const many = new URLSearchParams();
  for (let i = 0; i < MAX_TRACKS + 10; i++) {
    many.append("bgm", `https://cdn.example/${i}.mp3`);
  }
  many.set("autoplay", "1");
  const album = albumFromParams(many, PAGE);
  assert(album);
  assertEquals(album.tracks.length, MAX_TRACKS);
  assertEquals(album.autoplay, true);
  assertEquals(album.title, "Game BGM");
  // Two tracks with the same file name stay distinguishable to the watch.
  const twins = albumFromParams(
    new URLSearchParams(
      "bgm=https://a.example/x/loop.mp3&bgm=https://b.example/y/loop.mp3",
    ),
    PAGE,
  );
  assertEquals(twins?.tracks.map((t) => t.id), ["loop", "loop-2"]);
});

// ── game-bgm.js ─────────────────────────────────────────────────────────────

Deno.test("game-bgm.js turns a game's BGM table into the player's album, loops in seconds", () => {
  configureSound({
    albumId: "my-game",
    albumTitle: "My Game",
    bgm: {
      stage1: {
        url: "https://cdn.example/stage1.mp3",
        start: 914888,
        end: 6111881,
        volume: 0.5,
      },
      boss: { url: "https://cdn.example/boss.mp3", title: "The Boss" },
    },
  });
  const album = bgmAlbum();
  assertEquals(album.id, "my-game");
  assertEquals(album.tracks.length, 2);
  assertEquals(album.tracks[0].id, "stage1");
  assertEquals(album.tracks[0].loopStart, 0.914888);
  assertEquals(album.tracks[0].loopEnd, 6.111881);
  assertEquals(album.tracks[0].volume, 0.5);
  assertEquals(album.tracks[1].title, "The Boss");
  assertEquals(album.tracks[1].loopEnd, undefined);
});

// ── The runtime's hand-off ──────────────────────────────────────────────────

const BUNDLE = "static/games/2028-ai/game.bundle.js";

/** One top-level function of the bundle's IIFE, by name, as source text. */
function functionSource(js: string, name: string): string {
  const start = js.indexOf(`\n  function ${name}(`);
  assert(start >= 0, `no ${name} in ${BUNDLE}`);
  const end = js.indexOf("\n  }\n", start);
  assert(end > start, `${name} does not close`);
  return js.slice(start, end + 4);
}

type Album = {
  id: string;
  title: string;
  tracks: { id: string; title: string; url: string }[];
};

/**
 * cmgBroadcastMusicAlbum as a callable over a stub window and the two names
 * it reaches for, returning what it posted to the parent.
 */
async function broadcaster() {
  const js = await read(BUNDLE);
  assert(
    js.includes("cmgBroadcastMusicAlbum(result, result.bgmSourceURLs);"),
    "the album is not sent when the level resolves",
  );
  const src = functionSource(js, "cmgBroadcastMusicAlbum") +
    functionSource(js, "cmgMusicTitle") +
    functionSource(js, "gameForLevelResult");
  const make = new Function(
    "window",
    "RESOURCE_PATHS",
    "ASSET_BASE",
    src + "\nreturn cmgBroadcastMusicAlbum;",
  );
  return (result: unknown, sourceURLs: unknown, embedded = true) => {
    const posted: { type: string; album: Album }[] = [];
    const parent = {
      postMessage: (m: { type: string; album: Album }) => posted.push(m),
    };
    const win = {
      parent: embedded ? parent : null as unknown,
      location: { href: "https://codemonkey.games/games/2028-ai?level=foo" },
    };
    if (!embedded) win.parent = win;
    make(win, {
      boss_bison_bgm: "assets/sounds/boss_bison_bgm.mp3",
      boss_goki_bgm: "assets/sounds/boss_goki_bgm.mp3",
      bgm_continue: "assets/sounds/scene_continue/bgm_continue.mp3",
      se_decision: "assets/sounds/se_decision.mp3",
    }, "/games/2028-ai/")(result, sourceURLs);
    return posted;
  };
}

Deno.test("the runtime hands the launcher its BGM: stock tracks, the level's overrides over them", async () => {
  const post = await broadcaster();
  const posted = post({ levelName: "foo", source: "firebase" }, {
    boss_bison_bgm: "https://cdn.example/shared.mp3",
    boss_goki_bgm: "https://cdn.example/shared.mp3",
    bgm7apIEBrXWAzw2TQggIQGK6FMLbRyaH: "https://cdn.example/custom.mp3",
    // A level can override a voice line too; that is a sound, not a track.
    boss_goki_voice_ko: "https://cdn.example/voice.mp3",
    bogus: "javascript:alert(1)",
    blob: "blob:https://codemonkey.games/abc",
  });
  assertEquals(posted.length, 1);
  assertEquals(posted[0].type, "cmg-music-album");
  const album = posted[0].album;
  assertEquals(album.id, "game-bgm:foo");
  assertEquals(album.title, "foo BGM");
  // The two bosses' stock rows were replaced by their shared custom file —
  // one row for it — the continue tune stayed stock under the asset base, the
  // voice (no bgm in its key) was never music, and the two non-http URLs
  // went nowhere.
  assertEquals(album.tracks.map((t) => t.url), [
    "https://cdn.example/shared.mp3",
    "https://codemonkey.games/games/2028-ai/assets/sounds/scene_continue/bgm_continue.mp3",
    "https://cdn.example/custom.mp3",
  ]);
  assertEquals(album.tracks[0].title, "Custom BGM (2 slots)");
  assertEquals(album.tracks[1].title, "Continue");
  assertEquals(album.tracks[2].title, "Custom BGM 7apIEB");
  assertEquals(album.tracks[2].id, "bgm7apIEBrXWAzw2TQggIQGK6FMLbRyaH");
});

Deno.test("with no overrides the album is the stock BGM, named for the stock game", async () => {
  const post = await broadcaster();
  const posted = post({ source: "fallback" }, null);
  assertEquals(posted.length, 1);
  assertEquals(posted[0].album.id, "game-bgm:2028.Ai");
  assertEquals(posted[0].album.tracks.map((t) => t.title), [
    "Boss Bison",
    "Boss Goki",
    "Continue",
  ]);
  for (const t of posted[0].album.tracks) {
    assertMatch(
      t.url,
      /^https:\/\/codemonkey\.games\/games\/2028-ai\/assets\/sounds\//,
    );
  }
});

Deno.test("an editor PLAY of a shelf game names the album after that game", async () => {
  const post = await broadcaster();
  const posted = post({
    source: "editor",
    gameId: "dezafoo",
    recipe: { meta: { editorGameKey: "dezafoo", editorLevelName: "typed" } },
  }, null);
  assertEquals(posted[0].album.id, "game-bgm:dezafoo");
  assertEquals(posted[0].album.title, "dezafoo BGM");
});

Deno.test("standalone — no parent frame — nothing is sent", async () => {
  const post = await broadcaster();
  assertEquals(
    post({ levelName: "foo" }, { bgm: "https://cdn.example/a.mp3" }, false)
      .length,
    0,
  );
});

// ── The launcher ────────────────────────────────────────────────────────────

Deno.test("the launcher checks the album, docks the deck and ducks the game", async () => {
  // Pinned by text: the dashboard is a Svelte component bundled at build
  // time, and the guard is what makes an author-typed URL safe to forward.
  const svelte = await read("svelte-src/Dashboard.svelte");
  assert(svelte.includes("d.type === 'cmg-music-album'"));
  assert(svelte.includes("function sanitizeMusicAlbum("));
  assert(
    svelte.includes("url.protocol !== 'http:' && url.protocol !== 'https:'"),
  );
  assert(svelte.includes("const MUSIC_PLAYER_URL = '/music-player/';"));
  assert(svelte.includes("bgm: (musicDucked ? 0 : volBgm) / 100"));
  assert(svelte.includes("from '../static/watch-music.js'"));
});
