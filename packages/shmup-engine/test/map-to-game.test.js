import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import { decodeBase64 } from "@std/encoding/base64";
import {
  BLANK_WAVES,
  buildBlankGame,
  BUILTIN_DEFAULTS,
  decodePlayerArt,
  DUKE_PLAYER,
  emptyWave,
  enemyLetters,
  ENGINE_SHOT_DAMAGE,
  EVIL_INVADERS_PLAYER,
  FRAMES_PER_SOURCE_ROW,
  GRID_COLS,
  mapSaveToGame,
  MAX_STAGES,
  PLAYER_SHOT_DAMAGE_BY_LEVEL,
  SINGLE_LETTER_ENEMIES,
} from "../src/map-to-game.js";
import { PLAYER_FRAMES } from "../src/player-art.js";
import { TROOPER_FRAMES, TROOPER_PLAYER } from "../src/player2-art.js";
import { validateGameJson } from "../src/game-schema.js";
import { normalize } from "../src/bup-source.js";
import * as bup from "../src/bup-parse.js";
import { decodeSave } from "../src/decode/index.js";
import { hasFixtures, loadFixture } from "./_fixtures.js";

const emptyDecoded = () => ({
  title: null,
  confidence: {},
  sprites: [],
  enemies: [],
  stages: [],
});

Deno.test("buildBlankGame produces a valid, immediately-playable game", () => {
  const g = buildBlankGame();
  const { ok, errors } = validateGameJson(g);
  assertEquals(errors, []);
  assert(ok);
  assertStrictEquals(g.stage0.enemylist.length, BLANK_WAVES);
  for (const row of g.stage0.enemylist) {
    assertEquals(row, new Array(GRID_COLS).fill("00"));
  }
  assert(g.enemyData.enemyA);
  assert(g.bossData.boss0);
  // The enemy and boss records reference the shipped atlas; the player's own
  // frames ride along in decodePlayerArt() instead.
  assertEquals(g.playerData.texture, BUILTIN_DEFAULTS.playerData.texture);
});

Deno.test("buildBlankGame clones defaults (no shared references)", () => {
  const g = buildBlankGame();
  g.enemyData.enemyA.hp = 999;
  assertStrictEquals(BUILTIN_DEFAULTS.starterEnemy.hp, 1);
});

Deno.test("mapSaveToGame on an undecoded save yields a valid skeleton", () => {
  const { gameJson, sprites, warnings } = mapSaveToGame(emptyDecoded(), {
    sourceEntry: { comment: "DEZA2 SGM", filename: "DEZA2____01" },
  });
  const { ok, errors } = validateGameJson(gameJson);
  assertEquals(errors, []);
  assert(ok);
  // The save decoded to nothing, but both ships still arrive with their art.
  assertStrictEquals(
    sprites.length,
    PLAYER_FRAMES.length + TROOPER_FRAMES.length,
  );
  assertStrictEquals(gameJson.meta.source, "dezaemon2");
  assertStrictEquals(gameJson.meta.sourceComment, "DEZA2 SGM");
  assertStrictEquals(gameJson.meta.sourceFilename, "DEZA2____01");
  // The skeleton is valid and playable, but it is empty — that has to be
  // said, or the import reads as a success until you press play.
  assert(warnings.some((w) => w.includes("no CG/sprite data decoded")));
  assert(warnings.some((w) => w.includes("no enemy table decoded")));
  assert(warnings.some((w) => w.includes("nothing will spawn")));
  assert(warnings.some((w) => w.includes("none of its content yet")));
});

Deno.test("a partial decode only warns about the parts that are still missing", () => {
  const decoded = emptyDecoded();
  decoded.enemies = [{ name: "zako", hp: 2 }];
  const { warnings } = mapSaveToGame(decoded);
  assert(!warnings.some((w) => w.includes("no enemy table decoded")));
  assert(warnings.some((w) => w.includes("no CG/sprite data decoded")));
  assert(warnings.some((w) => w.includes("nothing will spawn")));
  // The catch-all only fires when nothing at all came through.
  assert(!warnings.some((w) => w.includes("none of its content yet")));
});

Deno.test("mapSaveToGame is deterministic", () => {
  const a = mapSaveToGame(emptyDecoded());
  const b = mapSaveToGame(emptyDecoded());
  assertEquals(a, b);
});

Deno.test("enemy keys spill past enemyZ instead of the roster being cut at 26", () => {
  const decoded = emptyDecoded();
  decoded.enemies = Array.from({ length: 400 }, (_, i) => ({
    name: `zako${i}`,
    hp: i + 1,
  }));
  const { gameJson, warnings } = mapSaveToGame(decoded);
  assertStrictEquals(Object.keys(gameJson.enemyData).length, 400);
  assertStrictEquals(gameJson.enemyData.enemyA.name, "zako0");
  assertStrictEquals(gameJson.enemyData.enemyZ.name, "zako25");
  assertStrictEquals(gameJson.enemyData.enemyAA.name, "zako26");
  assertStrictEquals(gameJson.enemyData.enemyOJ.name, "zako399");
  assert(!warnings.some((w) => w.includes("dropped")));
  assert(validateGameJson(gameJson).ok);
});

Deno.test("enemyLetters is bijective base-26 — single letters first, then two", () => {
  assertStrictEquals(enemyLetters(0), "A");
  assertStrictEquals(enemyLetters(SINGLE_LETTER_ENEMIES - 1), "Z");
  assertStrictEquals(enemyLetters(SINGLE_LETTER_ENEMIES), "AA");
  assertStrictEquals(enemyLetters(SINGLE_LETTER_ENEMIES + 1), "AB");
  assertStrictEquals(enemyLetters(701), "ZZ");
  assertStrictEquals(enemyLetters(702), "AAA");
  // no two indices ever collide, which is what keeps spawns unambiguous
  const seen = new Set();
  for (let i = 0; i < 1000; i++) seen.add(enemyLetters(i));
  assertStrictEquals(seen.size, 1000);
});

Deno.test("the save's own definition bytes travel with each enemy", () => {
  const decoded = emptyDecoded();
  decoded.enemies = [
    {
      name: "zako",
      stage: 2,
      record: 7,
      placements: 5,
      bytes: new Uint8Array([0x3c, 0xb7, 0x00, 0x01]),
    },
  ];
  const { gameJson } = mapSaveToGame(decoded);
  assertEquals(gameJson.enemyData.enemyA.dezaemon, {
    stage: 2,
    record: 7,
    placements: 5,
    attributes: "3cb70001",
    // the engine's formation key for record 7 — placement cell byte 0x87
    placementId: 0x87,
  });
  // ...and the attributes themselves still come from the defaults, because
  // the record's field layout is not decoded yet
  assertStrictEquals(
    gameJson.enemyData.enemyA.hp,
    BUILTIN_DEFAULTS.starterEnemy.hp,
  );
});

Deno.test("stage rows are reversed into runtime order (last json row spawns first)", () => {
  const decoded = emptyDecoded();
  decoded.enemies = [{ name: "first" }];
  const spawnFirst = [
    { enemy: 0, drop: 2 },
    null,
    null,
    null,
    null,
    null,
    null,
    null,
  ];
  const spawnSecond = new Array(GRID_COLS).fill(null);
  decoded.stages = [{ rows: [spawnFirst, spawnSecond] }];
  const { gameJson } = mapSaveToGame(decoded);
  const list = gameJson.stage0.enemylist;
  assertStrictEquals(list.length, 2);
  // The first-spawned row must be LAST in the json (runtime reverses).
  assertStrictEquals(list[1][0], "A2");
  assertEquals(list[0], emptyWave());
});

Deno.test("all nine stages of a nine-stage save come across, each with a boss", () => {
  const decoded = emptyDecoded();
  decoded.stages = Array.from({ length: 9 }, () => ({
    rows: [new Array(GRID_COLS).fill(null)],
  }));
  const { gameJson, warnings } = mapSaveToGame(decoded);
  const stageKeys = Object.keys(gameJson).filter((k) => k.startsWith("stage"));
  assertStrictEquals(stageKeys.length, 9);
  for (let s = 0; s < 9; s++) {
    assert(gameJson.bossData[`boss${s}`], `boss${s} missing`);
  }
  assert(!warnings.some((w) => w.includes("dropped")));
  assert(validateGameJson(gameJson).ok);
});

Deno.test("only stages past the runtime's tenth are dropped, and it says so", () => {
  const decoded = emptyDecoded();
  decoded.stages = Array.from({ length: 12 }, () => ({
    rows: [new Array(GRID_COLS).fill(null)],
  }));
  const { gameJson, warnings } = mapSaveToGame(decoded);
  assertStrictEquals(
    Object.keys(gameJson).filter((k) => k.startsWith("stage")).length,
    MAX_STAGES,
  );
  assert(warnings.some((w) => w.includes("dropped 2")));
});

Deno.test("a wide grid keeps its width, and every spawn resolves", () => {
  const decoded = emptyDecoded();
  decoded.enemies = Array.from(
    { length: 40 },
    (_, i) => ({ name: `zako${i}` }),
  );
  const row = new Array(14).fill(null);
  row[0] = { enemy: 39, drop: 0 };
  row[13] = { enemy: 0, drop: 9 };
  decoded.stages = [{ rows: [row], cols: 14, waveRows: [12] }];
  const { gameJson } = mapSaveToGame(decoded);
  const wave = gameJson.stage0.enemylist[0];
  assertStrictEquals(wave.length, 14);
  assertStrictEquals(wave[0], "AN0"); // index 39 -> AN
  assertStrictEquals(wave[13], "A9");
  assert(validateGameJson(gameJson).ok);
});

Deno.test("wave pacing rides along, reversed in lockstep with the rows", () => {
  const decoded = emptyDecoded();
  decoded.enemies = [{ name: "only" }];
  const at = (row) => ({
    rows: row.map(() => new Array(GRID_COLS).fill(null)),
    waveRows: row,
  });
  decoded.stages = [at([10, 40, 41])];
  const { gameJson } = mapSaveToGame(decoded);
  // enemylist is reversed for the runtime, so waveRows must be too
  assertEquals(gameJson.stage0.waveRows, [41, 40, 10]);
  assertStrictEquals(gameJson.stage0.waveInterval, FRAMES_PER_SOURCE_ROW);
  assert(validateGameJson(gameJson).ok);
});

Deno.test("a stage's own boss art and placement are carried over", () => {
  const decoded = emptyDecoded();
  decoded.sprites = [
    { key: "dezaBoss0_0", w: 8, h: 8, rgba: new Uint8ClampedArray(256) },
    { key: "dezaBoss0_1", w: 8, h: 8, rgba: new Uint8ClampedArray(256) },
  ];
  decoded.stages = [
    { rows: [new Array(GRID_COLS).fill(null)] },
    { rows: [new Array(GRID_COLS).fill(null)] },
  ];
  decoded.bosses = [
    {
      stage: 0,
      sizeClass: 2,
      row: 479,
      col: 8,
      spriteKeys: [0, 1],
      coreArt: true,
    },
  ];
  const { gameJson } = mapSaveToGame(decoded);
  assertEquals(gameJson.bossData.boss0.anim.idle, [
    "dezaBoss0_0.gif",
    "dezaBoss0_1.gif",
  ]);
  // coreArt travels: the runtime keeps a painted core visible, and hides an
  // unpainted (figure-fallback) one over the chamber scenery.
  assertEquals(gameJson.bossData.boss0.dezaemon, {
    sizeClass: 2,
    row: 479,
    col: 8,
    coreArt: true,
  });
  // a stage the save gave no boss still ends, on the default one's art —
  // but under the import's own name, not the stock boss that shares the slot
  assertStrictEquals(gameJson.bossData.boss0.name, "dezaBoss0");
  assertStrictEquals(gameJson.bossData.boss1.name, "dezaBoss1");
  assertEquals(gameJson.bossData.boss1.anim, BUILTIN_DEFAULTS.starterBoss.anim);
  assert(validateGameJson(gameJson).ok);
});

Deno.test("boss part art maps sprite indices to atlas frame names", () => {
  const decoded = emptyDecoded();
  decoded.sprites = [
    { key: "dezaPart0_45_0", w: 32, h: 32, rgba: new Uint8ClampedArray(4096) },
    { key: "dezaPart0_46_0", w: 32, h: 32, rgba: new Uint8ClampedArray(4096) },
  ];
  decoded.stages = [{ rows: [new Array(GRID_COLS).fill(null)] }];
  decoded.bosses = [{
    stage: 0,
    sizeClass: 2,
    row: 479,
    col: 8,
    partArt: { 45: [0], 46: [1, 99] }, // 99: an index that resolved to nothing
  }];
  const { gameJson } = mapSaveToGame(decoded);
  assertEquals(gameJson.bossData.boss0.dezaemon.partArt, {
    45: ["dezaPart0_45_0.gif"],
    46: ["dezaPart0_46_0.gif"],
  });
  assert(validateGameJson(gameJson).ok);
});

Deno.test("fallback boss pieces become idle/attack forms, not an animation", () => {
  const decoded = emptyDecoded();
  decoded.sprites = [
    { key: "dezaBoss0_0", w: 8, h: 8, rgba: new Uint8ClampedArray(256) },
    { key: "dezaBoss0_1", w: 8, h: 8, rgba: new Uint8ClampedArray(256) },
  ];
  decoded.stages = [{ rows: [new Array(GRID_COLS).fill(null)] }];
  // no coreArt: the save painted no core, so the frames are figure pieces
  decoded.bosses = [
    { stage: 0, sizeClass: 2, row: 479, col: 8, spriteKeys: [0, 1] },
  ];
  const { gameJson } = mapSaveToGame(decoded);
  assertEquals(gameJson.bossData.boss0.anim.idle, ["dezaBoss0_0.gif"]);
  assertEquals(gameJson.bossData.boss0.anim.attack, ["dezaBoss0_1.gif"]);
  // and the record says so, so the runtime fights it as an invisible core
  // over the chamber scenery (Ramsie stage 0's statue boss).
  assertStrictEquals(gameJson.bossData.boss0.dezaemon.coreArt, false);
  assert(validateGameJson(gameJson).ok);
});

Deno.test("sprite keys are sanitized, .gif-suffixed, and deduped", () => {
  const decoded = emptyDecoded();
  decoded.sprites = [
    { key: "ship a.png", w: 8, h: 8, rgba: new Uint8ClampedArray(8 * 8 * 4) },
    { key: "ship a", w: 8, h: 8, rgba: new Uint8ClampedArray(8 * 8 * 4) },
    { key: null, w: 4, h: 4, rgba: new Uint8ClampedArray(4 * 4 * 4) },
  ];
  const { sprites } = mapSaveToGame(decoded);
  // The save's sprites come first, so decoded indices keep addressing them;
  // the two ships' own frames are appended after, player 1 then player 2.
  assertEquals(sprites.slice(0, 3).map((s) => s.key), [
    "ship_a.gif",
    "ship_a_2.gif",
    "deza_cg2.gif",
  ]);
  assertEquals(
    sprites.slice(3).map((s) => s.key),
    [...PLAYER_FRAMES, ...TROOPER_FRAMES].map((f) => f.key),
  );
});

Deno.test("an import always flies the Duke character, whatever the defaults say", () => {
  // The editor derives `defaults` from the game that happens to be open, and
  // its player can reference frames that live only in that level's atlas —
  // which the import drops. Taking the player from there would ship an
  // invisible ship firing invisible bullets, so it comes from the built-in
  // character instead.
  const customPlayer = {
    name: "borrowed",
    maxHp: 9,
    spDamage: 1,
    defaultShootName: "normal",
    defaultShootSpeed: "speed_normal",
    texture: ["someLevelOnlyShip0.gif"],
    shootNormal: {
      name: "normal",
      damage: 1,
      hp: 1,
      interval: 5,
      texture: ["someLevelOnlyShot0.gif"],
    },
    shootBig: {
      name: "big",
      damage: 1,
      hp: 1,
      interval: 5,
      texture: ["someLevelOnlyShot0.gif"],
    },
    shoot3way: {
      name: "3way",
      damage: 1,
      hp: 1,
      interval: 5,
      texture: ["someLevelOnlyShot0.gif"],
    },
    barrier: { time: 1, texture: ["someLevelOnlyBarrier0.gif"] },
  };
  const defaults = { ...BUILTIN_DEFAULTS, playerData: customPlayer };
  const { gameJson, sprites } = mapSaveToGame(emptyDecoded(), { defaults });

  assertEquals(gameJson.playerData, DUKE_PLAYER);
  assertEquals(gameJson.playerData.texture, [
    "duke_0",
    "duke_1",
    "duke_2",
    "duke_3",
  ]);
  assertEquals(gameJson.playerData.shootNormal.texture, [
    "bigProjectile_0.png",
    "bigProjectile_1.png",
    "bigProjectile_2.png",
    "bigProjectile_3.png",
  ]);
  assertEquals(gameJson.playerData.shootBig.texture, [
    "bigProjectile0.png",
    "bigProjectile1.png",
    "bigProjectile2.png",
  ]);
  assertEquals(gameJson.playerData.shoot3way.texture, [
    "hadoken0.png",
    "hadoken1.png",
  ]);
  assertStrictEquals(gameJson.playerData.barrier.texture.length, 10);

  // Every frame it references travels with the import, or the ship, its
  // shots and its shield would all draw as nothing.
  const packed = new Set(sprites.map((s) => s.key));
  const referenced = [
    ...gameJson.playerData.texture,
    ...gameJson.playerData.shootNormal.texture,
    ...gameJson.playerData.shootBig.texture,
    ...gameJson.playerData.shoot3way.texture,
    ...gameJson.playerData.barrier.texture,
  ];
  assertEquals(referenced.filter((f) => !packed.has(f)), []);

  // ...and it is a copy, so editing the imported game cannot mutate the
  // character every later import is seeded from.
  gameJson.playerData.texture.push("mutated.gif");
  assertStrictEquals(DUKE_PLAYER.texture.length, 4);
  // The enemy/boss halves of `defaults` are still honoured.
  assertStrictEquals(
    gameJson.enemyData.enemyA.name,
    BUILTIN_DEFAULTS.starterEnemy.name,
  );
});

Deno.test("the player's baked frames decode to real pixels at their atlas size", () => {
  const art = decodePlayerArt();
  assertStrictEquals(art.length, PLAYER_FRAMES.length);
  for (const f of art) {
    assert(f.w > 0 && f.h > 0, `${f.key} has a size`);
    assertStrictEquals(f.rgba.length, f.w * f.h * 4);
    let opaque = 0;
    for (let p = 3; p < f.rgba.length; p += 4) if (f.rgba[p]) opaque++;
    assert(opaque > 0, `${f.key} is not blank`);
  }
  // the ship, its shot and its shield, at the sizes the live game draws them
  const byKey = new Map(art.map((f) => [f.key, f]));
  assertEquals([byKey.get("duke_0").w, byKey.get("duke_0").h], [31, 38]);
  assertEquals(
    [byKey.get("bigProjectile_0.png").w, byKey.get("bigProjectile_0.png").h],
    [23, 8],
  );
  assertEquals(
    [byKey.get("shield0.png").w, byKey.get("shield0.png").h],
    [96, 96],
  );
});

Deno.test("New Game flies Duke, and his frames are baked in rather than referenced", () => {
  assertStrictEquals(BUILTIN_DEFAULTS.playerData, DUKE_PLAYER);
  assertEquals(buildBlankGame().playerData, DUKE_PLAYER);
  assertEquals(buildBlankGame().playerData.texture, [
    "duke_0",
    "duke_1",
    "duke_2",
    "duke_3",
  ]);
  // None of those live in assets/game_asset, so a caller seeding from here
  // has to add decodePlayerArt() to the atlas or the ship draws as nothing.
  const baked = new Set(decodePlayerArt().map((f) => f.key));
  const p = buildBlankGame().playerData;
  const referenced = [
    ...p.texture,
    ...p.shootNormal.texture,
    ...p.shootBig.texture,
    ...p.shoot3way.texture,
    ...p.barrier.texture,
  ];
  assertEquals(referenced.filter((f) => !baked.has(f)), []);
});

Deno.test("the stock Evil Invaders player stays available as the pixel-free fallback", () => {
  // src/phaser/game-objects/Player.js and Bullet.js hardcode these same keys
  // as their fallbacks, and every one is a frame in assets/game_asset.
  assertEquals(EVIL_INVADERS_PLAYER.texture, [
    "player00.gif",
    "player01.gif",
    "player02.gif",
    "player03.gif",
    "player04.gif",
    "player05.gif",
  ]);
});

Deno.test("enemies with decoded sprites get their texture repointed by sprite index", () => {
  const decoded = emptyDecoded();
  decoded.sprites = [{
    key: "zako",
    w: 8,
    h: 8,
    rgba: new Uint8ClampedArray(256),
  }];
  decoded.enemies = [{ name: "zako", spriteKeys: [0] }];
  const { gameJson } = mapSaveToGame(decoded);
  assertEquals(gameJson.enemyData.enemyA.texture, ["zako.gif"]);
});

Deno.test("a 2P save's second ship comes across as playerData2, art only", () => {
  const decoded = emptyDecoded();
  const cell = () => ({
    w: 32,
    h: 32,
    rgba: new Uint8ClampedArray(32 * 32 * 4),
  });
  decoded.sprites = [
    { key: "dezaShip0", ...cell() },
    { key: "dezaShip1", ...cell() },
    { key: "dezaShip20", ...cell() },
    { key: "dezaShip21", ...cell() },
  ];
  decoded.globalArt = { player: { idle: [0, 1] }, player2: { idle: [2, 3] } };
  const { gameJson } = mapSaveToGame(decoded);

  assertEquals(gameJson.playerData.texture, ["dezaShip0.gif", "dezaShip1.gif"]);
  assertStrictEquals(gameJson.playerData.name, "dezaShip");
  // P2 differs from P1 only in its frames — Dezaemon gives each ship a config
  // block, not its own bullets — so the record carries nothing else.
  assertEquals(gameJson.playerData2, {
    name: "dezaShip2",
    texture: ["dezaShip20.gif", "dezaShip21.gif"],
  });
  const { ok, errors } = validateGameJson(gameJson);
  assertEquals(errors, []);
  assert(ok);
});

Deno.test("a save that drew no second ship falls back to the trooper", () => {
  const decoded = emptyDecoded();
  decoded.sprites = [{
    key: "dezaShip0",
    w: 32,
    h: 32,
    rgba: new Uint8ClampedArray(32 * 32 * 4),
  }];
  decoded.globalArt = { player: { idle: [0] } };
  const { gameJson, sprites } = mapSaveToGame(decoded);
  // Player 2 always has a ship: the trooper, whose frames ride along in
  // `sprites` exactly as Duke's do.
  assertEquals(gameJson.playerData2, TROOPER_PLAYER);
  for (const key of gameJson.playerData2.texture) {
    assert(sprites.some((s) => s.key === key), `${key} ships in sprites`);
  }
  assertEquals(validateGameJson(gameJson).errors, []);
});

Deno.test("both ship config blocks reach the runtime, P2's alongside P1's", () => {
  const decoded = emptyDecoded();
  const ship = (startLoadout, maxSpeed) => ({
    startLoadout,
    rapidParam: 3,
    maxSpeed,
    initialPower: 1,
    maxPower: 4,
    autofireFrames: 10,
    raw: [0x10 | startLoadout, 0, 0, 0],
  });
  decoded.settings = {
    gameMode: 2, // bit1 = 2P join-in
    ships: [ship(0, 5), ship(2, 3)],
    loadouts: [
      { main: 1, sub: 0, charge: 0, bomb: 0, bombVariant: false },
      { main: 2, sub: 0, charge: 0, bomb: 0, bombVariant: false },
      { main: 5, sub: 3, charge: 1, bomb: 2, bombVariant: true },
      { main: 7, sub: 0, charge: 0, bomb: 0, bombVariant: false },
    ],
    mainWeapon: 1,
    shotDamage: 20,
    staffRoles: ["", "", ""],
    sfxSet: 0,
  };
  const { gameJson } = mapSaveToGame(decoded);
  const m = gameJson.meta.dezaemonSettings;

  assert(m.twoPlayer, "game mode bit1 marks the save as 2P join-in");
  assertStrictEquals(m.ships.length, 2);
  // P2 starts on preset 2, so its main weapon is that preset's — and the
  // long-standing mainWeapon2P field still agrees with it.
  assertStrictEquals(m.ships[1].startLoadout, 2);
  assertStrictEquals(m.loadouts[m.ships[1].startLoadout].main, 5);
  assertStrictEquals(m.mainWeapon2P, 5);
  // The rest of P2's block rides along — join-in reads its own speed cap,
  // power levels and autofire cadence, not P1's.
  assertStrictEquals(m.ships[1].maxSpeed, 3);
  assertStrictEquals(m.ships[0].maxSpeed, 5);
  assertStrictEquals(m.ships[1].maxPower, 4);
  assertStrictEquals(m.ships[1].autofireFrames, 10);
});

Deno.test("decoded behavior lands on the runtime fields and rides along whole", () => {
  const decoded = emptyDecoded();
  decoded.enemies = [{
    name: "zako",
    stage: 0,
    record: 3,
    placements: 2,
    bytes: new Uint8Array(18),
    behavior: {
      appearance: 0,
      hp: 25600,
      animPeriod: 15,
      score: 500,
      ground: true,
      movePattern: 6,
      move: { mode: 2, flag: true },
      fire: {
        enabled: true,
        type: 2,
        count: 1,
        wide: false,
        param: 0,
        mode: 0,
        interval: 29,
        window: 16,
        direction: 0,
        directionEx: 0,
      },
      speedChange: {
        enabled: false,
        from: 1,
        to: 1,
        step: 0,
        repeat: 0,
        trigger: 0,
      },
      rotation: {
        enabled: true,
        mode: 1,
        from: 0,
        to: 180,
        step: 1.4,
        repeat: 2,
        trigger: 0,
      },
      scale: {
        enabled: true,
        axes: "xy",
        from: 0.5,
        to: 2,
        step: 0.01,
        repeat: 1,
        repeatY: 0,
        trigger: 0,
      },
      direction: {
        enabled: false,
        from: 180,
        to: 180,
        step: 0,
        repeat: 0,
        trigger: 0,
      },
    },
  }];
  const { gameJson } = mapSaveToGame(decoded);
  const rec = gameJson.enemyData.enemyA;
  // the fields the Phaser runtime already reads. hp decodes in engine
  // durability units and a full-power weapon-1 bullet is 5120 of them, so
  // 25600 units = 5 hits of the runtime's 1-damage shot.
  assertStrictEquals(rec.hp, 5);
  assertStrictEquals(rec.score, 500);
  // The record has no speed field; the roster default stands.
  assertStrictEquals(rec.speed, 0.8);
  assertStrictEquals(rec.interval, 29);
  // firing enemies get Saturn-pace bullets instead of the 1 px/frame crawl
  assertStrictEquals(rec.bulletData.speed, 2.5);
  // the full record for the behavior driver
  assertStrictEquals(rec.dezaemon.behavior.rotation.to, 180);
  assertStrictEquals(rec.dezaemon.behavior.scale.axes, "xy");
  assertStrictEquals(rec.dezaemon.behavior.ground, true);
  assert(validateGameJson(gameJson).ok);
});

Deno.test("an armoured enemy imports as indestructible", () => {
  // Record byte 2 bit 4 -> the engine's hit-attribute bit 0. A flagged target
  // has its hp rolled back to 0x7FFFFFFF the moment it is damaged (+0x8B80),
  // so it can never die; "infinity" is the runtime's own sentinel for that.
  const mk = (mode) => {
    const decoded = emptyDecoded();
    decoded.enemies = [{
      name: "zako",
      stage: 0,
      record: 3,
      placements: 2,
      bytes: new Uint8Array(18),
      behavior: {
        appearance: 0,
        hp: 25600,
        animPeriod: 15,
        score: 500,
        ground: false,
        movePattern: mode,
        move: { mode, flag: false },
        fire: {
          enabled: false,
          mode: 0,
          interval: 29,
          window: 16,
          direction: 0,
          directionEx: 0,
        },
        speedChange: {
          enabled: false,
          from: 1,
          to: 1,
          step: 0,
          repeat: 0,
          trigger: 0,
        },
        rotation: {
          enabled: false,
          from: 0,
          to: 0,
          step: 0,
          repeat: 0,
          trigger: 0,
          mode: 0,
        },
        scale: {
          enabled: false,
          from: 1,
          to: 1,
          step: 0,
          repeat: 0,
          trigger: 0,
          axes: "",
          repeatY: 0,
        },
        direction: {
          enabled: false,
          from: 0,
          to: 0,
          step: 0,
          repeat: 0,
          trigger: 0,
        },
        death: { mode: 0, param: 0, silent: false },
      },
    }];
    const { gameJson } = mapSaveToGame(decoded);
    assert(validateGameJson(gameJson).ok, "an infinity hp still validates");
    return gameJson.enemyData.enemyA.hp;
  };
  assertStrictEquals(mk(1), "infinity"); // bit0 set -> armoured
  assertStrictEquals(mk(3), "infinity"); // bit0 set alongside bit1
  assertStrictEquals(mk(0), 5); // no bits -> an ordinary 5-hit enemy
  assertStrictEquals(mk(2), 5); // bit1 only is "no collision", not armour
});

Deno.test({
  name: "an import ships the save's own soundtrack, only the songs it uses",
  ignore: !hasFixtures("ramsie.sav"),
  async fn() {
    const { data } = await normalize(loadFixture("ramsie.sav"));
    const d = decodeSave(bup.parse(data).find((s) => s.payload).payload.buffer);
    const { gameJson } = mapSaveToGame(d, {});
    const bgm = gameJson.dezaemonBgm;
    assert(bgm, "dezaemonBgm present");
    assertStrictEquals(bgm.sfxSet, d.settings.sfxSet);
    assertStrictEquals(bgm.stages.length, d.stageCount);
    // every referenced, non-empty song ships as a full raw slot
    for (const [idx, b64] of Object.entries(bgm.songs)) {
      assert(d.songs[idx].noteCount > 0, `song ${idx} has notes`);
      const rawLen = Math.floor(b64.replace(/=+$/, "").length * 3 / 4);
      assertStrictEquals(rawLen, 4228);
    }
    // and every table entry that points at a non-empty song is shipped
    for (const pair of bgm.stages) {
      for (const idx of pair) {
        if (d.songs[idx] && d.songs[idx].noteCount) {
          assert(bgm.songs[idx] !== undefined, `stage song ${idx} shipped`);
        }
      }
    }
  },
});

Deno.test("LIFE units convert through the engine's traced shot damage", () => {
  // The normal shot's power-level table, read from GAME.CMP +0x6085e14 by
  // the spawn at +0x10bbe. Full power = 21 units per shot.
  assertEquals(PLAYER_SHOT_DAMAGE_BY_LEVEL, [9, 12, 15, 18, 21]);
  // The fallback divisor is weapon 1 in LIFE units, not that refuted table's
  // last entry: with the * 256 rebase it has to land on exactly 5120 raw.
  assertStrictEquals(ENGINE_SHOT_DAMAGE, 20);
  assertStrictEquals(ENGINE_SHOT_DAMAGE * 256, 5120);
  // The hp ladder (record byte 2 bits0-2, in durability units) lands on hit
  // counts of a 1-damage runtime shot. The divisor is the full-power bullet
  // in the SAME units — 5120 for weapon 1, i.e. shotDamage << 8 — not the
  // LIFE-unit shotDamage the enemies used to be sized against.
  const HP_UNITS = [256, 12800, 25600, 51200, 102400, 204800, 256000, 512000];
  assertEquals(
    HP_UNITS.map((u) => Math.max(1, Math.ceil(u / (20 * 256)))),
    [1, 3, 5, 10, 20, 40, 50, 100],
  );
});

Deno.test("an appearance that cannot fire maps to interval -1", () => {
  const decoded = emptyDecoded();
  decoded.enemies = [{
    name: "quiet",
    stage: 0,
    record: 0,
    placements: 1,
    bytes: new Uint8Array(18),
    behavior: {
      appearance: 0,
      hp: 1,
      score: 50,
      ground: false,
      speed: 0,
      movePattern: 0,
      fire: {
        enabled: false,
        type: 0,
        count: 1,
        wide: false,
        param: 0,
        mode: 0,
        interval: 119,
        window: 29,
        direction: 0,
        directionEx: 0,
      },
      speedChange: {
        enabled: false,
        from: 1,
        to: 1,
        step: 0,
        repeat: 0,
        trigger: 0,
      },
      rotation: {
        enabled: false,
        mode: 0,
        from: 0,
        to: 0,
        step: 0,
        repeat: 0,
        trigger: 0,
      },
      scale: {
        enabled: false,
        axes: "",
        from: 1,
        to: 1,
        step: 0,
        repeat: 0,
        repeatY: 0,
        trigger: 0,
      },
      direction: {
        enabled: false,
        from: 180,
        to: 180,
        step: 0,
        repeat: 0,
        trigger: 0,
      },
    },
  }];
  const { gameJson } = mapSaveToGame(decoded);
  assertStrictEquals(gameJson.enemyData.enemyA.interval, -1);
});

Deno.test("stage backgrounds emit a valid tile grid over packed cells", () => {
  const decoded = emptyDecoded();
  decoded.stages = [{ rows: [new Array(GRID_COLS).fill(null)] }];
  decoded.bgCells = [
    {
      key: "dezaBgCell5",
      w: 16,
      h: 16,
      rgba: new Uint8ClampedArray(16 * 16 * 4),
    },
    {
      key: "dezaBgCell9",
      w: 16,
      h: 16,
      rgba: new Uint8ClampedArray(16 * 16 * 4),
    },
  ];
  const words = new Uint16Array(2 * 14).fill(0xffff);
  words[0] = 0; // cell 0, no flips
  words[1] = 0x8001; // cell 1, h-flipped
  decoded.bgStages = [{ rows: 2, cols: 14, words }];
  const { gameJson, sprites } = mapSaveToGame(decoded);
  assertEquals(gameJson.backgroundCells, [
    "dezaBgCell5.gif",
    "dezaBgCell9.gif",
  ]);
  const bg = gameJson.stage0.background;
  assertStrictEquals(bg.rows, 2);
  assertStrictEquals(bg.cols, 14);
  // the packed cells are in the atlas sprite list
  const keys = sprites.map((s) => s.key);
  assert(keys.includes("dezaBgCell5.gif"));
  assert(keys.includes("dezaBgCell9.gif"));
  const v = validateGameJson(gameJson);
  assertEquals(v.errors, []);
  // round-trip the base64 back to the words
  const bin = decodeBase64(bg.tiles);
  assertStrictEquals((bin[0] << 8) | bin[1], 0);
  assertStrictEquals((bin[2] << 8) | bin[3], 0x8001);
  assertStrictEquals((bin[4] << 8) | bin[5], 0xffff);
});

Deno.test("an import skips the story scenes by default, and its title art maps to frames", () => {
  const decoded = emptyDecoded();
  decoded.sprites = [
    {
      key: "dezaTitle1",
      w: 106,
      h: 30,
      rgba: new Uint8ClampedArray(106 * 30 * 4),
    },
    {
      key: "dezaTitle2",
      w: 128,
      h: 64,
      rgba: new Uint8ClampedArray(128 * 64 * 4),
    },
    {
      key: "dezaCredit",
      w: 57,
      h: 13,
      rgba: new Uint8ClampedArray(57 * 13 * 4),
    },
  ];
  decoded.titleArt = { title1: 0, title2: 1, credit: 2 };
  const { gameJson } = mapSaveToGame(decoded);
  // The Saturn has no adventure interludes — AdvScene is skipped unless the
  // author flips the editor's NO STORY toggle back off.
  assertStrictEquals(gameJson.noStory, true);
  assertEquals(gameJson.dezaemonTitle, {
    title1: "dezaTitle1.gif",
    title2: "dezaTitle2.gif",
    credit: "dezaCredit.gif",
  });
  assert(validateGameJson(gameJson).ok);
});

Deno.test("a save with no painted title carries no dezaemonTitle at all", () => {
  const { gameJson } = mapSaveToGame(emptyDecoded());
  assertStrictEquals(gameJson.noStory, true);
  assertStrictEquals(gameJson.dezaemonTitle, undefined);
});
