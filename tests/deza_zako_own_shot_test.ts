// A Dezaemon zako with no bank art fires its own projectile.
//
// dezaVolley re-skins every shot a Dezaemon-driven zako fires: the level's
// bullet bank (dezaemonBullets.art[fire.mode]) when it has one, then — new —
// the zako's own bulletData/projectileData frames, and only then the drawn
// ring. gs's Clevin (scripts/gs/add-clevin.ts) is deza2_02's pattern on a
// web level with no bank, and fired the ring instead of his geek badge. The
// runtime is game.bundle.js, a vendored artifact patched by hand (README).

import { assert, assertEquals } from "@std/assert";

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

Deno.test("dezaVolley: the bank's art, then the zako's own shot, then the ring", async () => {
  const src = functionSource(await read(BUNDLE), "dezaVolley");
  const bank = src.indexOf("scene.recipe.dezaemonBullets.art[fire.mode]");
  const own = src.indexOf(
    "bulletFramesInAtlas(scene, ownProj.texture || [], null)",
  );
  const ring = src.indexOf("if (!art) ensureZakoBulletTexture(scene);");
  assert(bank >= 0, "dezaVolley no longer reads the bank's art");
  assert(own >= 0, "dezaVolley no longer falls back to the zako's own shot");
  assert(ring >= 0, "dezaVolley no longer draws the ring when nothing else is");
  assert(bank < own && own < ring, "the order is bank, own shot, ring");
  // The own shot is the record's projectile slot, as spawnEnemyBullet reads it,
  // and only when the bank gave nothing.
  assert(src.includes('var ownProj = enemy.getData("projData");'));
  const guard = src.lastIndexOf("if (!art) {", own);
  assert(
    guard > bank && guard < own,
    "the own shot is tried only without bank art",
  );
  // Whatever was chosen is what every shot of the volley wears.
  assert(src.includes('bullet.setTexture("game_asset", art[0]);'));
});

Deno.test("the own shot keeps only frames the level's atlas carries", async () => {
  const js = await read(BUNDLE);
  const { bulletFramesInAtlas } = new Function(
    functionSource(js, "resolveFrame") +
      functionSource(js, "bulletFramesInAtlas") +
      "\nreturn { bulletFramesInAtlas };",
  )() as {
    bulletFramesInAtlas: (
      scene: unknown,
      frames: string[],
      fallback: string[] | null,
    ) => string[];
  };
  const scene = (frames: string[]) => {
    const have = new Set(frames);
    return { textures: { get: () => ({ has: (f: string) => have.has(f) }) } };
  };
  assertEquals(
    bulletFramesInAtlas(scene(["geekBadge_0"]), ["geekBadge_0"], null),
    ["geekBadge_0"],
  );
  // A shot whose art never reached this level is no shot: the ring draws.
  assertEquals(bulletFramesInAtlas(scene([]), ["geekBadge_0"], null), []);
  assertEquals(bulletFramesInAtlas(scene(["x"]), [], null), []);
});
