// The Guide's background-music selector (static/osd-bgm.js): the tracks on
// offer, the one a game unlocks, the pick as it is remembered, and the
// looping player behind it —
// what it holds the game's own BGM for, and what it does not. No browser: the
// <audio> is a stand-in that says what was asked of it. The launcher's wiring
// is a Svelte component bundled at build time, so it is pinned by source.
//
// Run with: deno test tests/osd_bgm_test.ts

import { assert, assertEquals } from "@std/assert";
import {
  BGM_CHOICE_KEY,
  BGM_GAME,
  BGM_OPTIONS,
  BGM_TRACKS,
  BGM_UNLOCKED_KEY,
  bgmOptions,
  bgmTrack,
  createBgmPlayer,
  loadBgmChoice,
  loadBgmUnlocks,
  saveBgmChoice,
  unlockBgmTracks,
} from "../static/osd-bgm.js";

const read = async (p: string) =>
  (await Deno.readTextFile(new URL(`../${p}`, import.meta.url)))
    .replaceAll("\r\n", "\n");

/** A localStorage with nothing behind it but a Map. */
function fakeStorage(seed: Record<string, string> = {}) {
  const kept = new Map(Object.entries(seed));
  return {
    kept,
    getItem: (k: string) => kept.has(k) ? kept.get(k)! : null,
    setItem: (k: string, v: string) => void kept.set(k, String(v)),
    removeItem: (k: string) => void kept.delete(k),
  };
}

/** An <audio> that records what it was told and plays when the test says so. */
function fakeAudio() {
  const listeners = new Map<string, Array<() => void>>();
  let settle: { resolve: () => void; reject: (e: unknown) => void } | null =
    null;
  const audio = {
    src: "",
    loop: false,
    preload: "",
    volume: 1,
    error: null as { code: number } | null,
    plays: 0,
    pauses: 0,
    addEventListener(type: string, fn: () => void) {
      listeners.set(type, [...(listeners.get(type) || []), fn]);
    },
    play() {
      audio.plays++;
      return new Promise<void>((resolve, reject) => {
        settle = { resolve, reject };
      });
    },
    pause() {
      audio.pauses++;
    },
    fire(type: string) {
      for (const fn of listeners.get(type) || []) fn();
    },
    /** The pending play() succeeds: the promise resolves, `playing` fires. */
    async started() {
      settle?.resolve();
      audio.fire("playing");
      await tick();
    },
    /** The pending play() is refused, as the browser names the refusal. */
    async refused(name: string) {
      settle?.reject(Object.assign(new Error(name), { name }));
      await tick();
    },
  };
  return audio;
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/** A player on a fake <audio>, with its retry timer in the test's hands. */
function player() {
  const audio = fakeAudio();
  const states: string[] = [];
  const timers: Array<() => void> = [];
  const p = createBgmPlayer({
    makeAudio: () => audio,
    onstate: (s: string) => states.push(s),
    setTimer: (fn: () => void) => timers.push(fn),
    clearTimer: (id: number) => void (timers[id - 1] = () => {}),
  });
  return { p, audio, states, timers };
}

const URL_1 = "https://easierbycode.com/1.mp3";
const URL_2 = "https://easierbycode.com/2.mp3";

// ── The tracks ──────────────────────────────────────────────────────────────

Deno.test("five tracks, each an https file on easierbycode.com, one of them locked", () => {
  assertEquals(BGM_TRACKS.map((t) => t.url), [
    "https://easierbycode.com/1.mp3",
    "https://easierbycode.com/2.mp3",
    "https://easierbycode.com/4.mp3",
    "https://easierbycode.com/diamond-eyes.mp3",
    "https://easierbycode.com/bgm.mp3",
  ]);
  assertEquals(
    BGM_TRACKS.filter((t) => "locked" in t && t.locked).map((t) => t.id),
    ["bgm"],
  );
  assertEquals(new Set(BGM_TRACKS.map((t) => t.id)).size, BGM_TRACKS.length);
  for (const t of BGM_TRACKS) assert(t.id && t.label);
});

Deno.test("the row offers the game's own music first, then the open tracks", () => {
  assertEquals(BGM_OPTIONS[0], { value: BGM_GAME, label: "Game" });
  assertEquals(
    BGM_OPTIONS.slice(1).map((o) => o.value),
    BGM_TRACKS.filter((t) => !("locked" in t && t.locked)).map((t) => t.id),
  );
  assertEquals(BGM_OPTIONS.map((o) => o.label), [
    "Game",
    "1.mp3",
    "2.mp3",
    "4.mp3",
    "Diamond Eyes",
  ]);
});

Deno.test("a locked track joins the row once it is unlocked, last", () => {
  assertEquals(bgmOptions(), BGM_OPTIONS);
  assertEquals(bgmOptions(["bgm"]).map((o) => o.label), [
    "Game",
    "1.mp3",
    "2.mp3",
    "4.mp3",
    "Diamond Eyes",
    "bgm.mp3",
  ]);
  // An open track's id unlocks nothing that was not on offer already.
  assertEquals(bgmOptions(["4", "nope"]), BGM_OPTIONS);
});

Deno.test("a game unlocks a track by its URL, and only a locked track of the list", () => {
  const storage = fakeStorage();
  assertEquals(loadBgmUnlocks(storage), []);
  // Anything else a frame might send unlocks nothing and stores nothing.
  for (
    const urls of [
      null,
      "https://easierbycode.com/bgm.mp3",
      [{ url: "https://easierbycode.com/bgm.mp3" }],
      ["https://evil.example/bgm.mp3", "https://easierbycode.com/bgm.mp3?x"],
      // An open track is not unlocked by being named.
      ["https://easierbycode.com/1.mp3"],
    ]
  ) {
    assertEquals(unlockBgmTracks(urls, storage), [], JSON.stringify(urls));
  }
  assertEquals(storage.kept.has(BGM_UNLOCKED_KEY), false);
  // 2028.Ai's loop 2.
  assertEquals(
    unlockBgmTracks(["https://easierbycode.com/bgm.mp3"], storage),
    ["bgm"],
  );
  // Kept by id, never the URL, and read back.
  assertEquals(storage.kept.get(BGM_UNLOCKED_KEY), '["bgm"]');
  assertEquals(loadBgmUnlocks(storage), ["bgm"]);
  // Again, or with nothing new: still unlocked.
  assertEquals(
    unlockBgmTracks(["https://easierbycode.com/bgm.mp3"], storage),
    ["bgm"],
  );
  assertEquals(unlockBgmTracks([], storage), ["bgm"]);
  // A stored list is read only for ids of locked tracks.
  const odd = fakeStorage({
    [BGM_UNLOCKED_KEY]: '["https://evil.example/x.mp3","1","bgm"]',
  });
  assertEquals(loadBgmUnlocks(odd), ["bgm"]);
  assertEquals(
    loadBgmUnlocks(fakeStorage({ [BGM_UNLOCKED_KEY]: "{bad json" })),
    [],
  );
});

Deno.test("a locked track can be picked once unlocked, and not before", () => {
  const storage = fakeStorage();
  assertEquals(saveBgmChoice("bgm", storage), BGM_GAME);
  assertEquals(storage.kept.has(BGM_CHOICE_KEY), false);
  // A pick stored while the track was locked does not come back.
  storage.kept.set(BGM_CHOICE_KEY, "bgm");
  assertEquals(loadBgmChoice(storage), BGM_GAME);
  unlockBgmTracks(["https://easierbycode.com/bgm.mp3"], storage);
  assertEquals(loadBgmChoice(storage), "bgm");
  assertEquals(saveBgmChoice("bgm", storage), "bgm");
  assertEquals(bgmTrack(loadBgmChoice(storage))?.url, BGM_TRACKS[4].url);
  // A storage that would not keep the unlock: the row's own list decides.
  const full = fakeStorage();
  assertEquals(saveBgmChoice("bgm", full, ["bgm"]), "bgm");
});

Deno.test("an id names a track; the game's own music and anything else name none", () => {
  assertEquals(bgmTrack("diamond-eyes")?.url, BGM_TRACKS[3].url);
  assertEquals(bgmTrack(BGM_GAME), null);
  assertEquals(bgmTrack("https://evil.example/x.mp3"), null);
  assertEquals(bgmTrack(undefined), null);
});

// ── The pick, remembered ────────────────────────────────────────────────────

Deno.test("a pick is kept by id and read back; Game clears it", () => {
  const storage = fakeStorage();
  assertEquals(loadBgmChoice(storage), BGM_GAME);
  assertEquals(saveBgmChoice("4", storage), "4");
  assertEquals(storage.kept.get(BGM_CHOICE_KEY), "4");
  assertEquals(loadBgmChoice(storage), "4");
  assertEquals(saveBgmChoice(BGM_GAME, storage), BGM_GAME);
  assert(!storage.kept.has(BGM_CHOICE_KEY));
});

Deno.test("what is stored is only ever one of the ids — never a URL to fetch", () => {
  const typed = fakeStorage({ [BGM_CHOICE_KEY]: "https://evil.example/x.mp3" });
  assertEquals(loadBgmChoice(typed), BGM_GAME);
  const storage = fakeStorage({ [BGM_CHOICE_KEY]: "2" });
  assertEquals(saveBgmChoice("https://evil.example/x.mp3", storage), BGM_GAME);
  assert(!storage.kept.has(BGM_CHOICE_KEY));
});

Deno.test("storage that throws, or is not there, is the game's own music", () => {
  const broken = {
    getItem: () => {
      throw new Error("denied");
    },
    setItem: () => {
      throw new Error("full");
    },
    removeItem: () => {
      throw new Error("denied");
    },
  };
  assertEquals(loadBgmChoice(broken), BGM_GAME);
  assertEquals(saveBgmChoice("1", broken), "1"); // the pick still stands for the session
  assertEquals(loadBgmChoice(null), BGM_GAME);
});

// ── The player ──────────────────────────────────────────────────────────────

Deno.test("a pick loads, loops at the Guide's volume, and holds the game's BGM from the start", async () => {
  const { p, audio, states } = player();
  assertEquals([p.state, p.holding], ["idle", false]);

  p.set(URL_1, 0.4);
  assertEquals(audio.src, URL_1);
  assertEquals([audio.loop, audio.volume, audio.plays], [true, 0.4, 1]);
  // Held before the first note, so the game's music does not play on over it.
  assertEquals([p.state, p.holding], ["starting", true]);

  await audio.started();
  assertEquals([p.state, p.holding], ["playing", true]);
  assertEquals(states, ["starting", "playing"]);
});

Deno.test("the same wish again changes the volume and nothing else", async () => {
  const { p, audio, states } = player();
  p.set(URL_1, 1);
  await audio.started();
  p.set(URL_1, 0.25);
  p.set(URL_1, 7); // out of range is clamped, not passed on
  assertEquals([audio.volume, audio.plays], [1, 1]);
  p.set(URL_1, 0.25);
  assertEquals(audio.volume, 0.25);
  assertEquals(states, ["starting", "playing"]);
});

Deno.test("another track takes the element over without letting go of the hold", async () => {
  const { p, audio } = player();
  p.set(URL_1, 1);
  await audio.started();
  p.set(URL_2, 1);
  assertEquals([audio.src, audio.plays], [URL_2, 2]);
  assert(p.holding);
  // The first play() is interrupted by the newer load; that is not a failure.
  await audio.refused("AbortError");
  assertEquals(p.state, "starting");
  await audio.started();
  assertEquals(p.state, "playing");
});

Deno.test("nothing wanted pauses and lets go; the same track later resumes where it was", async () => {
  const { p, audio } = player();
  p.set(URL_1, 1);
  await audio.started();

  p.set(null, 1);
  assertEquals([p.state, p.holding, audio.pauses], ["idle", false, 1]);
  audio.fire("pause"); // our own pause is not "something outside paused it"
  assertEquals(p.state, "idle");

  audio.src = "kept"; // would be overwritten by a reload
  p.set(URL_1, 1);
  assertEquals(audio.src, "kept");
  assertEquals([p.state, audio.plays], ["starting", 2]);
});

Deno.test("a browser that refuses play() holds nothing, and is asked again", async () => {
  const { p, audio, states, timers } = player();
  p.set(URL_1, 1);
  await audio.refused("NotAllowedError");
  // The game keeps its own music while the page waits to be tapped.
  assertEquals([p.state, p.holding], ["blocked", false]);
  assertEquals(timers.length, 1);

  timers[0](); // the retry
  assertEquals([p.state, audio.plays], ["starting", 2]);
  await audio.refused("NotAllowedError");
  assertEquals(p.state, "blocked");

  p.set(URL_1, 1); // the same wish again is a retry too
  assertEquals(audio.plays, 3);
  await audio.started();
  assertEquals([p.state, p.holding], ["playing", true]);
  assertEquals(states, [
    "starting",
    "blocked",
    "starting",
    "blocked",
    "starting",
    "playing",
  ]);
});

Deno.test("a file that will not load holds nothing, and is not hammered", async () => {
  const { p, audio } = player();
  p.set(URL_1, 1);
  audio.error = { code: 4 };
  audio.fire("error");
  await audio.refused("NotSupportedError");
  assertEquals([p.state, p.holding], ["failed", false]);

  p.set(URL_1, 0.5); // a volume change is not a reason to try again
  assertEquals([p.state, audio.plays], ["failed", 1]);

  // Wanted afresh — the next game, or picked again — it is loaded afresh.
  p.set(null, 1);
  audio.error = null;
  audio.src = "";
  p.set(URL_1, 1);
  assertEquals([audio.src, p.state, audio.plays], [URL_1, "starting", 2]);
});

Deno.test("an error left over from the track before is not this track failing", async () => {
  const { p, audio } = player();
  p.set(URL_1, 1);
  await audio.started();
  p.set(URL_2, 1);
  audio.error = null; // the newer load cleared it
  audio.fire("error");
  assertEquals(p.state, "starting");
});

Deno.test("a pause from outside lets go of the hold; the next wish resumes", async () => {
  const { p, audio } = player();
  p.set(URL_1, 1);
  await audio.started();
  audio.fire("pause"); // a media key, the tab going to the background
  assertEquals([p.state, p.holding], ["paused", false]);
  p.set(URL_1, 1);
  assertEquals([p.state, audio.plays], ["starting", 2]);
});

Deno.test("with nothing wanted there is no <audio> at all", () => {
  let made = 0;
  const p = createBgmPlayer({
    makeAudio: () => {
      made++;
      return fakeAudio();
    },
  });
  p.set(null, 1);
  p.set("", 1);
  assertEquals([made, p.state], [0, "idle"]);
});

// ── The launcher ────────────────────────────────────────────────────────────

Deno.test("the Guide's Sound section carries the selector, and the pick holds the game's BGM", async () => {
  const svelte = await read("svelte-src/Dashboard.svelte");
  assert(svelte.includes("from '../static/osd-bgm.js'"));
  assert(
    svelte.includes(
      "{ key: 'bgm-track', kind: 'select', label: 'BGM track', value: bgmChoice, options: bgmOptions(bgmUnlocked) }",
    ),
  );
  assert(
    svelte.includes("if (it.key === 'bgm-track') { setBgmChoice(v); return; }"),
  );
  // Only while a game is on, never over the editor, and never over the deck.
  assert(
    svelte.includes(
      "const wanted = !!track && gameOn && !editorFrameActive && !musicDucked;",
    ),
  );
  assert(
    svelte.includes("bgmPlayer.set(wanted ? track.url : null, volBgm / 100);"),
  );
  assert(
    svelte.includes("bgm: (musicDucked || bgmHolding ? 0 : volBgm) / 100"),
  );
  // The pick's effect comes first, so the game is never told to play on
  // between the deck stopping and the pick resuming.
  assert(
    svelte.indexOf("untrack(syncBgm);") > 0 &&
      svelte.indexOf("untrack(syncBgm);") <
        svelte.indexOf("untrack(postVolume);"),
  );
});

Deno.test("the Guide renders a select row: arrows either way, a tap steps on", async () => {
  const osd = await read("svelte-src/Osd.svelte");
  assert(osd.includes("{:else if it.kind === 'select'}"));
  assert(osd.includes("onsetvalue(i, it.options[(at - 1 + n) % n].value)"));
  assert(osd.includes("onsetvalue(i, it.options[(at + 1) % n].value)"));
  assert(
    osd.includes(
      "if (it.kind === 'button' || it.kind === 'toggle' || it.kind === 'select') onactivate(i);",
    ),
  );
  // Pad and keyboard step it like a color row, and A steps forward.
  const svelte = await read("svelte-src/Dashboard.svelte");
  assert(svelte.includes("} else if (it.kind === 'select') {"));
  assert(
    svelte.includes(
      "if (it.kind === 'color' || it.kind === 'slider' || it.kind === 'select') { adjustOsd(i, 1); return; }",
    ),
  );
});

Deno.test("the launcher takes a game's unlock from its own frame, and offers what it unlocked", async () => {
  const svelte = await read("svelte-src/Dashboard.svelte");
  assert(svelte.includes("let bgmUnlocked = $state(loadBgmUnlocks());"));
  assert(svelte.includes("options: bgmOptions(bgmUnlocked) },"));
  assert(
    svelte.includes("bgmChoice = saveBgmChoice(id, undefined, bgmUnlocked);"),
  );
  // Handled in onWindowMessage, behind its own-frame check.
  const handler = svelte.indexOf("function onWindowMessage(e) {");
  const guard = svelte.indexOf(
    "if (!iframe || e.source !== iframe.contentWindow) return;",
    handler,
  );
  const unlock = svelte.indexOf("if (d.type === 'cmg-bgm-unlock') {", handler);
  assert(handler > 0 && guard > handler && unlock > guard);
  assert(svelte.includes("bgmUnlocked = unlockBgmTracks(d.urls);"));
});

Deno.test("the built bundle carries the selector", async () => {
  const bundle = await read("static/dashboard.bundle.js");
  assert(bundle.includes("bgm-track"));
  assert(bundle.includes("https://easierbycode.com/"));
  assert(bundle.includes("diamond-eyes"));
  assert(bundle.includes("cmg-bgm-unlock"));
  assert(bundle.includes("cmg-bgm-unlocked"));
});
