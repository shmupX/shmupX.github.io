// A weapon record's `facing` turns its bullets to their heading.
//
// A bullet's art is drawn flying in some direction — the Character Library's
// `beam` is a horizontal bar — and the runtime (game.bundle.js, a vendored
// artifact patched by hand — README) only ever moved it, so a beam aimed at
// the ship flew broadside. A slot that names `facing`, the direction its art
// is drawn flying in degrees clockwise from right (0 = right, 90 = down),
// has each of its bullets rotated to its flight direction by
// faceBulletHeading, from every boss spawner that knows its direction: a
// Dezaemon boss's fire points and the stock routines' straight and aimed
// shots. A slot without it is never turned, as before. rando's first boss
// fires its beam this way (scripts/rando/first-boss-arms.ts).

import { assert, assertAlmostEquals, assertEquals } from "@std/assert";

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

async function faceBulletHeading() {
  const js = await read(BUNDLE);
  // faceBulletHeading snaps a quarter-turned bullet onto the pixel grid
  // (snapQuarterTurn; tests/quarter_turn_shot_test.ts), so it travels with it.
  return new Function(
    functionSource(js, "snapQuarterTurn") +
      functionSource(js, "faceBulletHeading") + "\nreturn faceBulletHeading;",
  )() as (
    bullet: { setRotation(r: number): void },
    projData: unknown,
    dirX: number,
    dirY: number,
  ) => void;
}

function bullet() {
  const b = {
    rotation: null as number | null,
    setRotation(r: number) {
      this.rotation = r;
    },
  };
  return b;
}

const deg = (r: number | null) => (r === null ? null : r * 180 / Math.PI);

Deno.test("a bullet turns from where its art faces to where it flies", async () => {
  const face = await faceBulletHeading();
  const beam = { facing: 0, texture: ["beam_0"] };
  // Drawn pointing right, fired straight down: a quarter turn.
  let b = bullet();
  face(b, beam, 0, 1);
  assertAlmostEquals(deg(b.rotation)!, 90);
  // Fired right: no turn at all.
  b = bullet();
  face(b, beam, 1, 0);
  assertAlmostEquals(deg(b.rotation)!, 0);
  // Aimed down and to the left: along the aim.
  b = bullet();
  face(b, beam, -Math.SQRT1_2, Math.SQRT1_2);
  assertAlmostEquals(deg(b.rotation)!, 135);
  // Art drawn flying down, fired down: no turn. Said as a string too, as
  // a record read back out of the database may spell a number.
  for (const facing of [90, "90"]) {
    b = bullet();
    face(b, { facing }, 0, 1);
    assertAlmostEquals(deg(b.rotation)!, 0, 1e-9, String(facing));
  }
});

Deno.test("a record without facing is never turned", async () => {
  const face = await faceBulletHeading();
  for (
    const projData of [{ texture: ["fireball0"] }, {}, null, undefined, {
      facing: "sideways",
    }, { facing: null }]
  ) {
    const b = bullet();
    face(b, projData, 0, 1);
    assertEquals(b.rotation, null, JSON.stringify(projData ?? null));
  }
});

Deno.test("every boss spawner that knows a bullet's direction turns it", async () => {
  const js = await read(BUNDLE);
  // The Dezaemon boss's fire points, with the direction they were given.
  assert(
    functionSource(js, "spawnDezaBossBullet").includes(
      "faceBulletHeading(bullet, projData, dirX, dirY);",
    ),
    "spawnDezaBossBullet",
  );
  // A stock routine's straight shot flies down...
  assert(
    functionSource(js, "bossShootStraight").includes(
      "faceBulletHeading(bullet, projData, 0, 1);",
    ),
    "bossShootStraight",
  );
  // ...and its aimed shot along its aim.
  assert(
    functionSource(js, "bossShootAimed").includes(
      "faceBulletHeading(bullet, projData, dx / dist, dy / dist);",
    ),
    "bossShootAimed",
  );
  // After the direction is set, so a reader sees the two together.
  const aimed = functionSource(js, "bossShootAimed");
  assert(
    aimed.indexOf('bullet.setData("rotY", dy / dist);') <
      aimed.indexOf("faceBulletHeading("),
  );
});
