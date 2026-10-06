import { assertEquals } from "@std/assert";
import {
  legacyFrameName,
  normalizeLegacyAtlasFrames,
  normalizeLegacyGame,
} from "../src/legacy-names.js";

// The 2019 web game's names, as the 2028-ai base atlas and game.json spell
// them today. 2019-PS2 was saved from that game.json and its bullets drew
// nothing: every one of its 32 bullet frames was named for a sheet the
// runtime no longer has.

Deno.test("bullet frames take the current atlas's names", () => {
  const cases = {
    "normalTama0.gif": "normalProjectile0.gif",
    "vegaTama2.gif": "vegaProjectile2.gif",
    "barlog_tama1.gif": "barlog_projectile1.gif",
    "sagat_tamaA0.gif": "sagat_projectileA0.gif",
    "sagat_tamaB2.gif": "sagat_projectileB2.gif",
    "vega_tama3.gif": "vega_projectile3.gif",
    "fang_tamaC1.gif": "fang_projectileC1.gif",
    "goki_tamaB4.gif": "goki_projectileB4.gif",
    "caExplosion07.gif": "spExplosion07.gif",
    // The editor's Firebase spelling of a key.
    "normalTama0․gif": "normalProjectile0․gif",
  };
  for (const [from, to] of Object.entries(cases)) {
    assertEquals(legacyFrameName(from), to, from);
  }
});

Deno.test("names that are already current, or merely similar, are left alone", () => {
  for (
    const name of [
      "normalProjectile0.gif",
      "sagat_projectileA0.gif",
      "spExplosion00.gif",
      "Tamago.gif", // Tama not followed by a frame number
      "tama_boss0.gif",
      "duke_0", // no extension at all
      "vegasamazou.gif",
    ]
  ) {
    assertEquals(legacyFrameName(name), name);
  }
  assertEquals(legacyFrameName(undefined), undefined);
});

function legacyGame() {
  return {
    playerData: {
      name: "G",
      maxHp: 3,
      caDamage: 50,
      shootNormal: { damage: 1, texture: ["shot00.gif"] },
    },
    enemyData: {
      enemyA: {
        name: "soliderA",
        cagage: 4,
        texture: ["soliderA0.gif", "soliderA1.gif"],
        bulletData: {
          cagage: 2,
          texture: ["normalTama0.gif", "normalTama1.gif"],
        },
      },
      enemyD: {
        name: "tora",
        cagage: 10,
        texture: ["tora0.gif"],
        bulletData: null,
      },
    },
    bossData: {
      boss2: {
        name: "sagat",
        cagage: 30,
        anim: { idle: ["sagat_idle0.gif"], shoot: ["sagat_shoot0.gif"] },
        bulletDataA: {
          cagage: 2,
          texture: ["sagat_tamaA0.gif", "sagat_tamaA1.gif"],
        },
        bulletDataB: { cagage: 20, texture: ["sagat_tamaB0.gif"] },
      },
    },
    stage0: { enemylist: [["A0", "00"]] },
  };
}

Deno.test("a 2019 game.json comes up to today's names in place", () => {
  const game = legacyGame();
  const report = normalizeLegacyGame(game);

  assertEquals(game.playerData.spDamage, 50);
  assertEquals("caDamage" in game.playerData, false);
  assertEquals(game.enemyData.enemyA.spgage, 4);
  assertEquals("cagage" in game.enemyData.enemyA, false);
  assertEquals(game.enemyData.enemyA.bulletData.spgage, 2);
  assertEquals(game.enemyData.enemyA.bulletData.texture, [
    "normalProjectile0.gif",
    "normalProjectile1.gif",
  ]);
  assertEquals(game.enemyData.enemyD.spgage, 10);
  assertEquals(game.bossData.boss2.spgage, 30);
  assertEquals(game.bossData.boss2.bulletDataA.texture, [
    "sagat_projectileA0.gif",
    "sagat_projectileA1.gif",
  ]);
  assertEquals(game.bossData.boss2.bulletDataB.texture, [
    "sagat_projectileB0.gif",
  ]);
  // Frames that were already current, and the grid, are untouched.
  assertEquals(game.enemyData.enemyA.texture, [
    "soliderA0.gif",
    "soliderA1.gif",
  ]);
  assertEquals(game.bossData.boss2.anim.idle, ["sagat_idle0.gif"]);
  assertEquals(game.stage0.enemylist, [["A0", "00"]]);

  assertEquals(report.frames.length, 5);
  assertEquals(report.frames[0], {
    path: "enemyData.enemyA.bulletData.texture[0]",
    from: "normalTama0.gif",
    to: "normalProjectile0.gif",
  });
  assertEquals(
    report.fields.map((f) => f.path).sort(),
    [
      "bossData.boss2.bulletDataA.cagage",
      "bossData.boss2.bulletDataB.cagage",
      "bossData.boss2.cagage",
      "enemyData.enemyA.bulletData.cagage",
      "enemyData.enemyA.cagage",
      "enemyData.enemyD.cagage",
      "playerData.caDamage",
    ],
  );
});

Deno.test("running it again changes nothing", () => {
  const game = legacyGame();
  normalizeLegacyGame(game);
  const once = JSON.stringify(game);
  const report = normalizeLegacyGame(game);
  assertEquals(report, { frames: [], fields: [] });
  assertEquals(JSON.stringify(game), once);
});

Deno.test("a record that already has the new field keeps it and drops the old", () => {
  const game = { enemyData: { enemyA: { spgage: 7, cagage: 4, texture: [] } } };
  const report = normalizeLegacyGame(game);
  assertEquals(game.enemyData.enemyA, { spgage: 7, texture: [] });
  assertEquals(report.fields, [{
    path: "enemyData.enemyA.cagage",
    to: "spgage",
  }]);
});

Deno.test("a cloud record's flat fields are the same shape", () => {
  // Firebase levels carry enemyData/bossData/playerData at the top, like a
  // game.json, plus a playerData2 the editor may have added.
  const record = {
    name: "2019-PS2",
    enemylist: [["A0"]],
    enemyData: {
      enemyB: { cagage: 7, bulletData: { texture: ["vegaTama0.gif"] } },
    },
    playerData2: { caDamage: 50, texture: ["player00.gif"] },
  };
  const report = normalizeLegacyGame(record);
  assertEquals(record.enemyData.enemyB.bulletData.texture, [
    "vegaProjectile0.gif",
  ]);
  assertEquals(record.playerData2.spDamage, 50);
  assertEquals(report.frames.length, 1);
  assertEquals(report.fields.length, 2);
});

Deno.test("nothing to do on an empty or absent game", () => {
  assertEquals(normalizeLegacyGame(null), { frames: [], fields: [] });
  assertEquals(normalizeLegacyGame({}), { frames: [], fields: [] });
});

Deno.test("an atlas's keys follow, and a current key wins over its old twin", () => {
  const frames = normalizeLegacyAtlasFrames({
    "normalTama0.gif": { frame: { x: 0, y: 0, w: 4, h: 4 } },
    "barlog_tama0.gif": { frame: { x: 4, y: 0, w: 4, h: 4 } },
    "barlog_projectile0.gif": { frame: { x: 8, y: 0, w: 8, h: 8 } },
    "soliderA0.gif": { frame: { x: 16, y: 0, w: 4, h: 4 } },
  });
  assertEquals(Object.keys(frames).sort(), [
    "barlog_projectile0.gif",
    "barlog_tama0.gif",
    "normalProjectile0.gif",
    "soliderA0.gif",
  ]);
  assertEquals(frames["barlog_projectile0.gif"].frame.w, 8);
  assertEquals(normalizeLegacyAtlasFrames(null), null);
});
