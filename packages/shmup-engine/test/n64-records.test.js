// n64/records.js: the records inside a Dezaemon 3D project's files, encoded
// from objects and decoded back, against the layouts in the translation's
// "file formats.txt". Every codec round-trips, every size is the documented
// one, the bit fields land in the documented bits, the range checks name the
// field. The last test re-encodes the cartridge's own initial save bank by
// bank and is ignore:-gated on fixtures/n64-sram/, which is not shipped.
import {
  assert,
  assertEquals,
  assertStrictEquals,
  assertThrows,
} from "@std/assert";
import {
  ACCOMPANIMENT_BYTES,
  ACCOMPANIMENT_OFFSET,
  billboardModel,
  BL_OFFSETS,
  BL_TAIL_BYTES,
  blankAccompaniment,
  blankScore,
  blankSong,
  buildCbl,
  buildCmdFile,
  buildMdFile,
  buildMusFile,
  buildStageBl,
  buildUlbFile,
  CBL_ITEMS,
  CBL_ITEMS_OFFSET,
  CMD_TEXTURE_INDEX_OFFSET,
  decodeEnemyEntry,
  decodeGam,
  decodeLayout,
  decodeLayoutEffect,
  decodeLayoutEntry,
  decodeMapEntry,
  decodeModel,
  decodeSong,
  decodeSongHeader,
  defaultHighScores,
  EFFECT_COMMANDS,
  encodeEnemyEntry,
  encodeGam,
  encodeLayout,
  encodeLayoutEffect,
  encodeLayoutEntry,
  encodeMapEntry,
  encodeModel,
  encodeSong,
  encodeSongHeader,
  ENEMY_ENTRY_BYTES,
  enemyEntryDefaults,
  GAM_OFFSETS,
  GAM_SPRITES,
  LAYOUT_BYTES,
  LAYOUT_ENTRY_BYTES,
  LAYOUT_MAX_ENEMIES,
  layoutIndices,
  MAP_TEXTURE_UNSET,
  mapEntryDefaults,
  MD_TEXTURE_INDEX_OFFSET,
  MODEL_BYTES,
  MODEL_OFFSETS,
  MUS_ECHO_TABLE,
  MUS_TEMPO_TABLE,
  parseCbl,
  parseCmdFile,
  parseMdFile,
  parseMusFile,
  parseStageBl,
  parseUlbFile,
  PITCH_SILENCE,
  PROTOTYPE_GAM_BYTES,
  PROTOTYPE_GAM_GAP,
  repairPrototypeGam,
  SCORE_BYTES,
  SONG_BYTES,
  SONG_COUNT,
  SONG_HEADER_BYTES,
  tileHeightPixels,
  tilePixels,
  ULB_TEXTURES_OFFSET,
} from "../src/n64/records.js";
import { DOCUMENTED_SIZES } from "../src/n64/directory.js";
import { TILE_BYTES } from "../src/n64/graphics.js";
import * as n64 from "../src/n64/index.js";
import { hasFixtures, loadFixture } from "./_fixtures.js";

const bytesAt = (b, at, n) => Array.from(b.subarray(at, at + n));

/** An enemy entry with every field away from its default. */
function fullEnemy() {
  return {
    score: 0xa,
    hp: 0xf,
    animation: { disabled: false, frameSpeed: 5, models: [1, 2, 3, 129] },
    flags: {
      rotationDisabled: false,
      scalingDisabled: true,
      transparencyDisabled: false,
      unknownBits: 0x1f,
    },
    altitude: {
      cue: 7,
      initial: 8,
      final: 1,
      speed: 6,
      rate: 2,
      loopType: 4,
      unknownBits: 7,
    },
    unknown11: 0x11,
    scale: 9999,
    scaling: { cue: 1, initial: 2, final: 3, speed: 4, loopType: 3 },
    rotation: {
      cue: 2,
      start: 255,
      end: 128,
      speed: 7,
      clockwise: true,
      axis: 2,
      look: 3,
      loopType: 1,
      unknownBits1B: 0x1f,
      unknownBits1C: 0xf,
    },
    motion: {
      birth: 7,
      in: 1,
      type: 1,
      orbit1: 0x1d,
      orbit2: 0x13,
      orbit3: 0x12,
      speed1: 1,
      speed2: 2,
      speed3: 3,
      death: 5,
      deathEnabled: true,
    },
    shots: [
      {
        type: 3,
        direction: 1,
        variant: 0xf,
        speed: 7,
        aimAtPlayer: true,
        timing: 7,
        unknownBits: 1,
        unknownBits24: 1,
        launchedEnemy: 179,
        x: -32768,
        y: 32767,
        z: -1,
        se: 100,
        seVolume: 7,
      },
      {
        type: 1,
        direction: 0,
        variant: 2,
        speed: 1,
        aimAtPlayer: false,
        timing: 2,
        unknownBits: 0,
        unknownBits24: 0,
        launchedEnemy: -1,
        x: 1,
        y: 2,
        z: 3,
        se: -1,
        seVolume: 0,
      },
      {
        type: 2,
        direction: 1,
        variant: 1,
        speed: 4,
        aimAtPlayer: true,
        timing: 0,
        unknownBits: 1,
        unknownBits24: 1,
        launchedEnemy: 0,
        x: -4,
        y: -5,
        z: -6,
        se: 7,
        seVolume: 1,
      },
    ],
    unknown2D: 0x2d,
    hit: {
      lockOn: true,
      stageClear: true,
      hpMode: 3,
      size: 7,
      x: 100,
      y: -200,
      z: 300,
      unknownBits: 0xf,
    },
    blast: {
      pattern: 3,
      type: 1,
      particle: true,
      scale: 2,
      se: 99,
      seVolume: 7,
      unknownBits: 3,
    },
    item: { enabled: true, value: 6 },
    enemySet: 42,
    enemyRise: -1,
    unknown47: 0x47,
    transparency: { cue: 1, initial: 2, final: 3, speed: 4, loopType: 2 },
    unknown5B: 0x5b,
  };
}

// --- sizes -------------------------------------------------------------------

Deno.test("every record and file size is the documented one", () => {
  assertStrictEquals(ENEMY_ENTRY_BYTES, 0x5c);
  assertStrictEquals(LAYOUT_ENTRY_BYTES, 0xc);
  assertStrictEquals(LAYOUT_BYTES, 0x2f04);
  assertEquals(
    { ...BL_OFFSETS },
    {
      enemies: 0,
      layout: 0x40b0,
      mapSettings: 0x6fb4,
      map: 0x6fb7,
      effects: 0x73b7,
      tail: 0x8b27,
    },
  );
  assertStrictEquals(BL_OFFSETS.tail + BL_TAIL_BYTES, DOCUMENTED_SIZES.BL);
  assertStrictEquals(buildStageBl().length, 0x8b37);
  assertStrictEquals(CBL_ITEMS_OFFSET, 0x730);
  assertStrictEquals(
    CBL_ITEMS_OFFSET + CBL_ITEMS.length * ENEMY_ENTRY_BYTES,
    DOCUMENTED_SIZES.CBL,
  );
  assertStrictEquals(buildCbl().length, 0x9b4);
  assertStrictEquals(MODEL_BYTES, 0xc20);
  assertStrictEquals(encodeModel().length, 0xc20);
  assertStrictEquals(MD_TEXTURE_INDEX_OFFSET, 0x62840);
  assertStrictEquals(buildMdFile().length, DOCUMENTED_SIZES.MD);
  assertStrictEquals(CMD_TEXTURE_INDEX_OFFSET, 0xf280);
  assertStrictEquals(buildCmdFile().length, DOCUMENTED_SIZES.CMD);
  assertStrictEquals(ULB_TEXTURES_OFFSET, 0x6100);
  assertStrictEquals(buildUlbFile().length, DOCUMENTED_SIZES.ULB);
  assertStrictEquals(encodeGam().length, DOCUMENTED_SIZES.GAM);
  assertStrictEquals(SONG_BYTES, 0x2c9a);
  assertStrictEquals(
    SONG_HEADER_BYTES + SCORE_BYTES + ACCOMPANIMENT_BYTES,
    SONG_BYTES,
  );
  assertStrictEquals(ACCOMPANIMENT_OFFSET, 0x109a);
  assertStrictEquals(blankSong().length, SONG_BYTES);
  assertStrictEquals(SONG_COUNT * SONG_BYTES, DOCUMENTED_SIZES.MUS);
  assertStrictEquals(buildMusFile().length, 0x42e70);
});

// --- the enemy entry ----------------------------------------------------------

Deno.test("an enemy entry round-trips every field", () => {
  const entry = fullEnemy();
  const bytes = encodeEnemyEntry(entry);
  assertStrictEquals(bytes.length, ENEMY_ENTRY_BYTES);
  assertEquals(decodeEnemyEntry(bytes), entry);
  assertEquals(encodeEnemyEntry(decodeEnemyEntry(bytes)), bytes);
  // the defaults fill in whatever is not given, and are a plain enemy
  const plain = encodeEnemyEntry({ hp: 3 });
  assertEquals(decodeEnemyEntry(plain), { ...enemyEntryDefaults(), hp: 3 });
});

Deno.test("the enemy entry's bit fields land in the documented bits", () => {
  const b = encodeEnemyEntry({
    animation: { disabled: true, frameSpeed: 3 },
    flags: {
      rotationDisabled: true,
      scalingDisabled: false,
      transparencyDisabled: true,
    },
    altitude: { rate: 2, loopType: 4 },
    scale: 9999,
    rotation: { clockwise: true, axis: 2, look: 3, loopType: 2 },
    shots: [
      {
        type: 3,
        direction: 1,
        variant: 0xf,
        speed: 5,
        aimAtPlayer: true,
        timing: 7,
      },
      { type: 2, se: -1 },
      { x: -2 },
    ],
    hit: { lockOn: true, stageClear: true, hpMode: 3 },
    blast: { pattern: 3, type: 1, particle: true, scale: 2 },
    item: { enabled: true, value: 6 },
    motion: { deathEnabled: true, death: 5 },
    enemySet: -1,
  });
  assertStrictEquals(b[0x4], 0x83);
  assertStrictEquals(b[0x9], 0xa0);
  assertStrictEquals(b[0xe], 0x82);
  assertEquals(bytesAt(b, 0x12, 2), [0x27, 0x0f]);
  assertStrictEquals(b[0x1b], 0x82);
  assertStrictEquals(b[0x1c], 0xc2);
  assertStrictEquals(b[0x24], 0xef);
  assertStrictEquals(b[0x25], 0x80);
  assertStrictEquals(b[0x27], 0xb7);
  assertEquals(bytesAt(b, 0x32, 2), [0xff, 0xfe]);
  assertStrictEquals(b[0x40], 0xc3);
  assertStrictEquals(b[0x42], 0x3e);
  assertStrictEquals(b[0x43], 0x86);
  assertStrictEquals(b[0x44], 0xff);
  assertStrictEquals(b[0x46], 0x85);
  assertStrictEquals(b[0x54], 0xff);
  // the plain entry: animation byte "initialized to -1", no models, every
  // effect disabled, enemy set/rise and the four SE numbers off, volumes 3
  const d = encodeEnemyEntry();
  assertStrictEquals(d[0x4], 0xff);
  assertEquals(bytesAt(d, 0x5, 4), [0xff, 0xff, 0xff, 0xff]);
  assertStrictEquals(d[0x9], 0xe0);
  assertEquals(bytesAt(d, 0x44, 2), [0xff, 0xff]);
  assertEquals(bytesAt(d, 0x53, 8), [0xff, 0xff, 0xff, 0xff, 3, 3, 3, 3]);
});

Deno.test("an enemy entry's range checks throw with the field's name", () => {
  const cases = [
    [{ hp: 16 }, "enemy.hp"],
    [{ scale: 10000 }, "enemy.scale"],
    [{ shots: [{}, { seVolume: 8 }] }, "enemy.shots[1].seVolume"],
    [{ motion: { orbit1: 0x1e } }, "enemy.motion.orbit1"],
    [{ altitude: { loopType: 5 } }, "enemy.altitude.loopType"],
    [{ item: { value: 7 } }, "enemy.item.value"],
    [{ shots: [{ x: 32768 }] }, "enemy.shots[0].x"],
    [{ enemySet: 255 }, "enemy.enemySet"],
    [{ hitpoints: 3 }, "enemy.hitpoints is not a field"],
    [{ shots: [{}, {}, {}, {}] }, "enemy.shots holds 3"],
  ];
  for (const [entry, message] of cases) {
    assertThrows(() => encodeEnemyEntry(entry), Error, message);
  }
  assertThrows(
    () => encodeEnemyEntry({ hp: 16 }, "items.shot"),
    Error,
    "items.shot.hp",
  );
});

// --- the layout --------------------------------------------------------------

Deno.test("a layout entry round-trips, and a terminator is enemy -1 over zeros", () => {
  const entry = {
    enemy: 7,
    unknown01: 0,
    x: -300,
    y: 472,
    unknown06: 0x1234,
    frame: -218,
  };
  const b = encodeLayoutEntry(entry);
  assertEquals(
    Array.from(b),
    [0x07, 0x00, 0xfe, 0xd4, 0x01, 0xd8, 0x12, 0x34, 0xff, 0xff, 0xff, 0x26],
  );
  assertEquals(decodeLayoutEntry(b), entry);
  assertEquals(
    Array.from(encodeLayoutEntry({ enemy: -1 })),
    [0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  );
  assertThrows(() => encodeLayoutEntry({ enemy: 255 }), Error, "enemy");
});

Deno.test("a layout lays its three layers end to end, each closed by a terminator", () => {
  const layout = {
    map: [{ enemy: 1, x: 10, y: 20, frame: -5 }, { enemy: 2, frame: -50 }],
    a: [{ enemy: 3, x: -1, y: -2, frame: 3 }],
    b: [{ enemy: 4 }, { enemy: 5, frame: -1000 }, { enemy: 6 }],
  };
  const bytes = encodeLayout(layout);
  assertStrictEquals(bytes.length, LAYOUT_BYTES);
  const enemyAt = (i) => bytes[i * LAYOUT_ENTRY_BYTES];
  assertEquals([0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(enemyAt), [
    1,
    2,
    0xff,
    3,
    0xff,
    4,
    5,
    6,
    0xff,
    0,
  ]);
  assert(bytes.subarray(9 * LAYOUT_ENTRY_BYTES).every((x) => x === 0));
  assertEquals(layoutIndices(layout), {
    map: 0,
    a: 3,
    b: 5,
    enemies: 6,
    slots: 9,
  });
  const back = decodeLayout(bytes);
  assertStrictEquals(back.map.length, 2);
  assertStrictEquals(back.a.length, 1);
  assertStrictEquals(back.b.length, 3);
  assertEquals(back.b[1], {
    enemy: 5,
    unknown01: 0,
    x: 0,
    y: 0,
    unknown06: 0,
    frame: -1000,
  });
  assertEquals(encodeLayout(back), bytes);
  // empty layers are three terminators in a row
  assertEquals(layoutIndices({}), { map: 0, a: 1, b: 2, enemies: 0, slots: 3 });
  assertEquals(decodeLayout(encodeLayout()), { map: [], a: [], b: [] });
  // the limit, and a terminator smuggled into a layer
  const many = Array.from({ length: 1001 }, (_, i) => ({ enemy: i % 180 }));
  assertThrows(() => encodeLayout({ map: many }), Error, "1000");
  assertThrows(
    () => encodeLayout({ a: [{ enemy: -1 }] }),
    Error,
    "layout.a[0].enemy is -1",
  );
});

// --- the map and the effects ------------------------------------------------------

Deno.test("an unterminated layout region reads as at most 1,000 enemies, so a zero #BL rebuilds", () => {
  // The first project writer wrote zero bytes for a stage's BL; its layout
  // region has no terminator, so every slot reads as enemy 0 at the origin —
  // 1,003 of them, more than encodeLayout takes. Reading stops at the 1,000
  // the format holds, and parseStageBl -> buildStageBl of a zero file works.
  const zero = decodeLayout(new Uint8Array(LAYOUT_BYTES));
  assertEquals(zero.map.length, LAYOUT_MAX_ENEMIES);
  assertEquals(zero.a, []);
  assertEquals(zero.b, []);
  const rebuilt = buildStageBl(
    parseStageBl(new Uint8Array(DOCUMENTED_SIZES.BL)),
  );
  assertEquals(rebuilt.length, DOCUMENTED_SIZES.BL);
});

Deno.test("the shot type bytes keep their undocumented bit, like every other packed byte", () => {
  // Bit 0x10 of 0x24..0x26 is not in the document; a stage that sets it must
  // re-encode byte for byte, which the field unknownBits24 is for (the
  // settings byte's own undocumented bit already owns `unknownBits`).
  const b = encodeEnemyEntry();
  b[0x24] = 0x10;
  b[0x25] = 0x30;
  b[0x26] = 0xff;
  const back = encodeEnemyEntry(decodeEnemyEntry(b));
  assertEquals([back[0x24], back[0x25], back[0x26]], [0x10, 0x30, 0xff]);
  assertEquals(decodeEnemyEntry(b).shots.map((sh) => sh.unknownBits24), [
    1,
    1,
    1,
  ]);
});

Deno.test("a map entry packs the effects word's six fields into the documented bits", () => {
  const entry = {
    transparency: 7,
    type: 5,
    speed: 3,
    intensity: 2,
    cycle: 1,
    noise: 3,
    hit: true,
    texture: MAP_TEXTURE_UNSET,
  };
  const b = encodeMapEntry(entry);
  assertEquals(Array.from(b), [0xf5, 0xa7, 0x01, 0x96]);
  assertEquals(decodeMapEntry(b), entry);
  // an unset entry as the cartridge leaves it, texture 150
  assertEquals(Array.from(encodeMapEntry()), [0xe3, 0xd4, 0x00, 0x96]);
  assertEquals(decodeMapEntry(encodeMapEntry()), mapEntryDefaults());
  assertThrows(() => encodeMapEntry({ type: 8 }), Error, "map entry.type");
  assertThrows(() => encodeMapEntry({ texture: 256 }), Error, "texture");
});

Deno.test("a layout effect takes its command by name or number and keeps the reserved bytes", () => {
  const b = encodeLayoutEffect({
    frame: 0x12345678,
    values: [1, -1, 3, 4],
    command: "layerBScrollRate",
    reserved: [7, 8, 9],
  });
  assertEquals(
    Array.from(b),
    [0x12, 0x34, 0x56, 0x78, 0x01, 0xff, 0x03, 0x04, 0x12, 0x07, 0x08, 0x09],
  );
  assertEquals(decodeLayoutEffect(b), {
    frame: 0x12345678,
    values: [1, 255, 3, 4],
    command: 0x12,
    reserved: [7, 8, 9],
  });
  assertStrictEquals(EFFECT_COMMANDS.length, 0x13);
  assertStrictEquals(EFFECT_COMMANDS[0x12], "layerBScrollRate");
  assertStrictEquals(EFFECT_COMMANDS[2], "fog");
  assertStrictEquals(encodeLayoutEffect({ command: "fog" })[8], 2);
  assertThrows(
    () => encodeLayoutEffect({ command: "thunder" }),
    Error,
    "thunder",
  );
  assertThrows(
    () => encodeLayoutEffect({ command: 0x13 }),
    Error,
    "effect.command",
  );
  assertThrows(
    () => encodeLayoutEffect({ values: [256] }),
    Error,
    "effect.values[0]",
  );
});

// --- the whole #BL -------------------------------------------------------------

Deno.test("a #BL with three layers of a few enemies decodes to the same layout", () => {
  const layout = {
    map: [{ enemy: 0, x: 16, y: 472, frame: -218 }, { enemy: 1, frame: -346 }],
    a: [{ enemy: 2, x: -40, frame: -500 }],
    b: [{ enemy: 0, frame: -600 }, { enemy: 1 }, { enemy: 2, y: 9 }],
  };
  const stage = {
    enemies: [fullEnemy(), { hp: 4 }, { score: 9, hit: { size: 2 } }],
    layout,
    mapSettings: { scale: 5, loopStart: 3, loopEnd: 15 },
    map: [{ texture: 4, hit: true, transparency: 0 }],
    effects: [
      { frame: 100, command: "fog", values: [255, 0, 0, 3] },
      { frame: 200, command: 9 },
    ],
  };
  const bytes = buildStageBl(stage);
  assertStrictEquals(bytes.length, DOCUMENTED_SIZES.BL);
  // the regions land where the document puts them
  assertEquals(bytesAt(bytes, BL_OFFSETS.enemies, 4), [7, 1, 0xa, 0xf]);
  assertEquals(
    bytesAt(bytes, BL_OFFSETS.layout, 12),
    [0, 0, 0, 16, 1, 0xd8, 0, 0, 0xff, 0xff, 0xff, 0x26],
  );
  assertEquals(bytesAt(bytes, BL_OFFSETS.mapSettings, 3), [5, 3, 15]);
  assertEquals(bytesAt(bytes, BL_OFFSETS.map, 8), [
    0x03,
    0xd4,
    0x01,
    0x04,
    0xe3,
    0xd4,
    0x00,
    0x96,
  ]);
  assertEquals(
    bytesAt(bytes, BL_OFFSETS.effects, 12),
    [0, 0, 0, 100, 0xff, 0, 0, 3, 2, 0, 0, 0],
  );
  assertEquals(
    bytesAt(bytes, BL_OFFSETS.tail, BL_TAIL_BYTES),
    [0, 2, 0, 0, 0, 3, 0, 5, 0, 0, 0, 0, 2, 0, 0, 0],
  );
  const back = parseStageBl(bytes);
  assertEquals(back.layout, decodeLayout(encodeLayout(layout)));
  assertEquals(back.enemies[0], fullEnemy());
  assertStrictEquals(back.enemies[1].hp, 4);
  assertStrictEquals(back.enemies[2].hit.size, 2);
  assertStrictEquals(back.enemies.length, 180);
  assertEquals(back.mapSettings, { scale: 5, loopStart: 3, loopEnd: 15 });
  assertStrictEquals(back.map.length, 256);
  assertStrictEquals(back.map[0].texture, 4);
  assertStrictEquals(back.map[1].texture, MAP_TEXTURE_UNSET);
  assertStrictEquals(back.effects.length, 2);
  assertStrictEquals(back.effects[0].command, 2);
  assertStrictEquals(back.effects[1].frame, 200);
  assertEquals(back.tail, {
    totalEffects: 2,
    firstMap: 0,
    firstA: 3,
    firstB: 5,
    unknown2F: 0,
    word33: 0x200,
    unknown35: 0,
  });
  // and the parse rebuilds the same bytes
  assertEquals(buildStageBl(back), bytes);
  // an empty stage too
  const empty = parseStageBl(buildStageBl());
  assertEquals(empty.layout, { map: [], a: [], b: [] });
  assertEquals(empty.effects, []);
  assertEquals(empty.tail.firstA, 1);
  assertEquals(empty.tail.firstB, 2);
  assertEquals(buildStageBl(empty), buildStageBl());
  assertThrows(() => parseStageBl(bytes.subarray(0, 100)), Error, "#BL");
  assertThrows(
    () => buildStageBl({ enemies: [{ hp: 99 }] }),
    Error,
    "enemies[0].hp",
  );
});

// --- CBL --------------------------------------------------------------------

Deno.test("CBL holds twenty enemies then the seven items in order", () => {
  const bytes = buildCbl({
    enemies: [{ hp: 5 }],
    items: { bomb: { hp: 9 }, bonus2: { score: 3 } },
  });
  assertStrictEquals(bytes[3], 5);
  assertStrictEquals(bytes[0x7e8 + 3], 9);
  assertStrictEquals(bytes[0x958 + 2], 3);
  const back = parseCbl(bytes);
  assertStrictEquals(back.enemies.length, 20);
  assertEquals(Object.keys(back.items), [...CBL_ITEMS]);
  assertStrictEquals(back.items.bomb.hp, 9);
  assertStrictEquals(back.items.bonus2.score, 3);
  assertEquals(back.items.shot, enemyEntryDefaults());
  assertEquals(buildCbl(back), bytes);
  // items as a list, in file order
  const asList = buildCbl({
    items: [{}, {}, { hp: 9 }, {}, {}, {}, { score: 3 }],
  });
  assertEquals(
    asList,
    buildCbl({ items: { bomb: { hp: 9 }, bonus2: { score: 3 } } }),
  );
  assertThrows(() => buildCbl({ items: { ammo: {} } }), Error, "items.ammo");
  assertThrows(
    () => buildCbl({ items: { laser: { hp: 16 } } }),
    Error,
    "items.laser.hp",
  );
  assertThrows(
    () => buildCbl({ enemies: Array.from({ length: 21 }, () => ({})) }),
    Error,
    "20",
  );
});

// --- the model -----------------------------------------------------------------

Deno.test("a model round-trips and its tables land at the documented offsets", () => {
  const face = {
    vertices: [0, 1, 2],
    pad: 0x33,
    uv: [[-1, 2], [300, -400], [5, 6]],
    light: [10, 20, 30],
    untextured: true,
    lightMask: true,
    tile: 9,
    unknownBits: 0,
  };
  const tile = {
    offset: 0x1ef,
    mirrorV: true,
    widthPower: 3,
    mirrorH: false,
    heightPower: 4,
  };
  const groups = Array.from({ length: 100 }, (_, i) => (i < 3 ? -1 : i % 5));
  const unknownC11 = Uint8Array.from({ length: 15 }, (_, i) => i + 1);
  const model = {
    vertices: [{ x: 94, y: 39, z: -271 }, { x: -1, y: 0, z: 1 }, {
      x: 32767,
      y: -32768,
      z: 7,
    }],
    faces: [face],
    unknownA2A: 0xbeef,
    tiles: [{}, {}, tile],
    hScale: Array.from({ length: 16 }, (_, i) => (i === 2 ? 0x46f : 0x400)),
    groups,
    light: 0x1d,
    unknownC11,
  };
  const b = encodeModel(model);
  assertStrictEquals(b.length, MODEL_BYTES);
  assertEquals(bytesAt(b, 0, 2), [3, 1]);
  assertEquals(bytesAt(b, MODEL_OFFSETS.vertices, 6), [
    0,
    94,
    0,
    39,
    0xfe,
    0xf1,
  ]);
  assertStrictEquals(MODEL_OFFSETS.faces, 0x25a);
  assertEquals(bytesAt(b, 0x25a, 0x14), [
    0x00,
    0x01,
    0x02,
    0x33,
    0xff,
    0xff,
    0x00,
    0x02,
    0x01,
    0x2c,
    0xfe,
    0x70,
    0x00,
    0x05,
    0x00,
    0x06,
    0x0a,
    0x14,
    0x1e,
    0xc9,
  ]);
  assertEquals(bytesAt(b, 0xa2a, 2), [0xbe, 0xef]);
  assertStrictEquals(MODEL_OFFSETS.tiles, 0xa2c);
  // tile 0 is the editor's blank: offset 0, no mirroring, powers 5 and 6
  assertEquals(bytesAt(b, 0xa2c, 0x14), [
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    5,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    6,
  ]);
  assertEquals(bytesAt(b, 0xa2c + 2 * 0x14, 0x14), [
    0,
    0,
    1,
    0xef,
    0,
    0,
    0,
    1,
    0,
    0,
    0,
    3,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    4,
  ]);
  assertStrictEquals(MODEL_OFFSETS.hScale, 0xb6c);
  assertEquals(bytesAt(b, 0xb6c, 6), [4, 0, 4, 0, 4, 0x6f]);
  assertStrictEquals(MODEL_OFFSETS.vScale, 0xb8c);
  assertEquals(bytesAt(b, 0xb8c, 4), [4, 0, 4, 0]);
  assertStrictEquals(MODEL_OFFSETS.groups, 0xbac);
  assertEquals(bytesAt(b, 0xbac, 5), [0xff, 0xff, 0xff, 3, 4]);
  assertStrictEquals(MODEL_OFFSETS.light, 0xc10);
  assertStrictEquals(b[0xc10], 0x1d);
  assertEquals(bytesAt(b, 0xc11, 15), Array.from(unknownC11));
  const back = decodeModel(b);
  assertStrictEquals(back.vertexCount, 3);
  assertStrictEquals(back.faceCount, 1);
  assertEquals(back.vertices, model.vertices);
  assertEquals(back.faces, [face]);
  assertEquals(back.tiles[2], tile);
  assertEquals(back.tiles[0], {
    offset: 0,
    mirrorV: false,
    widthPower: 5,
    mirrorH: false,
    heightPower: 6,
  });
  assertStrictEquals(back.hScale[2], 0x46f);
  assertEquals(back.groups, groups);
  assertStrictEquals(back.light, 0x1d);
  assertEquals(back.unknownC11, unknownC11);
  assertEquals(encodeModel(back), b);
  // the groups default: -1 for each vertex the model has, 0 past them
  const g = decodeModel(encodeModel({ vertices: [{}, {}] })).groups;
  assertEquals(g.slice(0, 3), [-1, -1, 0]);
});

Deno.test("a model's counts and lists may disagree, as the cartridge's own sample does", () => {
  const b = encodeModel({
    vertexCount: 0,
    vertices: [{ x: 57, y: 57, z: 57 }],
  });
  assertStrictEquals(b[0], 0);
  assertEquals(bytesAt(b, 2, 6), [0, 57, 0, 57, 0, 57]);
  const back = decodeModel(b);
  assertStrictEquals(back.vertexCount, 0);
  assertStrictEquals(back.vertices.length, 1);
  assertEquals(encodeModel(back), b);
  // and the counts win when the slots past the lists are zero
  const c = decodeModel(encodeModel({ vertexCount: 5, faceCount: 2 }));
  assertStrictEquals(c.vertices.length, 5);
  assertStrictEquals(c.faces.length, 2);
  const cases = [
    [{ faces: [{ vertices: [100, 0, 0] }] }, "model.faces[0].vertices[0]"],
    [{ vertices: Array.from({ length: 101 }, () => ({})) }, "100"],
    [{ light: 0x1e }, "model.light"],
    [{ tiles: [{ offset: 0x1f0 }] }, "model.tiles[0].offset"],
    [{ tiles: Array.from({ length: 17 }, () => ({})) }, "model.tiles holds 16"],
    [{ faces: [{ uv: [[0, 0], [0, 0], [0, 32768]] }] }, "uv[2][1]"],
    [{ vertices: [{ w: 1 }] }, "model.vertices[0].w is not a field"],
  ];
  for (const [model, message] of cases) {
    assertThrows(() => encodeModel(model), Error, message);
  }
});

Deno.test("the model files put their texture indices after the models and leave empty slots zero", () => {
  const md = buildMdFile([null, billboardModel()], [0, 0x303c]);
  assert(md.subarray(0, MODEL_BYTES).every((x) => x === 0));
  assert(md.subarray(MODEL_BYTES, 2 * MODEL_BYTES).some((x) => x !== 0));
  assertEquals(bytesAt(md, MD_TEXTURE_INDEX_OFFSET, 4), [0, 0, 0x30, 0x3c]);
  const back = parseMdFile(md);
  assertStrictEquals(back.models.length, 130);
  assertStrictEquals(back.models[0], null);
  assertStrictEquals(back.models[1].vertices.length, 4);
  assertStrictEquals(back.textureIndices[1], 0x303c);
  assertEquals(buildMdFile(back.models, back.textureIndices), md);
  const cmd = buildCmdFile([billboardModel({ tile: 1 })], [17, 16]);
  assertEquals(bytesAt(cmd, CMD_TEXTURE_INDEX_OFFSET, 4), [0, 17, 0, 16]);
  const cmdBack = parseCmdFile(cmd);
  assertStrictEquals(cmdBack.models.length, 20);
  assertStrictEquals(cmdBack.models[0].faces[0].tile, 1);
  assertEquals(buildCmdFile(cmdBack.models, cmdBack.textureIndices), cmd);
  const tex = Uint8Array.from({ length: TILE_BYTES }, (_, i) => i & 0xff);
  const ulb = buildUlbFile([null, billboardModel()], [null, tex]);
  assertEquals(
    ulb.subarray(
      ULB_TEXTURES_OFFSET + TILE_BYTES,
      ULB_TEXTURES_OFFSET + 2 * TILE_BYTES,
    ),
    tex,
  );
  const ulbBack = parseUlbFile(ulb);
  assertStrictEquals(ulbBack.models[0], null);
  assertStrictEquals(ulbBack.models[1].faces.length, 2);
  assertEquals(ulbBack.textures[1], tex);
  assert(ulbBack.textures[0].every((x) => x === 0));
  assertEquals(buildUlbFile(ulbBack.models, ulbBack.textures), ulb);
  assertThrows(
    () => buildCmdFile(Array.from({ length: 21 }, () => null)),
    Error,
    "CMD holds 20 models",
  );
  assertThrows(() => buildMdFile([], [70000]), Error, "textureIndices[0]");
  assertThrows(
    () => buildUlbFile([], [new Uint8Array(10)]),
    Error,
    "ULB textures[0]",
  );
});

Deno.test("a billboard is four vertices on the ground plane and two faces over one tile", () => {
  const m = billboardModel({
    width: 64,
    height: 32,
    tileWidthPower: 5,
    tileHeightPower: 6,
    tile: 1,
    light: 4,
  });
  // near-left, near-right, far-right, far-left: flat in XZ, wound to face up
  assertEquals(m.vertices, [
    { x: -32, y: 0, z: 16 },
    { x: 32, y: 0, z: 16 },
    { x: 32, y: 0, z: -16 },
    { x: -32, y: 0, z: -16 },
  ]);
  // a tile is 1 << (width power + 1) across and 1 << (height power - 1) down
  assertStrictEquals(tilePixels(5), 64);
  assertStrictEquals(tilePixels(4), 32);
  assertStrictEquals(tileHeightPixels(6), 32);
  assertStrictEquals(tileHeightPixels(4), 8);
  assertEquals(m.faces[0].vertices, [0, 1, 2]);
  // the texture's top row at the far edge, its left column at -x: upright
  assertEquals(m.faces[0].uv, [[0, 32], [64, 32], [64, 0]]);
  assertEquals(m.faces[1].vertices, [0, 2, 3]);
  assertEquals(m.faces[1].uv, [[0, 32], [64, 0], [0, 0]]);
  assertStrictEquals(m.faces[0].tile, 1);
  assertStrictEquals(m.faces[0].untextured, false);
  assertEquals(m.tiles[1], {
    offset: 0,
    mirrorV: false,
    widthPower: 5,
    mirrorH: false,
    heightPower: 6,
  });
  assertStrictEquals(m.light, 4);
  const b = encodeModel(m);
  assertEquals(bytesAt(b, 0, 2), [4, 2]);
  assertStrictEquals(b[MODEL_OFFSETS.faces + 0x13], 0x01);
  assertStrictEquals(b[MODEL_OFFSETS.light], 4);
  const back = decodeModel(b);
  assertEquals(back.vertices, m.vertices);
  assertEquals(back.faces[1].uv, m.faces[1].uv);
  // the default: tile 0, the whole 64 x 32 texture (the editor's blank tile)
  const d = billboardModel();
  assertStrictEquals(d.faces[0].tile, 0);
  assertEquals(d.tiles[0], {
    offset: 0,
    mirrorV: false,
    widthPower: 5,
    mirrorH: false,
    heightPower: 6,
  });
  assertEquals(d.faces[0].uv, [[0, 32], [64, 32], [64, 0]]);
});

// --- GAM ---------------------------------------------------------------------

Deno.test("GAM round-trips its fields and lands them where the document says", () => {
  const spriteX = Array.from({ length: 46 }, (_, i) => i);
  spriteX[45] = 0xabcd;
  const g = encodeGam({
    finalStage: 4,
    fontColor: 7,
    loadout: { shotPower: 2, laserPower: 1, bombs: 3 },
    initialAltitude: 8,
    player: { scale: 0x1234, transparency: { enabled: true, speed: -1 } },
    spriteX,
    vibration: {
      death: 1,
      bomb: 2,
      blast1: [3, 4, 5, 6],
      blast2: [7, 8, 9, 10],
    },
    title1: {
      wave: 3,
      blink: true,
      transparency: 3,
      inTop: true,
      inBottom: true,
      inLeft: true,
      inRight: true,
      width: 2,
      height: 2,
      roll: 2,
      y: 0x3a0,
    },
    ending: { type: 1, startTexture: 200, endTexture: 201 },
    lightPositions: [0x19],
    lightColors: [{ directional: [1, 2, 3], ambient: [4, 5, 6] }],
    titleBackgroundTexture: -1,
    bgm: { title: -1, ending: 99, gameOver: 0, stageClear: 1 },
  });
  assertStrictEquals(g[0], 4);
  assertStrictEquals(g[3], 7);
  assertStrictEquals(g[0xb2], 0x93);
  assertStrictEquals(g[0xb3], 8);
  assertEquals(bytesAt(g, 0x154, 2), [0x12, 0x34]);
  assertStrictEquals(g[0x162], 1);
  assertStrictEquals(g[0x168], 0xff);
  assertStrictEquals(GAM_SPRITES.length, 46);
  assertStrictEquals(GAM_SPRITES[45], "playerBoost");
  assertEquals(bytesAt(g, 0x16c, 4), [0, 0, 0, 1]);
  assertEquals(bytesAt(g, 0x1c6, 2), [0xab, 0xcd]);
  // the ypos table ends at 0x224 (boost y 0x1D0 by default), so the ten
  // vibration bytes start there, not at the document's 0x223
  assertEquals(bytesAt(g, 0x222, 12), [1, 0xd0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assertEquals(bytesAt(g, 0x22e, 2), [0x7f, 0xea]);
  assertEquals(bytesAt(g, 0x232, 2), [0x03, 0xa0]);
  assertEquals(bytesAt(g, 0x236, 3), [1, 200, 201]);
  assertStrictEquals(g[0x239], 0x19);
  assertEquals(bytesAt(g, 0x257, 6), [1, 2, 3, 4, 5, 6]);
  assertEquals(bytesAt(g, 0x511, 2), [0xff, 0xff]);
  assertEquals(bytesAt(g, 0x553, 4), [0xff, 99, 0, 1]);
  assertStrictEquals(GAM_OFFSETS.vibration, 0x224);
  assertStrictEquals(GAM_OFFSETS.palette, 0x311);
  const back = decodeGam(g);
  assertEquals(back.missing, []);
  assertStrictEquals(back.finalStage, 4);
  assertEquals(back.loadout, {
    shotPower: 2,
    laserPower: 1,
    bombs: 3,
    unknownBits: 0,
  });
  assertStrictEquals(back.player.scale, 0x1234);
  assertStrictEquals(back.player.transparency.enabled, true);
  assertEquals(back.spriteX, spriteX);
  assertEquals(back.vibration, {
    death: 1,
    bomb: 2,
    blast1: [3, 4, 5, 6],
    blast2: [7, 8, 9, 10],
  });
  assertStrictEquals(back.title1.inRight, true);
  assertStrictEquals(back.title1.y, 0x3a0);
  assertStrictEquals(back.titleBackgroundTexture, -1);
  assertEquals(back.bgm, { title: -1, ending: 99, gameOver: 0, stageClear: 1 });
  assertEquals(encodeGam(back), g);
  // the defaults are the cartridge's initial game: high scores of ten
  // "........" entries 10,000 down, the two title words, BGM 37/28/40/11
  const d = encodeGam();
  assertEquals(d.subarray(0x6, 0xa6), defaultHighScores());
  assertEquals(bytesAt(d, 0x6, 16), [
    0x2e,
    0x2e,
    0x2e,
    0x2e,
    0x2e,
    0x2e,
    0x2e,
    0x2e,
    0,
    0,
    0,
    0,
    0,
    0,
    0x27,
    0x10,
  ]);
  assertEquals(bytesAt(d, 0x22e, 4), [0x21, 0x15, 0x3a, 0x16]);
  assertEquals(bytesAt(d, 0x553, 4), [37, 28, 40, 11]);
  assertEquals(bytesAt(d, 0x30b, 6), [0, 0, 0xb0, 3, 3, 6]);
  const cases = [
    [{ fontFace: 6 }, "gam.fontFace"],
    [{ initialAltitude: 11 }, "gam.initialAltitude"],
    [{ spriteX: Array.from({ length: 47 }, () => 0) }, "gam.spriteX holds 46"],
    [{ lightPositions: [0x1a] }, "gam.lightPositions[0]"],
    [{ title2: { width: 3 } }, "gam.title2.width"],
    [{ player: { frameSpeed: 8 } }, "gam.player.frameSpeed"],
    [{ palette: new Uint8Array(3) }, "gam.palette is 512 raw bytes"],
    [{ fontface: 1 }, "gam.fontface is not a field"],
  ];
  for (const [gam, message] of cases) {
    assertThrows(() => encodeGam(gam), Error, message);
  }
});

Deno.test("a short GAM decodes with the missing fields named rather than throwing", () => {
  const short = decodeGam(encodeGam().subarray(0, 1360));
  assertEquals(short.missing, [
    "commonTextureIndices",
    "bgm.title",
    "bgm.ending",
    "bgm.gameOver",
    "bgm.stageClear",
    "unknown557",
    "unknown558",
  ]);
  assertStrictEquals(short.commonTextureIndices, null);
  assertStrictEquals(short.bgm.title, null);
  assertStrictEquals(short.titleBackgroundTexture, 20);
  // re-encoding fills what was missing with the defaults
  assertEquals(encodeGam(short), encodeGam());
  const tiny = decodeGam(new Uint8Array(4));
  assertStrictEquals(tiny.finalStage, 0);
  assertStrictEquals(tiny.palette, null);
  assert(tiny.missing.includes("timeAttackStage"));
  assert(tiny.missing.includes("palette"));
  assert(tiny.missing.length > 30);
});

Deno.test("a prototype GAM gets its nine bytes back at 0xA8 and then reads as the cartridge's", () => {
  // a cartridge GAM with marked fields either side of the gap; the nine
  // bytes the prototype lacks are zero in it, as in the cartridge's own
  const cart = encodeGam({
    fontColor: 2,
    item2Score: 5,
    loadout: { shotPower: 0, laserPower: 0, bombs: 3, unknownBits: 0 },
    initialAltitude: 7,
    player: { scale: 61, frameSpeed: -1, models: [149, 0, 0, 0] },
    bgm: { title: 0, ending: 28, gameOver: 40, stageClear: -1 },
  });
  assertEquals(PROTOTYPE_GAM_BYTES, 1360);
  const proto = new Uint8Array(PROTOTYPE_GAM_BYTES);
  proto.set(cart.subarray(0, PROTOTYPE_GAM_GAP));
  proto.set(cart.subarray(PROTOTYPE_GAM_GAP + 9), PROTOTYPE_GAM_GAP);
  const fixed = repairPrototypeGam(proto);
  assertEquals(fixed, cart);
  const g = decodeGam(fixed);
  assertEquals(
    [
      g.fontColor,
      g.item2Score,
      g.loadout.bombs,
      g.initialAltitude,
      g.player.scale,
      g.player.models[0],
      g.bgm.stageClear,
    ],
    [2, 5, 3, 7, 61, 149, -1],
  );
  // read as it is, the prototype is out from 0xA8 on
  const misread = decodeGam(proto);
  assertEquals(misread.fontColor, 2);
  assert(misread.player.scale !== 61 && misread.player.models[0] !== 149);
  // a cartridge GAM is itself; any other length is neither layout
  assertStrictEquals(repairPrototypeGam(cart), cart);
  assertStrictEquals(repairPrototypeGam(new Uint8Array(100)), null);
});

// --- MUS ---------------------------------------------------------------------

Deno.test("a song header round-trips with the mute bit in bit 7 of a track's volume", () => {
  const header = {
    tempo: 0x1f,
    echo: 7,
    loopStart: 2,
    length: 0x1f,
    tracks: [
      { volume: 0x5a, muted: true },
      { volume: 0x7f, muted: false },
      { volume: 0, muted: false },
      { volume: 1, muted: true },
    ],
    instrumentVolumes: [1, 2, 3, 4, 5, 6, 7],
    trackPans: [0, 0x40, 0x7f, 0x20],
    instrumentPans: [10, 20, 30, 40, 50, 60, 70],
  };
  const b = encodeSongHeader(header);
  assertStrictEquals(b.length, SONG_HEADER_BYTES);
  assertEquals(bytesAt(b, 0, 8), [0x1f, 7, 2, 0x1f, 0xda, 0x7f, 0x00, 0x81]);
  assertEquals(bytesAt(b, 0xf, 4), [0, 0x40, 0x7f, 0x20]);
  assertEquals(decodeSongHeader(b), header);
  assertStrictEquals(MUS_TEMPO_TABLE.length, 32);
  assertStrictEquals(MUS_TEMPO_TABLE[0x10], 0x21);
  assertStrictEquals(MUS_ECHO_TABLE[7], 0x40);
  assertThrows(() => encodeSongHeader({ tempo: 0x21 }), Error, "song.tempo");
  assertThrows(() => encodeSongHeader({ echo: 8 }), Error, "song.echo");
  assertThrows(
    () => encodeSongHeader({ tracks: [{ volume: 0x80 }] }),
    Error,
    "song.tracks[0].volume",
  );
});

Deno.test("a blank song is the cartridge's: tempo 0x10, echo 2, centred pans, FF 00 01 00 block heads, silence", () => {
  const s = blankSong();
  assertEquals(bytesAt(s, 0, 4), [0x10, 0x02, 0x00, 0x1f]);
  assert(s.subarray(4, 0xf).every((x) => x === 0x5a));
  assert(s.subarray(0xf, 0x1a).every((x) => x === 0x40));
  assertEquals(bytesAt(s, 0x1a, 4), [0xff, 0x00, 0x01, 0x00]);
  assertStrictEquals(PITCH_SILENCE, 0);
  assert(s.subarray(0x1e, 0x1a + 0x84).every((x) => x === PITCH_SILENCE));
  assertEquals(bytesAt(s, 0x1a + 0x84, 4), [0xff, 0x00, 0x01, 0x00]);
  // accompaniment: silence, then the three drum lines on the yellow drumkit
  assert(s.subarray(0x109a, 0x109a + 0x70 + 0x40).every((x) => x === 0));
  assert(s.subarray(0x109a + 0xb0, 0x109a + 0xe0).every((x) => x === 0x32));
  assertStrictEquals(s.filter((x) => x !== 0).length, 1625);
  assertEquals(decodeSong(s).score, blankScore());
  assertEquals(decodeSong(s).accompaniment, blankAccompaniment());
  assertEquals(encodeSong(decodeSong(s)), s);
});

Deno.test("a MUS is 24 songs; a song given is encoded, the rest are blank", () => {
  const score = blankScore();
  score[4] = 0x3c; // middle C: track 1's first pitch of block 1, song offset 0x1E
  const mus = buildMusFile([{ tempo: 3 }, null, { score }]);
  assertStrictEquals(mus[0], 3);
  assertStrictEquals(mus[SONG_BYTES], 0x10);
  assertStrictEquals(mus[2 * SONG_BYTES + 0x1e], 0x3c);
  const songs = parseMusFile(mus);
  assertStrictEquals(songs.length, SONG_COUNT);
  assertStrictEquals(songs[0].tempo, 3);
  assertEquals(songs[1].score, blankScore());
  assertEquals(songs[2].score, score);
  assertEquals(songs[23].accompaniment, blankAccompaniment());
  assertEquals(buildMusFile(songs), mus);
  assertThrows(
    () => buildMusFile(Array.from({ length: 25 }, () => ({}))),
    Error,
    "24",
  );
  assertThrows(
    () => buildMusFile([{ score: new Uint8Array(4) }]),
    Error,
    "songs[0].score is 4224 raw bytes",
  );
});

// --- the surface ----------------------------------------------------------------

Deno.test("index.js re-exports the record codecs", () => {
  assertStrictEquals(n64.buildStageBl, buildStageBl);
  assertStrictEquals(n64.encodeGam, encodeGam);
  assertStrictEquals(n64.ENEMY_ENTRY_BYTES, 0x5c);
  assertStrictEquals(typeof n64.billboardModel, "function");
});

// --- the cartridge's own initial save ---------------------------------------------------

const BANKS = ["GAM", "CBL", "BL1", "BL2", "BL3", "CMD", "MUS"];

Deno.test({
  name:
    "the cartridge's initial save re-encodes byte for byte through every codec",
  ignore: !hasFixtures(...BANKS.map((b) => `n64-sram/${b}.bin`)),
  fn() {
    const bank = (b) => loadFixture(`n64-sram/${b}.bin`);
    // GAM: the defaults ARE the initial game
    const gam = bank("GAM");
    assertEquals(encodeGam(), gam);
    assertEquals(encodeGam(decodeGam(gam)), gam);
    // CBL
    const cbl = bank("CBL");
    assertEquals(buildCbl(parseCbl(cbl)), cbl);
    // the stage BLs are the cartridge variant: 0x104 bytes of model indices
    // first, then the disk layout up to the three indices of the tail
    for (const name of ["BL1", "BL2", "BL3"]) {
      const cart = bank(name);
      const disk = new Uint8Array(DOCUMENTED_SIZES.BL);
      disk.set(cart.subarray(0x104, 0x104 + BL_OFFSETS.tail + 8), 0);
      const stage = parseStageBl(disk);
      const idx = layoutIndices(stage.layout);
      assertStrictEquals(stage.tail.firstA, idx.a, name);
      assertStrictEquals(stage.tail.firstB, idx.b, name);
      assertStrictEquals(stage.effects.length, stage.tail.totalEffects, name);
      assertEquals(buildStageBl(stage), disk, name);
    }
    // CMD is the cartridge variant too: ten model slots
    const cmd = bank("CMD");
    for (let i = 0; i < 10; i++) {
      const slot = cmd.subarray(i * MODEL_BYTES, (i + 1) * MODEL_BYTES);
      assertEquals(encodeModel(decodeModel(slot)), slot, `model ${i}`);
    }
    // MUS holds eight songs in ROM mode, all blank
    const mus = bank("MUS");
    assertEquals(blankSong(), mus.subarray(0, SONG_BYTES));
    for (let i = 0; i < 8; i++) {
      const song = mus.subarray(i * SONG_BYTES, (i + 1) * SONG_BYTES);
      assertEquals(encodeSong(decodeSong(song)), song, `song ${i}`);
    }
  },
});
