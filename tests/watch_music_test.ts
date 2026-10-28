// Unit tests for the launcher's half of the watch music remote
// (static/watch-music.js): the pairing code, the rules that decide whether a
// record from the database is acted on, and the translation between the
// music player's state and what the watch is told. No database, no browser —
// the stream and fetch are stand-ins. Ported with the module from cmg, so a
// watchAmp verified against cmg's launcher is verified against this one.
//
// Run with: deno test tests/watch_music_test.ts

import assert from "node:assert/strict";
import {
  CODE_ALPHABET,
  findTrack,
  formatWatchCode,
  isFreshControl,
  isFreshLaunch,
  libraryFromState,
  MAX_TEXT,
  MAX_TRACKS,
  newWatchCode,
  normalizeWatchCode,
  playingFromState,
  publishMusic,
  WATCH_DB,
  watchMusic,
} from "../static/watch-music.js";
import { EXPORT_DB, normalizeBuilderCode } from "../static/export-queue.js";

// What the player's `music-player:state` looks like, trimmed.
const STATE = {
  albums: [
    {
      id: "game-bgm:foo",
      title: "foo BGM",
      tracks: [
        {
          id: "boss_bison_bgm",
          title: "Boss Bison",
          file: "boss_bison_bgm.mp3",
          url:
            "https://codemonkey.games/games/2028-ai/assets/sounds/boss_bison_bgm.mp3",
        },
        {
          id: "bgm7apIEBrXWAzw2TQggIQGK6FMLbRyaH",
          title: "Custom BGM 7apIEB",
          file: "stage.mp3",
          url: "https://cdn.example/stage.mp3",
        },
      ],
    },
    { id: "empty", title: "Empty", tracks: [] },
  ],
  currentAlbumId: "game-bgm:foo",
  currentTrackId: "bgm7apIEBrXWAzw2TQggIQGK6FMLbRyaH",
  paused: false,
};

// ── The code ────────────────────────────────────────────────────────────────

Deno.test("the music remote pairs by the same code the rest of the watch does", () => {
  // One database, one alphabet: the BUILD CODE a desktop shows is a code
  // watchAmp accepts, and what this page makes up is one the export queue
  // would accept.
  assert.equal(WATCH_DB, EXPORT_DB);
  assert.equal(
    normalizeWatchCode("abcd-efgh"),
    normalizeBuilderCode("abcd-efgh"),
  );
  assert.equal(normalizeWatchCode("abcd-efgh"), "ABCDEFGH");
  assert.equal(formatWatchCode("ABCDEFGH"), "ABCD-EFGH");
  assert.equal(formatWatchCode(""), "");
});

Deno.test("a code with misreadable characters or the wrong length is not one", () => {
  assert.equal(normalizeWatchCode("ABCDEFG"), "");
  assert.equal(normalizeWatchCode("ABCDEFGHJ"), "");
  assert.equal(normalizeWatchCode("ABCDEFG0"), "");
  assert.equal(normalizeWatchCode("ABCDEFGI"), "");
  assert.equal(normalizeWatchCode(null), "");
});

Deno.test("a new code is eight characters of the alphabet and passes its own check", () => {
  for (let i = 0; i < 50; i++) {
    const code = newWatchCode();
    assert.equal(code.length, 8);
    assert.equal(normalizeWatchCode(code), code);
    assert.equal(normalizeBuilderCode(code), code);
  }
  // Every byte value maps into the alphabet.
  const all = newWatchCode((buf: Uint8Array) => buf.map((_, i) => 248 + i));
  for (const ch of all) assert.ok(CODE_ALPHABET.includes(ch));
});

// ── Launches ────────────────────────────────────────────────────────────────

const launch = (over = {}) => ({
  id: "press-1",
  album: "game-bgm:foo",
  track: "boss_bison_bgm",
  created_at: 2000,
  ...over,
});

Deno.test("a launch is acted on once", () => {
  const seen = new Set<string>();
  assert.ok(isFreshLaunch(launch(), seen));
  seen.add("press-1");
  assert.ok(!isFreshLaunch(launch(), seen));
});

Deno.test("a launch is not judged by the watch's clock", () => {
  // A watch running years behind, or with no clock at all, is still heard.
  assert.ok(isFreshLaunch(launch({ created_at: 5 }), new Set()));
  assert.ok(isFreshLaunch(launch({ created_at: undefined }), new Set()));
});

Deno.test("a launch that does not name a song is dropped", () => {
  const seen = new Set<string>();
  assert.ok(!isFreshLaunch(null, seen));
  assert.ok(!isFreshLaunch("x", seen));
  assert.ok(!isFreshLaunch(launch({ id: "" }), seen));
  assert.ok(!isFreshLaunch(launch({ album: undefined }), seen));
  assert.ok(!isFreshLaunch(launch({ track: 7 }), seen));
  assert.ok(!isFreshLaunch(launch({ track: { evil: true } }), seen));
  assert.ok(!isFreshLaunch(launch({ track: "x".repeat(600) }), seen));
});

// ── Controls ────────────────────────────────────────────────────────────────

Deno.test("a control is acted on once, and only if it is a known action", () => {
  const seen = new Set<string>();
  const pause = { action: "pause", created_at: 2000 };
  assert.ok(isFreshControl(pause, seen));
  assert.ok(!isFreshControl(pause, seen));
  assert.ok(isFreshControl({ action: "pause", created_at: 2001 }, seen));
  assert.ok(isFreshControl({ action: "sync", created_at: 2002 }, seen));
  assert.ok(!isFreshControl({ action: "eval", created_at: 2003 }, seen));
  assert.ok(!isFreshControl({ action: "add-albums", created_at: 2004 }, seen));
});

Deno.test("a control with nothing to tell it apart by is dropped", () => {
  const seen = new Set<string>();
  assert.ok(!isFreshControl({ action: "next" }, seen));
  assert.ok(!isFreshControl({ action: "next", created_at: "soon" }, seen));
  assert.ok(!isFreshControl(null, seen));
});

// ── The player's state, in the watch's terms ────────────────────────────────

Deno.test("the library is ids and titles, never a track's url", () => {
  const library = libraryFromState(STATE);
  assert.deepEqual(library, {
    albums: [{
      id: "game-bgm:foo",
      title: "foo BGM",
      tracks: [
        { id: "boss_bison_bgm", title: "Boss Bison" },
        { id: "bgm7apIEBrXWAzw2TQggIQGK6FMLbRyaH", title: "Custom BGM 7apIEB" },
      ],
    }],
  });
  assert.ok(!JSON.stringify(library).includes("https://"));
});

Deno.test("the library survives a player with nothing, or with junk", () => {
  assert.deepEqual(libraryFromState(null), { albums: [] });
  assert.deepEqual(libraryFromState({ albums: "nope" }), { albums: [] });
  const library = libraryFromState({
    albums: [
      null,
      { id: 7, tracks: [{ id: "a" }] },
      { id: "ok", tracks: [null, { id: "" }, { id: "t", title: 5 }] },
    ],
  });
  assert.deepEqual(library, {
    albums: [{ id: "ok", title: "ok", tracks: [{ id: "t", title: "t" }] }],
  });
});

Deno.test("the library is bounded", () => {
  const tracks = Array.from(
    { length: MAX_TRACKS + 20 },
    (_, i) => ({ id: "t" + i, title: "x".repeat(400) }),
  );
  const library = libraryFromState({ albums: [{ id: "big", tracks }] });
  assert.equal(library.albums[0].tracks.length, MAX_TRACKS);
  assert.equal(library.albums[0].tracks[0].title.length, MAX_TEXT);
});

Deno.test("a track is found by the ids the player reported, and nothing else", () => {
  const found = findTrack(STATE, "game-bgm:foo", "boss_bison_bgm");
  assert.equal(found?.track.title, "Boss Bison");
  assert.equal(findTrack(STATE, "game-bgm:foo", "nope"), null);
  assert.equal(findTrack(STATE, "nope", "boss_bison_bgm"), null);
  // The player itself would match a title or a url; the remote does not.
  assert.equal(findTrack(STATE, "foo BGM", "Boss Bison"), null);
  assert.equal(findTrack(null, "a", "b"), null);
});

Deno.test("playing says what is on", () => {
  assert.deepEqual(playingFromState(STATE), {
    state: "playing",
    album: "game-bgm:foo",
    track: "bgm7apIEBrXWAzw2TQggIQGK6FMLbRyaH",
    title: "Custom BGM 7apIEB",
    album_title: "foo BGM",
    id: null,
    failed_id: null,
    detail: null,
  });
  assert.equal(playingFromState({ ...STATE, paused: true }).state, "paused");
});

Deno.test("no player, or no current track, is idle", () => {
  assert.equal(playingFromState(null).state, "idle");
  const none = playingFromState({ ...STATE, currentTrackId: null });
  assert.equal(none.state, "idle");
  assert.equal(none.title, null);
});

Deno.test("a press is echoed only while its track is the one on", () => {
  const press = {
    id: "press-1",
    album: "game-bgm:foo",
    track: "bgm7apIEBrXWAzw2TQggIQGK6FMLbRyaH",
  };
  assert.equal(playingFromState(STATE, { launch: press }).id, "press-1");
  // The player has moved on (next, or picked by hand): no longer the answer.
  const moved = { ...STATE, currentTrackId: "boss_bison_bgm" };
  assert.equal(playingFromState(moved, { launch: press }).id, null);
});

Deno.test("a refused press rides beside the state, not over it", () => {
  const record = playingFromState(STATE, {
    failed: { id: "press-2", detail: "not in the library" },
  });
  assert.equal(record.state, "playing");
  assert.equal(record.title, "Custom BGM 7apIEB");
  assert.equal(record.failed_id, "press-2");
  assert.equal(record.detail, "not in the library");
});

// ── The stream ──────────────────────────────────────────────────────────────

class FakeEventSource {
  static opened: FakeEventSource[] = [];
  listeners = new Map<string, (ev: { data: string }) => void>();
  closed = false;
  constructor(public url: string) {
    FakeEventSource.opened.push(this);
  }
  addEventListener(type: string, cb: (ev: { data: string }) => void) {
    this.listeners.set(type, cb);
  }
  close() {
    this.closed = true;
  }
  put(path: string, data: unknown) {
    this.listeners.get("put")?.({ data: JSON.stringify({ path, data }) });
  }
  /** A (re)connect: the database opens with the node as it stands. */
  connect(snapshot: unknown) {
    this.listeners.get("open")?.({ data: "" });
    this.put("/", snapshot);
  }
}

function subscribe() {
  FakeEventSource.opened = [];
  const launches: { id: string }[] = [];
  const controls: { action: string }[] = [];
  const stop = watchMusic(
    "abcd-efgh",
    {
      onLaunch: (r: { id: string }) => launches.push(r),
      onControl: (r: { action: string }) => controls.push(r),
    },
    FakeEventSource,
  );
  const [launchStream, controlStream] = FakeEventSource.opened;
  return { launches, controls, stop, launchStream, controlStream };
}

Deno.test("the launcher listens on the unhyphenated code's music node", () => {
  const { launchStream, controlStream, stop } = subscribe();
  const root = `${WATCH_DB}/builders/ABCDEFGH/music`;
  assert.equal(launchStream.url, `${root}/launch.json`);
  assert.equal(controlStream.url, `${root}/control.json`);
  stop();
  assert.ok(launchStream.closed && controlStream.closed);
});

Deno.test("a bad code subscribes to nothing", () => {
  FakeEventSource.opened = [];
  watchMusic("nope", {}, FakeEventSource)();
  assert.equal(FakeEventSource.opened.length, 0);
});

Deno.test("what the database remembers on connect is not a press", () => {
  const { launches, controls, launchStream, controlStream } = subscribe();
  // Left behind by an earlier session — even one stamped in the future.
  launchStream.connect(launch({ id: "old", created_at: Date.now() + 60_000 }));
  controlStream.connect({ action: "next", created_at: Date.now() + 60_000 });
  assert.equal(launches.length, 0);
  assert.equal(controls.length, 0);
});

Deno.test("a press after connect is acted on, whatever the watch's clock says", () => {
  const { launches, controls, launchStream, controlStream } = subscribe();
  launchStream.connect(null);
  controlStream.connect(null);
  launchStream.put("/", launch({ id: "new", created_at: 5 }));
  controlStream.put("/", { action: "pause", created_at: 6 });
  assert.deepEqual(launches.map((r) => r.id), ["new"]);
  assert.deepEqual(controls.map((r) => r.action), ["pause"]);
});

Deno.test("a reconnect does not replay the last press, or play one it slept through", () => {
  const { launches, controls, launchStream, controlStream } = subscribe();
  launchStream.connect(null);
  controlStream.connect(null);
  launchStream.put("/", launch({ id: "a" }));
  controlStream.put("/", { action: "next", created_at: 7000 });

  // The stream drops and EventSource reconnects: same records again.
  launchStream.connect(launch({ id: "a" }));
  controlStream.connect({ action: "next", created_at: 7000 });
  assert.deepEqual(launches.map((r) => r.id), ["a"]);
  assert.equal(controls.length, 1);

  // A laptop asleep for an hour reconnects to a press made while it slept.
  launchStream.connect(launch({ id: "while-asleep" }));
  assert.deepEqual(launches.map((r) => r.id), ["a"]);
  // …and a redelivery of that same record later is still not a press.
  launchStream.put("/", launch({ id: "while-asleep" }));
  assert.deepEqual(launches.map((r) => r.id), ["a"]);

  // The listener taps again: a new press, acted on.
  launchStream.put("/", launch({ id: "b" }));
  assert.deepEqual(launches.map((r) => r.id), ["a", "b"]);
});

Deno.test("an empty node, a partial write or junk on the stream is ignored", () => {
  const { launches, controls, launchStream, controlStream } = subscribe();
  launchStream.connect(null);
  controlStream.connect(null);
  launchStream.put("/", null);
  launchStream.put("/track", "boss_bison_bgm");
  launchStream.listeners.get("put")?.({ data: "not json" });
  controlStream.put("/", { action: "rm -rf", created_at: 5000 });
  assert.equal(launches.length, 0);
  assert.equal(controls.length, 0);
  controlStream.put("/", { action: "next", created_at: 5000 });
  assert.equal(controls.length, 1);
});

Deno.test("a handler that throws does not take the stream down", () => {
  FakeEventSource.opened = [];
  let calls = 0;
  watchMusic(
    "ABCDEFGH",
    {
      onLaunch: () => {
        calls++;
        throw new Error("boom");
      },
    },
    FakeEventSource,
  );
  const [launchStream] = FakeEventSource.opened;
  const warn = console.warn;
  console.warn = () => {};
  try {
    launchStream.connect(null);
    launchStream.put("/", launch({ id: "a" }));
    launchStream.put("/", launch({ id: "b" }));
  } finally {
    console.warn = warn;
  }
  assert.equal(calls, 2);
});

// ── Publishing ──────────────────────────────────────────────────────────────

Deno.test("publishing PUTs the whole record, stamped, to the right node", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fakeFetch = (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve({ ok: true });
  };
  const ok = await publishMusic(
    "ABCD-EFGH",
    "playing",
    { state: "idle" },
    fakeFetch,
  );
  assert.ok(ok);
  assert.equal(
    calls[0].url,
    `${WATCH_DB}/builders/ABCDEFGH/music/playing.json`,
  );
  assert.equal(calls[0].init.method, "PUT");
  const body = JSON.parse(String(calls[0].init.body));
  assert.equal(body.state, "idle");
  assert.ok(body.updated_at > 0);
});

Deno.test("publishing never writes outside its two nodes, and never throws", async () => {
  let called = 0;
  const fakeFetch = () => {
    called++;
    return Promise.reject(new Error("offline"));
  };
  assert.equal(await publishMusic("ABCDEFGH", "launch", {}, fakeFetch), false);
  assert.equal(
    await publishMusic("ABCDEFGH", "../other", {}, fakeFetch),
    false,
  );
  assert.equal(await publishMusic("nope", "playing", {}, fakeFetch), false);
  assert.equal(called, 0);
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(
      await publishMusic("ABCDEFGH", "playing", {}, fakeFetch),
      false,
    );
  } finally {
    console.warn = warn;
  }
  assert.equal(called, 1);
});
