// lib/ps2/runtime-patches.ts "game scene: published" — the handle the parity
// pilot (scripts/testdrive-parity.ts) reads the PS2 web build's game scene
// through. The real bundle is checked too when a build has cached one.

import { assert, assertEquals, assertThrows } from "@std/assert";
import { join } from "@std/path";
import { patchRuntime } from "../lib/ps2/runtime-patches.ts";
import { repoRoot } from "../lib/repo-root.ts";
import { ENEMY_ANCHORS } from "./support/port_anchors.ts";

/** Enough of the port for every patch's anchor, as the bundler writes it. */
const STAND_IN = [
  "function playerOnDamage(ctx2, p, amount) {",
  "  p.hp -= amount;",
  "}",
  "function createBoss(ctx2, data, stageId) {",
  "}",
  "function bossLoop(ctx2, b) {",
  "  const bMul = ctx2.state.turboMode ? 2 : 1;",
  "  b.moveTimer += bMul;",
  "  if (b.attackCooldown <= 0) {",
  "    bossAttack(ctx2, b);",
  "  }",
  "}",
  "function bossDraw(ctx2, b) {",
  "}",
  "function createProjectile(data) {",
  "}",
  "function projectileLoop(ctx2, proj, player) {",
  "}",
  "function projectileDraw(ctx2, proj) {",
  "}",
  // What a Dezaemon zako, enemy contact and the ship's blink anchor on
  // (tests/ps2_deza_zako_test.ts, tests/ps2_enemy_contact_test.ts).
  ...ENEMY_ANCHORS,
  "function createGameFont(rt, vp) {",
  '  const font = new rt.Font("default");',
  "  font.scale = vp.scale;",
  "  return font;",
  "}",
  "function createGameScene(ctx2, net = null) {",
  "  const gs = {",
  "    waveInterval: 80,",
  "    boss: null,",
  "  };",
  "  return { gs };",
  "}",
].join("\n");

Deno.test("the game scene publishes a getter for its own state", () => {
  const patched = patchRuntime(STAND_IN);
  assert(
    patched.includes(
      "function createGameScene(ctx2, net = null) {\n" +
        "  globalThis.__PS2_GS__ = () => gs;\n" +
        "  const gs = {",
    ),
    patched,
  );
  // It works: the getter answers the state the scene made.
  const g = globalThis as { __PS2_GS__?: () => unknown };
  const scene = new Function(
    patched.slice(patched.indexOf("function createGameScene")) +
      "\nreturn createGameScene({});",
  )() as { gs: unknown };
  try {
    assertEquals(g.__PS2_GS__?.(), scene.gs);
  } finally {
    delete g.__PS2_GS__;
  }
  assertThrows(
    () => patchRuntime(STAND_IN.replace("  const gs = {", "  let gs = {")),
    Error,
    'patch "game scene: published"',
  );
});

Deno.test("the text face is the build's own, at its scale, else the built-in", () => {
  const patched = patchRuntime(STAND_IN);
  const start = patched.indexOf("function createGameFont");
  const make = new Function(
    patched.slice(start, patched.indexOf("function createGameScene")) +
      "\nreturn createGameFont;",
  )() as (rt: unknown, vp: unknown) => { path: string; scale: number };
  class Font {
    scale = 1;
    constructor(public path: string) {}
  }
  const g = globalThis as Record<string, unknown>;
  try {
    // A build that ships Orbitron (lib/ps2/build.ts) names it and its scale.
    g.__PS2_FONT__ = "assets/fonts/orbitron.ttf";
    g.__PS2_FONT_SCALE__ = 0.6;
    const own = make({ Font }, { scale: 2 });
    assertEquals([own.path, own.scale], ["assets/fonts/orbitron.ttf", 1.2]);
    // One that ships none keeps AthenaEnv's own at the port's scale.
    delete g.__PS2_FONT__;
    delete g.__PS2_FONT_SCALE__;
    const stock = make({ Font }, { scale: 2 });
    assertEquals([stock.path, stock.scale], ["default", 2]);
  } finally {
    delete g.__PS2_FONT__;
    delete g.__PS2_FONT_SCALE__;
  }
});

Deno.test("the real bundle carries the anchor, when a build has cached one", async () => {
  const cached = join(repoRoot(), "build", "ps2", ".cache", "main.js");
  let js: string;
  try {
    js = await Deno.readTextFile(cached);
  } catch {
    return; // no PS2 build on this checkout
  }
  // The cache holds the bundler's own output; the patches go on as it is
  // handed out, so patching it here is what a build does.
  const patched = patchRuntime(js);
  assert(patched.includes("globalThis.__PS2_GS__ = () => gs;"));
  assert(patched.includes('new rt.Font(globalThis.__PS2_FONT__ || "default")'));
});
