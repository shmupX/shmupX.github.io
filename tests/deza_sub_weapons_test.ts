// SUB weapons 1-4 (H-MISSILE, S-MISSILE, G-MISSILE, RF-LASER) in the vendored
// game.bundle.js, pinned the way tests/deza_collision_test.ts pins the
// collision rules.
//
// What these hold is the part that is traced or surveyed: the cadence pair
// (+0x21C60 / +0x21C68), the damage tables' ends and their unit space, the
// surveyed OPTION-0 H-MISSILE volley (two objects of 13312), the slot
// reservation, and that the stock autofire no longer stands in. The flight
// geometry is provisional (the handlers at jump table +0x15150 entries 1-4 are
// not disassembled yet) and is deliberately NOT pinned here.

import { assert, assertEquals, assertStrictEquals } from "@std/assert";

const BUNDLE = "static/games/2028-ai/game.bundle.js";

const js = (await Deno.readTextFile(new URL(`../${BUNDLE}`, import.meta.url)))
  .replaceAll("\r\n", "\n");

/** One top-level function of the bundle's IIFE, by name, as source text. */
function functionSource(name: string): string {
  const start = js.indexOf(`\n  function ${name}(`);
  assert(start >= 0, `no ${name} in ${BUNDLE}`);
  const end = js.indexOf("\n  }\n", start);
  assert(end > start, `${name} does not close`);
  return js.slice(start, end + 4);
}

/** The SUB constant block: every `var DEZA_SUB…` statement, as source text. */
function subConstants(): string {
  const out: string[] = [];
  const re = /^ {2}var DEZA_SUB[\s\S]*?;$/gm;
  for (const m of js.matchAll(re)) out.push(m[0]);
  assert(out.length >= 4, "the DEZA_SUB_* constants moved");
  return "\n" + out.join("\n") + "\n";
}

type Bag = Record<string, unknown>;
type Shot = {
  active: boolean;
  x: number;
  y: number;
  vx: number;
  vy: number;
  damage: number;
  bag: Bag;
  getData(k: string): unknown;
  setData(k: string, v: unknown): void;
};

/** fireDezaSub over stubs: a 5120 divisor, shots recorded as they spawn. */
function rig() {
  const shots: Shot[] = [];
  const scene = { playerBullets: shots, playSound() {} };
  const prelude = `
    var SATURN_TICKS_PER_FRAME = 2;
    var DEZA_ANG = Math.PI * 2 / 256;
    function dezaPx(u) { return u / 128; }
    function dezaVel(u) { return u / (128 * SATURN_TICKS_PER_FRAME); }
    function dezaHitDamage(scene, units) { return units / 5120; }
    function dezaFrameDamage(scene, units) { return units / 5120 / SATURN_TICKS_PER_FRAME; }
    function spawnDezaPlayerShot(scene, p, x, y, vx, vy, damage) {
      var bag = { owner: p.index };
      var b = { active: true, x: x, y: y, vx: vx, vy: vy, damage: damage, bag: bag,
        getData: function (k) { return bag[k]; },
        setData: function (k, v) { bag[k] = v; } };
      scene.playerBullets.push(b);
      return b;
    }
  `;
  const fire = new Function(
    "scene",
    "p",
    "type",
    "L",
    prelude + subConstants() + functionSource("dezaLiveSubSlots") +
      functionSource("fireDezaSub") +
      "\nreturn fireDezaSub(scene, p, type, L);",
  ) as (scene: unknown, p: unknown, type: number, L: number) => number;
  const tables = new Function(
    subConstants() +
      "\nreturn { burst: DEZA_SUB_BURST, interval: DEZA_SUB_INTERVAL, damage: DEZA_SUB_DAMAGE, window: DEZA_SUB_SLOT_WINDOW };",
  )() as {
    burst: number[];
    interval: number[];
    damage: (number[] | null)[];
    window: number;
  };
  const p = { index: 0, sprite: { x: 100, y: 200 } };
  return { shots, scene, fire, tables, p };
}

Deno.test("the SUB cadence and damage tables are the engine's", () => {
  const { tables } = rig();
  assertEquals(tables.burst, [0, 1, 1, 1, 1, 1, 3, 0]); // +0x21C60
  assertEquals(tables.interval, [0, 24, 32, 10, 32, 1, 8, 0]); // +0x21C68
  // First and last entry of each table are the traced ones.
  const ends = tables.damage.slice(1).map((t) => [t![0], t![4]]);
  assertEquals(ends, [[13312, 5120], [19712, 11520], [256, 128], [1024, 1152]]);
  for (const t of tables.damage.slice(1)) assertStrictEquals(t!.length, 5);
});

Deno.test("H-MISSILE at OPTION 0 is the surveyed pair, 13312 units each, one hit apiece", () => {
  const { shots, scene, fire, p } = rig();
  assertStrictEquals(fire(scene, p, 1, 0), 2);
  assertStrictEquals(shots.length, 2);
  for (const s of shots) {
    assertStrictEquals(s.damage, 13312 / 5120);
    assertStrictEquals(s.bag.dezaPerFrame, undefined);
    assertStrictEquals(s.bag.dezaSubSlots, 1);
    // SUB shots have their own slots: they must not eat MAIN's 30-slot window.
    assertStrictEquals(s.bag.dezaSlots, undefined);
  }
  // Ramsie's D is 25600 units: two missiles, as ceil(25600 / 13312) says.
  assertStrictEquals(Math.ceil((25600 / 5120) / shots[0].damage), 2);
});

Deno.test("every SUB type and level bills its own table, in the cart's unit space", () => {
  for (let type = 1; type <= 4; type++) {
    for (let L = 0; L <= 4; L++) {
      const { shots, scene, fire, tables, p } = rig();
      const n = fire(scene, p, type, L);
      assert(n >= 2, `SUB ${type} L${L} fired ${n}`);
      const units = tables.damage[type]![L];
      const perFrame = type >= 3;
      for (const s of shots) {
        // A per-frame weapon is charged per runtime tick, two a Saturn frame.
        assertStrictEquals(
          s.damage,
          perFrame ? units / 5120 / 2 : units / 5120,
        );
        assertStrictEquals(!!s.bag.dezaPerFrame, perFrame);
        assert(s.vy < 0, "a SUB shot leaves the ship upward");
      }
    }
  }
});

Deno.test("a SUB volley is all or nothing against its own slot window", () => {
  const { shots, scene, fire, tables, p } = rig();
  let fired = 0;
  for (let i = 0; i < 20; i++) fired += fire(scene, p, 1, 0);
  assertStrictEquals(fired, tables.window);
  assertStrictEquals(shots.length, tables.window);
  // The other player's shots are not this player's slots.
  assertStrictEquals(fire(scene, { index: 1, sprite: p.sprite }, 1, 0), 2);
  // A shot that left frees its slot.
  shots[0].active = false;
  shots[1].active = false;
  assertStrictEquals(fire(scene, p, 1, 0), 2);
});

/** updateDezaWeapons over stubs: counts SUB dispatcher calls per Saturn frame. */
function gate(sub: number, held = false) {
  const calls: number[] = [];
  const run = new Function(
    "scene",
    "p",
    "held",
    "calls",
    `
    var SATURN_TICKS_PER_FRAME = 2;
    var DEZA_MAIN_BURST = [0, 3, 3, 1, 1, 6, 3, 2];
    var DEZA_MAIN_INTERVAL = [0, 6, 5, 12, 1, 3, 6, 28];
    var DEZA_CHARGE_BUSY = [0, 0, 0, 0];
    function dezaLoadout(scene, p) { return p.loadout; }
    function dezaShotLevel(p) { return 0; }
    function fireDezaMain() {}
    function fireDezaCharge() {}
    function dezaStepChargeAim() {}
    function fireDezaSub(scene, p, type, L) { calls.push(type); }
    ` + subConstants() + functionSource("dezaSubType") +
      functionSource("dezaMainType") + functionSource("dezaChargeType") +
      functionSource("updateDezaWeapons") +
      "\nreturn updateDezaWeapons(scene, p, held);",
  ) as (scene: unknown, p: unknown, held: boolean, calls: number[]) => void;
  const p = {
    index: 0,
    dead: false,
    sprite: { x: 0, y: 0 },
    loadout: { main: 2, sub, charge: 1 },
  };
  const scene = { playSound() {} };
  return {
    calls,
    frames(n: number) {
      for (let i = 0; i < n * 2; i++) run(scene, p, held, calls);
    },
  };
}

Deno.test("each SUB weapon fires once per reload: 24, 32, 10 and 32 frames", () => {
  for (const [sub, period] of [[1, 24], [2, 32], [3, 10], [4, 32]]) {
    const g = gate(sub);
    g.frames(period * 5);
    assertEquals(g.calls, new Array(5).fill(sub), `SUB ${sub}`);
    g.frames(1);
    assertStrictEquals(
      g.calls.length,
      6,
      `SUB ${sub} re-arms on the frame after`,
    );
  }
});

Deno.test("SUB 0 and the OPTION values never reach the shot handler", () => {
  for (const sub of [0, 5, 6, 7]) {
    const g = gate(sub);
    g.frames(100);
    assertEquals(g.calls, [], `SUB ${sub}`);
  }
});

Deno.test("a held charge silences MAIN but not SUB 1-4", () => {
  // charge_step locks the SUB only when its type is 7 (+0xA2EA).
  const g = gate(1, true);
  g.frames(24 * 4);
  assertStrictEquals(g.calls.length, 4);
});

Deno.test("the stock autofire stands down while SUB 1-4 is equipped", () => {
  const owns = new Function(
    "scene",
    "p",
    "function dezaLoadout(scene, p) { return p.loadout; }" +
      functionSource("dezaSubType") + functionSource("dezaSubOwnsShot") +
      "\nreturn dezaSubOwnsShot(scene, p);",
  ) as (scene: unknown, p: unknown) => boolean;
  for (let sub = 0; sub <= 7; sub++) {
    assertStrictEquals(owns({}, { loadout: { sub } }), sub >= 1 && sub <= 4);
  }
  assertStrictEquals(owns({}, { loadout: null }), false); // not a cart
  assert(
    js.includes(
      "if (p.dezaShotLocked || dezaSubOwnsShot(this, p)) p.shootTimer = 0;",
    ),
    "the autofire loop no longer asks dezaSubOwnsShot",
  );
});
