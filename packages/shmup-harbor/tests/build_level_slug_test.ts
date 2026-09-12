// The build slug: one rule, two implementations.
//
// `slugify` in tools/build-level/lib/slug.js names the build tree
// (build/<slug>/), every artifact in it (<slug>.exe, <slug>.AppImage,
// <slug>-app-debug.apk) and, through packageIdFor, the Android package id.
// `slugFor` in lib/export-build.ts is the Deno mirror the server uses to find
// what the tool wrote, and scripts/build-desktop.ts imports that one rather
// than keeping a third copy. If the two ever disagree the build "succeeds" and
// the download 404s, so this runs the Node copy for real and compares.
//
// tools/build-level is excluded from deno.json's fmt/lint/check, so this file
// is the only automated coverage it has. (game-id.js's header has claimed since
// forever that a tests/build_level_game_id_test.ts cross-checks it against
// 2019-es7; that file has never existed. This one at least covers the slug.)

import { assertEquals, assertNotEquals } from "@std/assert";
import { join } from "@std/path";
import { slugFor } from "../lib/export-build.ts";
import { harborRoot } from "../lib/repo-root.ts";

const ROOT = harborRoot();

/** Names that exercise every branch, plus the ones that used to collide. */
const NAMES = [
  // Ordinary Latin: unchanged by the digest rule, and the shapes the shelf
  // resolves by (tests/shelf_test.ts pins the lookup side of these).
  "2028 AI",
  "2028_ai",
  "2028-ai",
  "G-Fencer 755",
  "Dez 2 - Air Streamer -Ver.A-",
  "Mucha Kucha Fighter",
  "my game",
  "foo",
  "0707",
  "2",
  "class",
  // No ASCII alphanumerics at all — 111 of the 228 Japanese titles in
  // static/editor/dezaemon/games-db.json look like this.
  "エアストリーマー",
  "超速ストリンガー",
  "Мой уровень",
  "Ελληνικά",
  "🚀🚀",
  // A lone Latin fragment on the end of a non-Latin title: eight catalogue
  // titles reduce to the bare "2" this way.
  "ステージ2",
  "第2章",
  // Accented Latin, which loses the accent and so collides with its neighbours.
  "Café Niveau",
  "Cafe Niveau",
  // Past the 30-character cap, where two names share a prefix.
  "a".repeat(40),
  "a".repeat(40) + "b",
  // Degenerate input.
  "",
  "   ",
  "!!!",
];

/** What tools/build-level itself computes, in its own runtime. */
async function nodeSlugs(
  names: string[],
): Promise<{ slug: string; packageId: string }[]> {
  const script = `
    const { slugify, packageIdFor } = require(${
    JSON.stringify(join(ROOT, "tools", "build-level", "lib", "slug.js"))
  });
    const names = JSON.parse(process.argv[1]);
    process.stdout.write(JSON.stringify(
      names.map((n) => ({ slug: slugify(n), packageId: packageIdFor(n) })),
    ));
  `;
  const out = await new Deno.Command("node", {
    args: ["-e", script, JSON.stringify(names)],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!out.success) {
    throw new Error(new TextDecoder().decode(out.stderr));
  }
  return JSON.parse(new TextDecoder().decode(out.stdout));
}

async function haveNode(): Promise<boolean> {
  try {
    return (await new Deno.Command("node", {
      args: ["--version"],
      stdout: "null",
      stderr: "null",
    }).output()).success;
  } catch (_e) {
    return false;
  }
}

const nodeAvailable = await haveNode();
if (!nodeAvailable) {
  console.log("  (build-level slug: skipped — no node on PATH)");
}

Deno.test({
  name: "the Deno mirror of slugify agrees with the Node original",
  ignore: !nodeAvailable,
  async fn() {
    const node = await nodeSlugs(NAMES);
    for (const [i, name] of NAMES.entries()) {
      assertEquals(
        slugFor(name),
        node[i].slug,
        `lib/export-build.ts slugFor drifted from the tool for ${
          JSON.stringify(name)
        }`,
      );
    }
  },
});

Deno.test("a name the slug can spell keeps its plain shape", () => {
  // These are the slugs the tool has always produced, and a build tree or an
  // artifact named this way must not move.
  assertEquals(slugFor("2028 AI"), "2028ai");
  assertEquals(slugFor("2028_ai"), "2028ai");
  assertEquals(slugFor("G-Fencer 755"), "gfencer755");
  assertEquals(slugFor("Dez 2 - Air Streamer -Ver.A-"), "dez2airstreamervera");
  assertEquals(slugFor("Mucha Kucha Fighter"), "muchakuchafighter");
  assertEquals(slugFor("my game"), "mygame");
  assertEquals(slugFor("0707"), "0707");
  assertEquals(slugFor("2"), "2");
  // No name at all has nothing to tell apart, so it keeps the bare constant.
  assertEquals(slugFor(""), "level");
  assertEquals(slugFor("   "), "level");
});

Deno.test("a name the slug cannot spell gets a digest of its own", () => {
  // The bug: every one of these used to be the literal "level", so they shared
  // one build/level/ tree, one level.exe and one com.easierbycode.level.
  const titles = [
    "エアストリーマー",
    "超速ストリンガー",
    "Мой уровень",
    "Ελληνικά",
    "🚀🚀",
    "!!!",
  ];
  const slugs = titles.map(slugFor);
  for (const [i, slug] of slugs.entries()) {
    assertEquals(
      slug.startsWith("level-"),
      true,
      `${titles[i]} should fall back to a digested "level"`,
    );
  }
  assertEquals(new Set(slugs).size, titles.length, "every title gets its own");
  // Stable across runs: the digest is of the name, not of the clock.
  assertEquals(slugFor("エアストリーマー"), slugs[0]);
});

Deno.test("a Latin fragment inside a non-Latin title does not stand alone", () => {
  // "ステージ2" reduced to "2" — the same slug a level actually called "2" gets.
  assertNotEquals(slugFor("ステージ2"), slugFor("2"));
  assertNotEquals(slugFor("ステージ2"), slugFor("第2章"));
  assertEquals(slugFor("ステージ2").startsWith("2-"), true);
});

Deno.test("dropping an accent no longer merges two names", () => {
  assertNotEquals(slugFor("Café Niveau"), slugFor("Cafe Niveau"));
});

Deno.test("two long names sharing a 30-character prefix stay apart", () => {
  const a = "a".repeat(40);
  assertNotEquals(slugFor(a), slugFor(a + "b"));
  assertEquals(slugFor(a).startsWith("a".repeat(30) + "-"), true);
});

Deno.test({
  name: "every digested slug is still a valid Android package segment",
  ignore: !nodeAvailable,
  async fn() {
    const names = [
      "エアストリーマー",
      "ステージ2",
      "🚀🚀",
      "Café Niveau",
      "class",
      "0707",
    ];
    const node = await nodeSlugs(names);
    const ids = node.map((r) => r.packageId);
    for (const id of ids) {
      // A segment must be [a-z_][a-z0-9_]*: the `-` a digest carries is
      // stripped by safePackageSegment, a leading digit gets an "a", and a
      // reserved word gets a "_".
      assertEquals(
        /^com\.easierbycode\.[a-z_][a-z0-9_]*$/.test(id),
        true,
        `${id} is not a valid package id`,
      );
    }
    assertEquals(new Set(ids).size, ids.length, "one package id per game");
  },
});

Deno.test("a non-Latin title survives sanitizeLevelName", async () => {
  // It used to strip everything outside ASCII \w, so the editor's EXPORT button
  // answered 400 "Missing or invalid 'level' name" for most community games —
  // the slug fix below it was unreachable from the UI.
  const { sanitizeLevelName } = await import("../lib/export-build.ts");
  assertEquals(sanitizeLevelName("エアストリーマー"), "エアストリーマー");
  assertEquals(sanitizeLevelName("Мой уровень"), "Мой уровень");
  assertEquals(sanitizeLevelName("Café Niveau"), "Café Niveau");
  // …while still refusing what makes a name dangerous as a path or an RTDB key.
  assertEquals(sanitizeLevelName("a/b.c#d$e[f]g"), "a_b_c_d_e_f_g");
  assertEquals(sanitizeLevelName("2028 AI"), "2028 AI");
  assertEquals(sanitizeLevelName("  spaced  "), "spaced");
});
