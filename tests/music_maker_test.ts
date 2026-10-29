// MUSIC (static/editor/music-maker.js) and its hooks in the level editor.
//
// The component is a classic script that installs window.MusicMaker; it is
// evaluated here against a stub window to read its tables, and its host
// functions are cut out of the editor page and run live (the editorFunction /
// live() harness of tests/editor_rtdb_root_test.ts). The song model and the
// player it drives are tested in packages/shmup-engine/test/ — this is the
// glue: the header's API contract, the controls table, the mode CSS, and that
// a write from MUSIC lands in the game it was opened on and nowhere else.

import { assert, assertEquals, assertMatch } from "@std/assert";

const read = async (p: string) =>
  (await Deno.readTextFile(new URL(`../${p}`, import.meta.url))).replaceAll("\r\n", "\n");
const src = await read("static/editor/music-maker.js");
const icons = await read("static/editor/music-maker-icons.js");
const html = await read("static/editor/index.html");

// deno-lint-ignore no-explicit-any
type Any = any;

/** The component's exports, evaluated on a window with no DOM. */
function component(): Any {
  const win: Any = {};
  new Function("window", "document", src)(win, {});
  new Function("window", "document", icons)(win, {});
  return win;
}

Deno.test("the header's API contract names every api.* the component calls", () => {
  const head = src.slice(0, src.indexOf("(function () {"));
  const used = new Set([...src.matchAll(/this\.api\.(\w+)/g)].map((m) => m[1]));
  for (const name of used) assertMatch(head, new RegExp(`\\b${name}\\b`), `api.${name} is not in the header`);
});

Deno.test("both themes carry the same tokens", () => {
  const { MusicMaker } = component();
  assertEquals(Object.keys(MusicMaker.THEMES.xbox).sort(), Object.keys(MusicMaker.THEMES.nintendo).sort());
});

Deno.test("every control has a key, a pad and a touch binding, and no key does two things", () => {
  const { MusicMaker } = component();
  const seen = new Map<string, string>();
  for (const a of MusicMaker.ACTIONS) {
    assert(a.keys.length && a.pad && a.touch && a.label, a.id);
    for (const k of a.keys) {
      assert(!seen.has(k), `${k} is both ${seen.get(k)} and ${a.id}`);
      seen.set(k, a.id);
    }
  }
});

Deno.test("the tempo mascot runs faster as the tempo rises", () => {
  const { MusicMaker } = component();
  const tiers = Array.from({ length: 32 }, (_, i) => MusicMaker.tempoTier(i));
  assertEquals(tiers[0], 0);
  assertEquals(tiers[31], 5);
  for (let i = 1; i < 32; i++) assert(tiers[i] >= tiers[i - 1]);
  assertEquals(MusicMaker.noteName(25), "C4");
  assertEquals(MusicMaker.noteName(34), "A4");
});

Deno.test("MUSIC listens on the capture phase and keeps the editor's own keys from firing under it", () => {
  assertMatch(src, /addEventListener\('keydown', this\.onKey, true\)/);
  assertMatch(src, /removeEventListener\('keydown', this\.onKey, true\)/);
  assertMatch(src, /e\.stopPropagation\(\)/);
  // Ctrl+S is the editor's SAVE: MUSIC writes its record first and lets it through.
  assertMatch(src, /ctrl && \(k === 's' \|\| k === 'S'\)\) \{ this\.flush\(\); return; \}/);
});

Deno.test("the mode hides what the pixel editor's mode hides, and the lab and pixel hosts too", () => {
  const { MusicMaker } = component();
  const hidden = (css: string, mode: string) => {
    const rule = css.split("\n").find((l) => l.includes(`body.${mode} #stage-rail`));
    assert(rule, `no ${mode} hide rule`);
    return rule!.replace(/ \{.*$/, "").split(",").map((s) => s.trim().replace(`body.${mode} `, "")).sort();
  };
  const pixel = hidden(html, "pixel-editor");
  const music = hidden(MusicMaker.MODE_CSS, "music-maker");
  for (const sel of pixel) assert(music.includes(sel), `MUSIC does not hide ${sel}`);
  assert(music.includes("#pixel-editor-host"));
});

Deno.test("the eight families cover all sixty composed-part instruments", () => {
  const { MusicMakerIcons } = component();
  assertEquals(MusicMakerIcons.FAMILIES.length, 8);
  assertEquals(MusicMakerIcons.COMPOSED, 60);
  // familyOf, on the signals the tone bank gives (noise, attack, decay, loops).
  const f = MusicMakerIcons.familyOf;
  assertEquals(f({ n: 0.9, a: 0, d: 0.2, shortestLoop: 100, reverseLoop: false }), "drums");
  assertEquals(f({ n: 0.9, a: 0, d: 8, shortestLoop: 100, reverseLoop: true }), "fx");
  assertEquals(f({ n: 0.1, a: 0.2, d: 8, shortestLoop: 3000, reverseLoop: false }), "pads");
  assertEquals(f({ n: 0.6, a: 0, d: 8, shortestLoop: 9000, reverseLoop: false }), "strings");
  assertEquals(f({ n: 0, a: 0, d: 8, shortestLoop: 43, reverseLoop: false }), "bleep");
  assertEquals(f({ n: 0, a: 0, d: 8, shortestLoop: 338, reverseLoop: false }), "wind");
  assertEquals(f({ n: 0.05, a: 0, d: 0.17, shortestLoop: 170, reverseLoop: false }), "pluck");
  assertEquals(f({ n: 0, a: 0, d: 0.4, shortestLoop: 335, reverseLoop: false }), "keys");
});

Deno.test("the families sort the real tone bank: every instrument has one, and noisy ones are drums or effects", async () => {
  const engine = await import("../packages/shmup-engine/mod.js");
  const { MusicMakerIcons } = component();
  const fams = MusicMakerIcons.families(engine);
  assertEquals(fams.length, 60);
  const ids = new Set(MusicMakerIcons.FAMILIES.map((f: Any) => f.id));
  for (const e of fams) {
    assert(ids.has(e.family), `instrument ${e.inst}: ${e.family}`);
    assert(typeof e.name === "string" && e.name.length > 0);
    const noise = (engine.BGM_VOICE_ROWS as number[][][])[e.inst][0][7];
    if (noise >= 0.75) assert(e.family === "drums" || e.family === "fx", `instrument ${e.inst} is noisy but ${e.family}`);
  }
  // all eight families are in use
  assertEquals(new Set(fams.map((e: Any) => e.family)).size, 8);
});

// ---- the host: the editor's own functions, run live ------------------------

function editorFunction(name: string): string {
  const m = new RegExp(`\\n {8}(async )?function ${name}\\(`).exec(html);
  assert(m, `no ${name} in the editor`);
  const start = m.index + 1;
  const end = html.indexOf("\n        }\n", start);
  return html.slice(start, end + 10);
}

function live(names: string[], scope: Record<string, unknown>) {
  const noop = () => undefined;
  const proxy = new Proxy(scope, {
    has: (t, k) => typeof k === "string" && (k in t || !(k in globalThis)),
    get: (t, k) => (typeof k !== "string" ? undefined : k in t ? t[k] : k in globalThis ? (globalThis as Any)[k] : noop),
    set: (t, k, v) => {
      t[k as string] = v;
      return true;
    },
  });
  const body = names.map(editorFunction).join("\n");
  Object.assign(scope, new Function("scope", `with (scope) { ${body}\nreturn { ${names.join(", ")} }; }`)(proxy));
  return scope as Any;
}

Deno.test("a write from MUSIC lands in the game it was opened on, and a stale one is dropped", () => {
  let checks = 0;
  const game = { name: "a" } as Any;
  const s = live(["applyMusicBgm"], {
    gameData: game,
    musicGame: game,
    lineageCheckSoon: () => checks++,
  });
  s.applyMusicBgm({ songs: { 0: "AA==" }, edited: 1 });
  assertEquals(game.dezaemonBgm, { songs: { 0: "AA==" }, edited: 1 });
  assertEquals(checks, 1);
  // Another game loaded since: the write is dropped, the new game untouched.
  const other = { name: "b" } as Any;
  s.gameData = other;
  s.applyMusicBgm({ songs: {} });
  assertEquals(other.dezaemonBgm, undefined);
  assertEquals(checks, 1);
  // A null record clears it.
  s.gameData = game;
  s.applyMusicBgm(null);
  assertEquals("dezaemonBgm" in game, false);
});

Deno.test("SAVE, PLAY, EXPORT .SAV and the cloud save all land MUSIC's last edit first", () => {
  for (const fn of ["quickSave", "buildRuntimeRecipe", "buildLevelRecordForSav", "saveToFirebase"]) {
    assertMatch(editorFunction(fn), /flushMusic\(\)/, `${fn} does not flush MUSIC`);
  }
  // The play-test recipe is also what the editor reopens from after PLAY, so
  // the whole soundtrack rides along — stripping the bank lost every tape not
  // on a set-list row.
  assert(!/delete r\.dezaemonBgm/.test(editorFunction("buildRuntimeRecipe")));
});

Deno.test("a NEW GAME, a cart import or a folder load closes MUSIC on the game it replaced", () => {
  for (const fn of ["startNewGame", "applyDezaemonImportInner", "loadGameFilesFromFileList", "loadGameFiles"]) {
    assertMatch(editorFunction(fn), /musicGameReplaced\(\);/, `${fn} does not tell MUSIC`);
  }
  let discarded = 0, closed = 0;
  const a = { name: "a" }, b = { name: "b" };
  const s = live(["musicGameReplaced"], {
    musicOpen: true,
    musicGame: a,
    gameData: a,
    musicMaker: { discard: () => discarded++ },
    closeMusicMaker: () => closed++,
    flash: () => {},
  });
  s.musicGameReplaced();
  assertEquals([discarded, closed], [0, 0], "the same game: nothing to do");
  s.gameData = b;
  s.musicGameReplaced();
  assertEquals([discarded, closed], [1, 1]);
});

Deno.test("MUSIC waits for a cloud level still loading, and closes when another one lands", () => {
  assertMatch(editorFunction("openMusicMaker"), /await awaitCloudLoad\('MUSIC'\)/);
  assertMatch(editorFunction("loadFromFirebaseRecord"), /musicLevelReplaced\(\);/);
  let discarded = 0, closed = 0;
  const s = live(["musicLevelReplaced"], {
    musicOpen: true,
    musicMaker: { discard: () => discarded++ },
    closeMusicMaker: () => closed++,
  });
  s.musicLevelReplaced();
  assertEquals([discarded, closed], [1, 1]);
  s.musicOpen = false;
  s.musicLevelReplaced();
  assertEquals([discarded, closed], [1, 1]);
});

Deno.test("the other full-screen modes close MUSIC, and the theme reaches it", () => {
  assertMatch(editorFunction("openBossLab"), /if \(musicOpen\) closeMusicMaker\(\)/);
  assertMatch(editorFunction("openPixelEditor"), /if \(musicOpen\) closeMusicMaker\(\)/);
  assertMatch(editorFunction("applyTheme"), /musicMaker\.setTheme/);
  assertMatch(html, /<script src="\/editor\/music-maker\.js"><\/script>/);
  assertMatch(html, /<div id="music-maker-host"><\/div>/);
  assertMatch(html, /onclick="toggleMusicMaker\(\)"/);
});
