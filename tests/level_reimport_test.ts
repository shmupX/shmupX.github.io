// scripts/reimport-cloud-level.ts: a cloud level decoded again from its cart
// and published over the record. The network half (the shelf, the PUT) is
// the harbor's and rtdb-publish's; what is pinned here is the record it
// builds — the cart decides what a cart knows, the record keeps what only the
// editor knows, the leaderboard id above all — and the dry run's account of
// the scenery, which is how a record written in the old flip convention is
// told apart from one that merely changed.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { encodeBase64 } from "@std/encoding/base64";
import {
  buildPayload,
  compareRecords,
  creditsFromIndex,
  describeShip,
  DOT_LEADER,
  EDITOR_KEYS,
  type Json,
  rtdbFrameKeys,
  SERVER_TIMESTAMP,
  tileDiff,
} from "../scripts/reimport-cloud-level.ts";
import { badRtdbKey } from "../scripts/lib/rtdb-publish.ts";

/** A scenery grid out of u16be words, as a record stores one. */
function scenery(cols: number, rows: number, words: number[]): Json {
  const bytes = new Uint8Array(words.length * 2);
  words.forEach((w, i) => {
    bytes[i * 2] = w >> 8;
    bytes[i * 2 + 1] = w & 0xff;
  });
  return { cols, rows, tiles: encodeBase64(bytes) };
}

const H = 0x8000, V = 0x4000, EMPTY = 0xffff;

/** The record as August's importer left it: the stock ship, flips swapped. */
function augustRecord(): Json {
  return {
    name: "Ramsie",
    gameId: "ramsie-cae9647a",
    godMode: true,
    savedAt: 1787621269033,
    stageKey: "stage0",
    enemylist: [["00", "Q0"]],
    width: 2,
    playerData: { name: "duke", texture: ["duke_0", "duke_1"] },
    enemyData: { enemyA: { texture: ["deza0_00_0.gif"] } },
    bossData: { boss0: { name: "dezaBoss0" } },
    backgroundCells: ["dezaBgCell1.gif", "dezaBgCell2.gif"],
    background: scenery(2, 2, [1, V | 1, 2, EMPTY]),
    stages: {
      stage0: {
        enemylist: [["00", "Q0"]],
        background: scenery(2, 2, [1, V | 1, 2, EMPTY]),
      },
    },
    dezaemonBgm: { songs: {} },
    dezaemonCredits: { title: "DEZA2 SGM" },
    frameThumbnails: { "deza0_00_0․gif": "data:image/png;base64,AAAA" },
    atlasImageDataURL: "data:image/png;base64,AAAA",
    atlasFrames: { "deza0_00_0․gif": { frame: { x: 0, y: 0, w: 16, h: 16 } } },
  };
}

/** What levelRecordFromCart makes of the same cart today. */
function cartRecord(): Json {
  return {
    name: "Ramsie",
    stageKey: "stage0",
    enemylist: [["00", "Q0"]],
    width: 2,
    playerData: { name: "dezaShip", texture: ["dezaShip0.gif"] },
    playerData2: { name: "dezaShip2", texture: ["dezaShip20.gif"] },
    enemyData: { enemyA: { texture: ["deza0_00_0.gif"] } },
    bossData: { boss0: { name: "dezaBoss0" } },
    backgroundCells: ["dezaBgCell1.gif", "dezaBgCell2.gif"],
    background: scenery(2, 2, [1, H | 1, 2, EMPTY]),
    scroll: { curve: "AA==", loopPart: 1, endPart: 2 },
    stages: {
      stage0: {
        enemylist: [["00", "Q0"]],
        background: scenery(2, 2, [1, H | 1, 2, EMPTY]),
        scroll: { curve: "AA==", loopPart: 1, endPart: 2 },
      },
      stage1: {
        enemylist: [["00", "AQ0"]],
        background: scenery(2, 1, [2, 2]),
      },
    },
    dezaemonBgm: { songs: {} },
    dezaemonBullets: { configs: [] },
    dezaemonItems: { slots: [] },
    dezaemonTitle: { title1: "dezaTitle1.gif" },
    meta: { version: "1.0", source: "dezaemon2", dezaemonSettings: {} },
    noStory: true,
    continueComment: " ",
    atlasImageDataURL: "data:image/png;base64,BBBB",
    // The importer names a frame by its file, dot and all.
    atlasFrames: {
      "deza0_00_0.gif": { frame: { x: 0, y: 0, w: 16, h: 16 } },
      "dezaShip0.gif": { frame: { x: 16, y: 0, w: 16, h: 16 } },
    },
  };
}

const INDEX_ROW: Json = {
  file: "Dez 2 - Ramsie.sav",
  fileTitle: "Ramsie",
  titleEn: "Ramsie",
  titleJa: "RAMSIE",
  developerEn: "Athena",
  developerJa: "株式会社アテナ",
  genre: "Vertical Shoot-em-up",
  genreJa: "縦スクロールシューティング",
};

const derive = (level: Json) => `${String(level.name).toLowerCase()}-deadbeef`;

Deno.test("the cart decides everything a cart knows", () => {
  const { payload, report } = buildPayload({
    existing: augustRecord(),
    cart: cartRecord(),
    key: "Ramsie",
    index: INDEX_ROW,
    deriveGameId: derive,
  });
  assertEquals(describeShip(payload), "dezaShip (dezaShip0.gif)");
  assertEquals((payload.meta as Json).source, "dezaemon2");
  assertEquals(payload.playerData2, cartRecord().playerData2);
  assertEquals(payload.dezaemonBullets, { configs: [] });
  assertEquals(Object.keys(payload.stages as Json), ["stage0", "stage1"]);
  assertEquals(payload.background, cartRecord().background);
  assertEquals(payload.scroll, cartRecord().scroll);
  assertEquals(payload.atlasImageDataURL, "data:image/png;base64,BBBB");
  assertEquals(payload.noStory, true);
  assert(report.fromCart.includes("playerData"));
  assert(report.fromCart.includes("meta"));
  assert(report.fromCart.includes("stages"));
});

Deno.test("what only the editor knows is kept, the leaderboard id first", () => {
  const existing = augustRecord();
  existing.cabinet = { frame: "arcade" };
  existing.attribution = false;
  existing.customAudioURLs = { bgm0: "https://example.test/bgm0.mp3" };
  existing.ownItems = true;
  const { payload, report } = buildPayload({
    existing,
    cart: cartRecord(),
    key: "Ramsie",
    index: INDEX_ROW,
    deriveGameId: derive,
  });
  assertEquals(payload.gameId, "ramsie-cae9647a");
  assertEquals(payload.godMode, true);
  assertEquals(payload.cabinet, { frame: "arcade" });
  // `false` is an answer — credit nobody — and travels as one.
  assertEquals(payload.attribution, false);
  assertEquals(payload.customAudioURLs, existing.customAudioURLs);
  assertEquals(payload.ownItems, true);
  assertEquals(report.kept, [
    "attribution",
    "cabinet",
    "customAudioURLs",
    "gameId",
    "godMode",
    "ownItems",
  ]);
  for (const k of report.kept) {
    assert((EDITOR_KEYS as readonly string[]).includes(k));
  }
});

Deno.test("the name is the record's own, the save time the server's", () => {
  const existing = augustRecord();
  existing.name = "2019";
  const { payload } = buildPayload({
    existing,
    cart: cartRecord(),
    key: "2019-PS2",
    deriveGameId: derive,
  });
  assertEquals(payload.name, "2019");
  assertEquals(payload.savedAt, SERVER_TIMESTAMP);
  // A record with no name of its own is called what the cart is, else the key.
  const nameless = buildPayload({
    existing: { enemylist: [] },
    cart: cartRecord(),
    key: "ramsie-copy",
    deriveGameId: derive,
  });
  assertEquals(nameless.payload.name, "Ramsie");
  const bare = buildPayload({
    existing: {},
    cart: { ...cartRecord(), name: "" },
    key: "ramsie-copy",
    deriveGameId: derive,
  });
  assertEquals(bare.payload.name, "ramsie-copy");
});

Deno.test("the cart's frame names are keyed the editor's way: a dot becomes ONE DOT LEADER, which RTDB takes", () => {
  const { payload } = buildPayload({
    existing: augustRecord(),
    cart: cartRecord(),
    key: "Ramsie",
    deriveGameId: derive,
  });
  const frames = payload.atlasFrames as Record<string, unknown>;
  assertEquals(Object.keys(frames), [`deza0_00_0${DOT_LEADER}gif`, `dezaShip0${DOT_LEADER}gif`]);
  assertEquals(frames[`dezaShip0${DOT_LEADER}gif`], { frame: { x: 16, y: 0, w: 16, h: 16 } });
  // The whole record passes the uploader's own check — the server timestamp's
  // ".sv" is the database's key, not ours — where the cart as decoded would
  // not, and the check names the key, not a byte offset.
  assertEquals(badRtdbKey(payload), null);
  assertEquals(badRtdbKey(cartRecord()), "/atlasFrames/deza0_00_0.gif");
  assertEquals(badRtdbKey({ a: [{ "b/c": 1 }] }), "/a/0/b/c");
  assertEquals(badRtdbKey({ "": 1 }), "/");
  assertEquals(badRtdbKey({ "x#y": 1 }), "/x#y");
  assertEquals(badRtdbKey({ savedAt: SERVER_TIMESTAMP, ok: "a.b" }), null);
  // Only a map is re-keyed; anything else passes through.
  assertEquals(rtdbFrameKeys(["a.gif"]), ["a.gif"]);
  assertEquals(rtdbFrameKeys(null), null);
});

Deno.test("thumbnails are dropped, and nothing stale survives the PUT", () => {
  const existing = augustRecord();
  existing.stageBackgroundsOld = { stage0: "x" };
  const { payload, report } = buildPayload({
    existing,
    cart: cartRecord(),
    key: "Ramsie",
    deriveGameId: derive,
  });
  assertEquals(report.dropped, ["frameThumbnails", "stageBackgroundsOld"]);
  assert(!("frameThumbnails" in payload));
  assert(!("stageBackgroundsOld" in payload));
  // Nothing null goes up: a PUT with a null child is a deleted child anyway,
  // and an update() reader expects the key simply absent.
  for (const v of Object.values(payload)) assert(v !== null && v !== undefined);
});

Deno.test("a record that never had an id gets the one its name derives", () => {
  const existing = augustRecord();
  delete existing.gameId;
  const { payload, report } = buildPayload({
    existing,
    cart: cartRecord(),
    key: "Ramsie",
    deriveGameId: derive,
  });
  assertEquals(payload.gameId, "ramsie-deadbeef");
  assert(report.fromCart.includes("gameId"));
  assert(!report.kept.includes("gameId"));
});

Deno.test("the credits come from the library's row, then the cart, then the record", () => {
  assertEquals(creditsFromIndex(INDEX_ROW), {
    title: "Ramsie",
    titleJa: "RAMSIE",
    developer: "Athena",
    developerJa: "株式会社アテナ",
    genre: "Vertical Shoot-em-up",
    genreJa: "縦スクロールシューティング",
    url: null,
  });
  // The Japanese genre is filled in from the table when the row lacks it.
  assertEquals(
    creditsFromIndex({ ...INDEX_ROW, genreJa: undefined })?.genreJa,
    "縦スクロールシューティング",
  );
  // A row the community table knows nothing about carries no credits.
  assertEquals(creditsFromIndex({ file: "x.sav", fileTitle: "x" }), null);
  assertEquals(creditsFromIndex(null), null);

  const withRow = buildPayload({
    existing: augustRecord(),
    cart: cartRecord(),
    key: "Ramsie",
    index: INDEX_ROW,
    deriveGameId: derive,
  }).payload;
  assertEquals((withRow.dezaemonCredits as Json).developer, "Athena");
  const cartCredits = buildPayload({
    existing: augustRecord(),
    cart: { ...cartRecord(), dezaemonCredits: { title: "From the cart" } },
    key: "Ramsie",
    deriveGameId: derive,
  }).payload;
  assertEquals(cartCredits.dezaemonCredits, { title: "From the cart" });
  const recordCredits = buildPayload({
    existing: augustRecord(),
    cart: cartRecord(),
    key: "Ramsie",
    deriveGameId: derive,
  }).payload;
  assertEquals(recordCredits.dezaemonCredits, { title: "DEZA2 SGM" });
  const none = buildPayload({
    existing: { name: "Nameless" },
    cart: cartRecord(),
    key: "Nameless",
    deriveGameId: derive,
  }).payload;
  assertEquals(none.dezaemonCredits, { title: "Nameless" });
});

Deno.test("an author's story keeps the author's no-story setting", () => {
  const existing = augustRecord();
  existing.storyData = { stage0: [{ text: "..." }] };
  existing.noStory = false;
  const { payload, report } = buildPayload({
    existing,
    cart: cartRecord(),
    key: "Ramsie",
    deriveGameId: derive,
  });
  assertEquals(payload.storyData, existing.storyData);
  assertEquals(payload.noStory, false);
  assert(report.kept.includes("noStory"));
  // Without a story the cart's word stands: a cart has none.
  const plain = buildPayload({
    existing: { ...augustRecord(), noStory: false },
    cart: cartRecord(),
    key: "Ramsie",
    deriveGameId: derive,
  }).payload;
  assertEquals(plain.noStory, true);
});

Deno.test("tileDiff tells a re-flipped grid from a changed one", () => {
  const before = scenery(2, 2, [1, V | 1, H | 2, EMPTY]);
  const same = scenery(2, 2, [1, V | 1, H | 2, EMPTY]);
  const reflipped = scenery(2, 2, [1, H | 1, V | 2, EMPTY]);
  const redrawn = scenery(2, 2, [2, V | 1, H | 2, 3]);
  assertEquals(tileDiff(before, same), {
    cells: 4,
    differ: 0,
    flipSwapped: 0,
  });
  assertEquals(tileDiff(before, reflipped), {
    cells: 4,
    differ: 2,
    flipSwapped: 2,
  });
  assertEquals(tileDiff(before, redrawn), {
    cells: 4,
    differ: 2,
    flipSwapped: 0,
  });
  // A tile flipped both ways is the same word either way round.
  assertEquals(
    tileDiff(scenery(1, 1, [H | V | 5]), scenery(1, 1, [H | V | 5]))?.differ,
    0,
  );
  // Not the same shape: no cell-by-cell account.
  assertEquals(tileDiff(before, scenery(2, 1, [1, 1])), null);
  assertEquals(tileDiff(before, undefined), null);
  assertEquals(tileDiff({ cols: 2, rows: 2, tiles: "!!" }, before), null);
});

Deno.test("the dry run says what changes, stage by stage", () => {
  const { payload } = buildPayload({
    existing: augustRecord(),
    cart: cartRecord(),
    key: "Ramsie",
    index: INDEX_ROW,
    deriveGameId: derive,
  });
  const lines = compareRecords(augustRecord(), payload);
  assertStringIncludes(
    lines[0],
    "duke (duke_0) -> dezaShip (dezaShip0.gif)",
  );
  assertStringIncludes(lines[1], "(none) -> dezaemon2");
  assertStringIncludes(lines[2], "1 -> 2 frames");
  const stage0 = lines.find((l) => l.startsWith("stage0:"))!;
  assertStringIncludes(stage0, "1 rows, scenery 2x2");
  assertStringIncludes(stage0, "1 of 4 cells change, 1 re-flipped");
  const stage1 = lines.find((l) => l.startsWith("stage1:"))!;
  assertStringIncludes(stage1, "scenery 2x1 (new)");

  // A stage the cart no longer has is said to go.
  const existing = augustRecord();
  (existing.stages as Json).stage7 = { enemylist: [["00"]] };
  assert(
    compareRecords(existing, payload).some((l) => l === "stage7:      dropped"),
  );
});

Deno.test("describeShip reads the record's player", () => {
  assertEquals(describeShip({}), "(none)");
  assertEquals(describeShip({ playerData: { name: "duke" } }), "duke");
  assertEquals(
    describeShip({ playerData: { name: "dezaShip", texture: ["a.gif"] } }),
    "dezaShip (a.gif)",
  );
});
