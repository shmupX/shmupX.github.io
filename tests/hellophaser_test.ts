// The cloud game hellophaser: RonaGun (easierbycode.com/hellophaser/v4/)
// converted by scripts/hellophaser/build-level.ts, with its music and its
// particle trails.
//
// Checked here: the record names every sprite the source's lanes and
// sentinels fly, packs every frame (trails included), passes the schema,
// plays the source's song as stage 0's BGM, and carries both of the source's
// emitters as `trail`; the committed static/games/hellophaser/game.json is
// what the converter builds; and the runtime's attachTrail is wired into the
// player, the zako and the boss.

import { assert, assertEquals } from "@std/assert";
import { validateGameJson } from "@shmupx/shmup-engine/game-schema";
import {
  buildLevel,
  crosserRows,
  descendRows,
  KY,
  parkX,
} from "../scripts/hellophaser/build-level.ts";
import {
  CROSSERS,
  EMITTERS,
  LANES,
  MUSIC_URL,
  SEDUCTRESS,
} from "../scripts/hellophaser/source.ts";

const build = await buildLevel();
const rec = build.record;

Deno.test("hellophaser: every lane sprite and sentinel is spawned", () => {
  const names = new Set(
    build.stage.spawns.map((s) => rec.enemyData[`enemy${s.letters}`].name),
  );
  const endS = -SEDUCTRESS.right / SEDUCTRESS.speed;
  for (const lane of LANES) {
    for (const r of lane.roster) {
      if (r.from < endS) assert(names.has(r.anim), `${r.anim} never spawns`);
    }
  }
  for (const c of CROSSERS) assert(names.has(c.anim), `${c.anim} never spawns`);
});

Deno.test("hellophaser: scripts fly straight down and straight across", () => {
  const [row] = descendRows(2 * KY);
  assertEquals(row[1], 0xc000);
  const { rows } = crosserRows(43.5, 35 * KY);
  assertEquals(rows[1][1], 0); // due right
  assert(parkX(43.5) >= -39, "a sentinel waits inside the runtime's cull line");
});

Deno.test("hellophaser: music and trails", () => {
  assertEquals(rec.customAudioURLs, { boss_bison_bgm: MUSIC_URL });
  assertEquals(rec.playerData.trail.speed, EMITTERS.lincoln.speed);
  assertEquals(rec.playerData.trail.blendMode, "ADD");
  const asteroid = Object.values(rec.enemyData).find((e: any) =>
    e.name === "asteroid"
  ) as any;
  assertEquals(asteroid.trail.scale, EMITTERS.asteroid.scale);
  for (const t of [rec.playerData.trail, asteroid.trail]) {
    for (const f of t.texture) assert(rec.atlasFrames[f], `${f} not packed`);
  }
});

Deno.test("hellophaser: the boss is the Seductress", () => {
  assertEquals(rec.bossData.boss0.name, "seductress");
  assertEquals(rec.bossData.boss0.hp, SEDUCTRESS.health);
});

Deno.test("hellophaser: the committed game.json is the converter's", async () => {
  const committed = JSON.parse(
    await Deno.readTextFile(
      new URL("../static/games/hellophaser/game.json", import.meta.url),
    ),
  );
  delete committed.savedAt;
  assertEquals(committed, JSON.parse(JSON.stringify(rec)));
});

Deno.test("schema: a trail needs a texture", () => {
  const stock = JSON.parse(
    Deno.readTextFileSync(
      new URL("../static/games/2028-ai/assets/game.json", import.meta.url),
    ),
  );
  const ok = validateGameJson({
    ...stock,
    playerData: { ...stock.playerData, trail: { texture: ["x"] } },
  });
  assert(ok.ok, ok.errors.join("; "));
  const bad = validateGameJson({
    ...stock,
    playerData: { ...stock.playerData, trail: { speed: 3 } },
  });
  assert(!bad.ok);
});

Deno.test("runtime: attachTrail is wired into the player, zako and boss", async () => {
  const src = await Deno.readTextFile(
    new URL("../static/games/2028-ai/game.bundle.js", import.meta.url),
  );
  assert(src.includes("function attachTrail(scene, sprite, trail)"));
  assert(src.includes("attachTrail(scene, enemy, data.trail);"));
  assert(src.includes("attachTrail(scene, p.sprite, pd && pd.trail);"));
  assert(src.includes("attachTrail(scene, scene.bossSprite, bossData.trail);"));
});
