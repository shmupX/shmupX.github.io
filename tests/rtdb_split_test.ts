// scripts/rtdb-split.ts: the one-off copy that seeds `shmupX/` from the root
// copies cmg keeps. It runs once against the shared database, so everything
// it promises is pinned here against a stand-in instead: exactly which keys
// it copies, the two gameId pins, that it only ever GETs and PUTs under
// shmupX/<scoped node>/, that it leaves a record someone edited there alone
// (an edit that only deletes, and a field cmg adds at the root later, among
// them), that a run killed after any PUT resumes from there, that a second
// run writes nothing, and that a bad read-back fails the run.
//
// No network. The stand-in replaces globalThis.fetch for the length of each
// test, because the script's reads and rtdb-publish's makePut (the real one,
// throttle and print=silent included) both go through it; the database URL is
// a .test host too, so a stand-in that failed to install could reach nothing.

import {
  assert,
  assertEquals,
  assertFalse,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  applySplit,
  assertInsideRoot,
  checkFooPin,
  checkRamsiePin,
  classify,
  formatPlan,
  gameIdForLevel,
  isSubsetOf,
  LEVEL_GAME_ID_PINS,
  loadStockFoo,
  main,
  planSplit,
  restPath,
  SHMUPX_ALIASES,
  SHMUPX_CHARACTERS,
  SHMUPX_LEVELS,
  SplitError,
  splitPieces,
  writesFor,
} from "../scripts/rtdb-split.ts";

const DB = "https://rtdb-split.test";
const SCOPED = ["levels", "levelAliases", "atlases", "characters"];

// ---- a Realtime Database in memory -------------------------------------------

const INT_KEY = /^(0|[1-9]\d*)$/;

// RTDB stores no nulls and no empty objects, and keeps an array as an object
// keyed by index; a GET turns integer-keyed objects that are more than half
// full back into arrays. The stand-in does the same, so a level split into
// per-index PUTs reads back the way the real database would return it.
function toStore(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object") return value;
  const pairs = Array.isArray(value)
    ? value.map((child, i) => [String(i), child] as const)
    : Object.entries(value);
  const out: Record<string, unknown> = {};
  for (const [key, child] of pairs) {
    const stored = toStore(child);
    if (stored !== null) out[key] = stored;
  }
  return Object.keys(out).length ? out : null;
}

function fromStore(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj);
  const out: Record<string, unknown> = {};
  for (const key of keys) out[key] = fromStore(obj[key]);
  if (keys.length && keys.every((k) => INT_KEY.test(k))) {
    const max = Math.max(...keys.map(Number));
    if (keys.length * 2 > max + 1) {
      const array: unknown[] = new Array(max + 1).fill(null);
      for (const key of keys) array[Number(key)] = out[key];
      return array;
    }
  }
  return out;
}

interface Seen {
  method: string;
  /** Decoded database path, segments joined by "/". */
  path: string;
  /** The URL's pathname as sent, still encoded. */
  raw: string;
  query: string;
  body?: unknown;
}

class FakeRtdb {
  tree: unknown = null;
  seen: Seen[] = [];
  /** Rewrites what a PUT stores, to fake a write that did not land as sent. */
  corrupt?: (path: string, value: unknown) => unknown;

  constructor(seed: unknown) {
    this.tree = toStore(seed);
  }

  get(segments: string[]): unknown {
    let at = this.tree;
    for (const segment of segments) {
      if (at === null || typeof at !== "object") return null;
      at = (at as Record<string, unknown>)[segment] ?? null;
    }
    return fromStore(at);
  }

  set(segments: string[], value: unknown) {
    const stored = toStore(value);
    if (!segments.length) {
      this.tree = stored;
      return;
    }
    if (this.tree === null || typeof this.tree !== "object") this.tree = {};
    let at = this.tree as Record<string, unknown>;
    const trail: [Record<string, unknown>, string][] = [];
    for (const segment of segments.slice(0, -1)) {
      let next = at[segment];
      if (next === null || next === undefined || typeof next !== "object") {
        next = {};
        at[segment] = next;
      }
      trail.push([at, segment]);
      at = next as Record<string, unknown>;
    }
    const last = segments[segments.length - 1];
    if (stored === null) delete at[last];
    else at[last] = stored;
    for (let i = trail.length - 1; i >= 0; i--) {
      const [parent, key] = trail[i];
      if (!Object.keys(parent[key] as object).length) delete parent[key];
    }
  }

  /** Everything outside shmupX/, as a GET of the root would show it. */
  outsideRoot(): unknown {
    const all = structuredClone(this.get([])) as Record<string, unknown>;
    delete all.shmupX;
    return all;
  }

  writes(): Seen[] {
    return this.seen.filter((s) => s.method !== "GET");
  }

  fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    assertEquals(url.origin, DB, "every request goes to the stand-in");
    assert(url.pathname.endsWith(".json"), `REST path ${url.pathname}`);
    const inner = url.pathname.slice(1, -".json".length);
    const segments = inner ? inner.split("/").map(decodeURIComponent) : [];
    const seen: Seen = {
      method: req.method,
      path: segments.join("/"),
      raw: url.pathname,
      query: url.search,
    };
    this.seen.push(seen);
    if (req.method === "GET") {
      let value = this.get(segments);
      if (url.searchParams.get("shallow") === "true" && value !== null) {
        value = typeof value === "object"
          ? Object.fromEntries(
            Object.keys(value as object).map((k) => [k, true]),
          )
          : value;
      }
      return new Response(JSON.stringify(value));
    }
    if (req.method === "PUT") {
      let body = JSON.parse(await req.text());
      seen.body = body;
      if (this.corrupt) body = this.corrupt(seen.path, body);
      this.set(segments, body);
      return url.searchParams.get("print") === "silent"
        ? new Response(null, { status: 204 })
        : new Response(JSON.stringify(body));
    }
    return new Response("method not allowed", { status: 405 });
  }) as typeof fetch;
}

async function withFake<T>(fake: FakeRtdb, fn: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = fake.fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
}

// ---- a root shaped like the live one, small ------------------------------------

// The stock foo.json is 6 MB; the derivation only reads its name and gameId.
const STOCK_FOO = { name: "foo" };
// Small enough that foo and rando go up in pieces, as they do live.
const MAX_PUT = 2_000;

function rootSeed() {
  const characters: Record<string, unknown> = {};
  const atlases: Record<string, unknown> = {};
  for (const id of SHMUPX_CHARACTERS) {
    characters[id] = { name: id, textureKey: id, hp: 10 };
    atlases[id] = { json: { frames: { [`${id}0․png`]: { x: 0 } } }, png: "p" };
  }
  // One character whose atlas has another name, one with no textureKey.
  characters.sakura = { name: "sakura", textureKey: "sakuraSheet", hp: 3 };
  delete atlases.sakura;
  atlases.sakuraSheet = { json: { frames: {}, meta: "s" }, png: "s" };
  characters.akuma = { name: "akuma", hp: 7 };
  // Root-only art the copy must not take: spriteX packs and cmg's own.
  atlases.hadouken = { png: "h" };
  characters.weirdo = { name: "weirdo" };
  return {
    levels: {
      "2019-PS2": {
        name: "2019",
        gameId: "2019-ps2-adb9fb3f",
        stages: [{ bg: "temple" }, { bg: "moon" }],
        atlasFrames: { "asteroidFace0․png": { x: 1 }, "a b": { x: 2 } },
      },
      foo: {
        name: "foo",
        gameId: "foo-5d6de24c",
        godMode: true,
        titleBgDataURL: "data:image/png;base64," + "A".repeat(3_000),
        storyData: { pages: ["x".repeat(1_500), "y".repeat(1_500)] },
        atlasFrames: { "asteroidFace0․png": { x: 1, y: 2 }, "a b": { x: 3 } },
      },
      gs: {
        name: "gs",
        gameId: "gs-710c41d3",
        bossData: { boss1: "dezaBoss0" },
      },
      Ramsie: { name: "Ramsie", godMode: true, enemyData: { e0: "deza1_09" } },
      rando: {
        name: "rando",
        gameId: "rando-b90175cc",
        uiAtlases: { a: "u".repeat(1_200), b: "v".repeat(1_200) },
      },
      // cmg-only: the lowercase twin and every other game stay at the root.
      ramsie: { name: "ramsie", gameId: "ramsie-1e5d2b8a" },
      hell: { name: "hell" },
    },
    levelAliases: { ...SHMUPX_ALIASES, contra: "hell" } as Record<
      string,
      string
    >,
    characters,
    atlases,
    leaderboards: { "foo-a9f37ed7": { allTime: { score: 100 } } },
    sprites: { RAM_0: "r" },
  };
}

function planHere(fake: FakeRtdb) {
  return withFake(
    fake,
    () => planSplit({ db: DB, stockFoo: STOCK_FOO, maxPutBytes: MAX_PUT }),
  );
}

function run(fake: FakeRtdb, args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  return withFake(fake, async () => {
    const code = await main([...args, "--db", DB], {
      log: (l) => out.push(l),
      error: (l) => err.push(l),
      stockFoo: STOCK_FOO,
      maxPutBytes: MAX_PUT,
    });
    return { code, out: out.join("\n"), err: err.join("\n") };
  });
}

/** What each record should be under shmupX/, built by hand from the seed. */
function expectedSubtree() {
  const root = rootSeed();
  const levels: Record<string, unknown> = {};
  for (const key of SHMUPX_LEVELS) {
    levels[key] = (root.levels as Record<string, unknown>)[key];
  }
  levels.foo = { ...(levels.foo as object), gameId: "foo-a9f37ed7" };
  levels.Ramsie = { ...(levels.Ramsie as object), gameId: "ramsie-cae9647a" };
  const characters: Record<string, unknown> = {};
  const atlases: Record<string, unknown> = {};
  for (const id of SHMUPX_CHARACTERS) {
    characters[id] = root.characters[id];
    const atlas = id === "sakura" ? "sakuraSheet" : id;
    atlases[atlas] = root.atlases[atlas];
  }
  return fromStore(toStore({
    levels,
    levelAliases: SHMUPX_ALIASES,
    characters,
    atlases,
  }));
}

/** A database the copy has already been run against, start to finish. */
async function written(): Promise<FakeRtdb> {
  const fake = new FakeRtdb(rootSeed());
  const { code, out } = await run(fake, ["--write"]);
  assertEquals(code, 0, out);
  fake.seen = [];
  return fake;
}

/** The record a PUT belongs to: shmupX/<node>/<key>. */
function recordOf(path: string): string {
  return path.split("/").slice(0, 3).join("/");
}

// ---- the plan ---------------------------------------------------------------

Deno.test("the dry run plans exactly the contract's records, by key, and only reads", async () => {
  const fake = new FakeRtdb(rootSeed());
  const { code, out } = await run(fake, []);
  assertEquals(code, 0);
  assertEquals(fake.writes(), [], "a dry run sends nothing but GETs");
  assertStringIncludes(out, "Dry run — nothing written");
  assertStringIncludes(out, "totals: 65 records");
  assertStringIncludes(out, "gameId foo-5d6de24c -> foo-a9f37ed7 (pinned)");
  assertStringIncludes(out, "gameId (none) -> ramsie-cae9647a (pinned)");
  assertStringIncludes(out, "gameId gs-710c41d3 (kept)");

  // It reads record by record — never a whole root node (431 atlases, 41
  // levels) — and lists shmupX/ shallowly before reading what is there.
  for (const get of fake.seen) {
    const [first, ...rest] = get.path.split("/");
    if (first === "shmupX") {
      if (rest.length === 1) assertEquals(get.query, "?shallow=true");
      else assertEquals(rest.length, 2, get.path);
    } else {
      assert(
        SCOPED.includes(first),
        `read outside the scoped nodes: ${get.path}`,
      );
      assertEquals(rest.length, 1, `one record at a time, not ${get.path}`);
    }
  }

  const plan = await planHere(new FakeRtdb(rootSeed()));
  const keys = (node: string) =>
    plan.records.filter((r) => r.node === node).map((r) => r.key);
  assertEquals(keys("levels"), SHMUPX_LEVELS);
  assertEquals(keys("levelAliases"), ["2019", "streetfighter"]);
  assertEquals(keys("characters"), SHMUPX_CHARACTERS);
  assertEquals(keys("characters").length, 29);
  // textureKey || id: sakura's sheet has another name, akuma has none.
  const atlasKeys = keys("atlases");
  assertEquals(atlasKeys.length, 29);
  assert(atlasKeys.includes("sakuraSheet") && !atlasKeys.includes("sakura"));
  assert(atlasKeys.includes("akuma"));
  for (const left of ["ramsie", "hell", "hadouken", "weirdo", "contra"]) {
    assertFalse(
      plan.records.some((r) => r.key === left),
      `${left} stays cmg's`,
    );
  }
  // Written in dependency order: art, characters, levels, then the aliases.
  assertEquals(
    [...new Set(plan.records.map((r) => r.node))],
    ["atlases", "characters", "levels", "levelAliases"],
  );

  const byKey = (node: string, key: string) =>
    plan.records.find((r) => r.node === node && r.key === key)!;
  const root = rootSeed();
  for (const r of plan.records) {
    assertEquals(r.target, `shmupX/${r.node}/${r.key}`);
    assertEquals(r.source, `${r.node}/${r.key}`);
    assertEquals(r.state, "new");
    assertEquals(
      r.bytes,
      new TextEncoder().encode(JSON.stringify(r.value)).length,
    );
  }
  assertEquals(byKey("levels", "foo").value, {
    ...root.levels.foo,
    gameId: "foo-a9f37ed7",
  });
  assertEquals(byKey("levels", "Ramsie").value, {
    ...root.levels.Ramsie,
    gameId: "ramsie-cae9647a",
  });
  assertEquals(byKey("levels", "gs").value, root.levels.gs);
  assertEquals(byKey("levels", "2019-PS2").value, root.levels["2019-PS2"]);
  assertEquals(byKey("levelAliases", "2019").value, "2019-PS2");
  // Big records go up in pieces, small ones whole.
  assert(byKey("levels", "foo").pieces.length > 1);
  assert(byKey("levels", "rando").pieces.length > 1);
  assertEquals(byKey("levels", "gs").pieces.length, 1);

  const text = formatPlan(plan).join("\n");
  assertStringIncludes(text, "levels (5,");
  assertStringIncludes(text, "levels/<key> -> shmupX/levels/<key>");
  assertStringIncludes(text, "streetfighter");
});

Deno.test("the gameId pins are recomputed with the runtime's derivation, not trusted", async () => {
  assertEquals(gameIdForLevel({ name: "Ramsie" }), "ramsie-cae9647a");
  assertEquals(gameIdForLevel({ name: "foo" }), "foo-a9f37ed7");
  assertEquals(LEVEL_GAME_ID_PINS, {
    foo: "foo-a9f37ed7",
    Ramsie: "ramsie-cae9647a",
  });
  // The real stock record: no gameId of its own, so it derives foo's board.
  const stock = await loadStockFoo() as Record<string, unknown>;
  assertEquals(stock.name, "foo");
  assertEquals(stock.gameId, undefined);
  checkFooPin(stock);

  assertThrows(() => checkFooPin({ name: "Foo" }), SplitError, "foo.json");
  assertThrows(
    () => checkFooPin({ name: "foo", gameId: "foo-5d6de24c" }),
    SplitError,
  );
  assertThrows(() => checkRamsiePin("ramsie"), SplitError, "ramsie-cae9647a");
  checkRamsiePin("Ramsie");

  // A root Ramsie renamed out from under the pin stops the plan.
  const seed = rootSeed();
  seed.levels.Ramsie.name = "Ramsie!";
  await assertRejects(
    () => planHere(new FakeRtdb(seed)),
    SplitError,
    "levels/Ramsie",
  );
  // So does a stock game whose board moved.
  await assertRejects(
    () =>
      withFake(
        new FakeRtdb(rootSeed()),
        () => planSplit({ db: DB, stockFoo: { name: "foo", gameId: "x" } }),
      ),
    SplitError,
    "foo.json",
  );
});

Deno.test("a root that drifted from the contract stops the run before anything is written", async () => {
  const cases: [string, (s: ReturnType<typeof rootSeed>) => void][] = [
    ["levelAliases/streetfighter", (s) => {
      s.levelAliases.streetfighter = "gs";
    }],
    ["characters/deza1_09", (s) => {
      delete s.characters.deza1_09;
    }],
    ["atlases/sakuraSheet (for sakura)", (s) => {
      delete s.atlases.sakuraSheet;
    }],
    ["levels/gs", (s) => {
      delete (s.levels as Record<string, unknown>).gs;
    }],
    ["levels/rando has no gameId", (s) => {
      delete (s.levels.rando as Record<string, unknown>).gameId;
    }],
  ];
  for (const [needle, drift] of cases) {
    const seed = rootSeed();
    drift(seed);
    const fake = new FakeRtdb(seed);
    const { code, err } = await run(fake, ["--write"]);
    assertEquals(code, 2, needle);
    assertStringIncludes(err, needle);
    assertEquals(fake.writes(), [], `${needle}: nothing written`);
  }
});

// ---- writing ----------------------------------------------------------------

Deno.test("--write copies into shmupX/ only, in pieces, and verifies by read-back", async () => {
  const fake = new FakeRtdb(rootSeed());
  const before = fake.outsideRoot();
  const { code, out } = await run(fake, ["--write"]);
  assertEquals(code, 0, out);
  assertStringIncludes(out, "verified 65/65 record(s) by read-back");

  const writes = fake.writes();
  assert(writes.length > 65, "foo and rando went up in pieces");
  for (const w of writes) {
    assertEquals(w.method, "PUT");
    assertEquals(w.query, "?print=silent");
    const [root, node, key] = w.path.split("/");
    assertEquals(root, "shmupX", w.path);
    assert(SCOPED.includes(node), w.path);
    assert(key, w.path);
    assert(w.body !== null, `no PUT of null (a delete): ${w.path}`);
  }
  // The root — cmg's catalog, leaderboards, sprites — is exactly as it was.
  assertEquals(fake.outsideRoot(), before);
  assertEquals(fake.get(["shmupX"]), expectedSubtree());

  // Atlases land before the characters that name them, levels before the
  // aliases that point at them.
  const firstAt = (node: string) =>
    writes.findIndex((w) => w.path.startsWith(`shmupX/${node}/`));
  const lastAt = (node: string) =>
    writes.findLastIndex((w) => w.path.startsWith(`shmupX/${node}/`));
  assert(lastAt("atlases") < firstAt("characters"));
  assert(lastAt("characters") < firstAt("levels"));
  assert(lastAt("levels") < firstAt("levelAliases"));

  // Keys are encoded per segment: a space, and the one-dot leader frame
  // names use in place of a "." RTDB forbids.
  const paths = writes.map((w) => w.raw);
  assert(paths.includes("/shmupX/levels/foo/titleBgDataURL.json"));
  assert(paths.includes("/shmupX/levels/foo/storyData/pages/0.json"));
  assert(paths.includes("/shmupX/levels/foo/atlasFrames.json"));
  assert(paths.includes("/shmupX/levels/2019-PS2.json"));
  assert(paths.includes("/shmupX/levels/Ramsie.json"));
  assert(paths.includes(`/shmupX/atlases/${restPath(["sakuraSheet"])}.json`));
  assertEquals(
    restPath(["levels", "Daioh P!", "a b", "f0․png"]),
    "levels/Daioh%20P!/a%20b/f0%E2%80%A4png",
  );
  assertEquals(
    fake.get(["shmupX", "levels", "foo", "atlasFrames", "a b"]),
    { x: 3 },
  );
});

Deno.test("a second run writes nothing", async () => {
  const fake = new FakeRtdb(rootSeed());
  assertEquals((await run(fake, ["--write"])).code, 0);
  const plan = await planHere(fake);
  assert(plan.records.every((r) => r.state === "same"));
  fake.seen = [];
  const again = await run(fake, ["--write"]);
  assertEquals(again.code, 0, again.out);
  assertEquals(fake.writes(), []);
  assertStringIncludes(again.out, "same 65");
  assertStringIncludes(again.out, "Wrote 0 PUT(s)");
});

Deno.test("a run killed after any PUT resumes from there, resending nothing that landed", async () => {
  // Every PUT a whole run makes, in order. Replaying the first n of them into
  // a fresh database is exactly what a run killed after its nth PUT leaves —
  // or killed during PUT n+1, which lands whole or not at all.
  const whole = new FakeRtdb(rootSeed());
  assertEquals((await run(whole, ["--write"])).code, 0);
  const puts = whole.writes();
  const expected = expectedSubtree();
  const fresh = await planHere(new FakeRtdb(rootSeed()));
  // One cut inside a record per gap between two of its pieces.
  const insideCuts = fresh.records.reduce(
    (n, r) => n + r.pieces.length - 1,
    0,
  );
  assert(insideCuts > 0, "foo and rando go up in pieces");

  let partials = 0;
  for (let n = 0; n <= puts.length; n++) {
    const fake = new FakeRtdb(rootSeed());
    for (const w of puts.slice(0, n)) fake.set(w.path.split("/"), w.body);
    const landed = new Set(puts.slice(0, n).map((w) => recordOf(w.path)));
    const midRecord = n > 0 && n < puts.length &&
        recordOf(puts[n - 1].path) === recordOf(puts[n].path)
      ? recordOf(puts[n].path)
      : undefined;

    const plan = await planHere(fake);
    for (const r of plan.records) {
      const want = r.target === midRecord
        ? "partial"
        : landed.has(r.target)
        ? "same"
        : "new";
      assertEquals(r.state, want, `cut after PUT ${n}: ${r.target}`);
    }
    if (midRecord) partials++;

    const { code, out } = await run(fake, ["--write"]);
    assertEquals(code, 0, `cut after PUT ${n}: ${out}`);
    // The resumed run sends exactly what the killed one had left to send.
    assertEquals(
      fake.writes().map((w) => w.path),
      puts.slice(n).map((w) => w.path),
      `cut after PUT ${n}`,
    );
    assertEquals(fake.get(["shmupX"]), expected, `cut after PUT ${n}`);
  }
  assertEquals(partials, insideCuts);
});

Deno.test("an edit that only deletes, under shmupX/, is reported, not undone", async () => {
  const fake = await written();
  // Both go up in one PUT, so no run could have left either like this.
  fake.set(["shmupX", "characters", "dezaBoss0", "hp"], null);
  fake.set(["shmupX", "levels", "2019-PS2", "stages", "1"], null);
  const boss = fake.get(["shmupX", "characters", "dezaBoss0"]);
  const level = fake.get(["shmupX", "levels", "2019-PS2"]);
  assertEquals(boss, { name: "dezaBoss0", textureKey: "dezaBoss0" });
  assertEquals((level as { stages: unknown }).stages, [{ bg: "temple" }]);

  const plan = await planHere(fake);
  for (
    const target of ["shmupX/characters/dezaBoss0", "shmupX/levels/2019-PS2"]
  ) {
    const r = plan.records.find((r) => r.target === target)!;
    assertEquals(r.pieces.length, 1, target);
    assertEquals(r.state, "differs", target);
    assertEquals(writesFor(r), [], target);
  }
  assertStringIncludes(
    formatPlan(plan).join("\n"),
    "leaving 2 differing record(s) alone",
  );

  const { code, out } = await run(fake, ["--write"]);
  assertEquals(code, 3, out);
  assertEquals(fake.writes(), []);
  assertStringIncludes(out, "skip  shmupX/characters/dezaBoss0");
  assertStringIncludes(out, "skip  shmupX/levels/2019-PS2");
  assertStringIncludes(
    out,
    "Left alone (differ under shmupX/): shmupX/characters/dezaBoss0, shmupX/levels/2019-PS2.",
  );
  assertEquals(fake.get(["shmupX", "characters", "dezaBoss0"]), boss);
  assertEquals(fake.get(["shmupX", "levels", "2019-PS2"]), level);

  // Putting them back is a person's call, and goes in one body each.
  const forced = await run(fake, ["--write", "--force"]);
  assertEquals(forced.code, 0, forced.out);
  assertEquals(fake.writes().map((w) => w.path), [
    "shmupX/characters/dezaBoss0",
    "shmupX/levels/2019-PS2",
  ]);
  assertEquals(fake.get(["shmupX"]), expectedSubtree());
});

Deno.test("a field cmg adds at the root after the split is reported, not copied", async () => {
  const fake = await written();
  fake.set(["characters", "dezaBoss0", "cmgOnly"], true);
  const root = fake.outsideRoot();
  const copy = fake.get(["shmupX", "characters", "dezaBoss0"]);

  const plan = await planHere(fake);
  const r = plan.records.find((r) =>
    r.target === "shmupX/characters/dezaBoss0"
  )!;
  // The shmupX copy is a strict subset of the new root record — the shape
  // that used to pass for an interrupted run.
  assert(isSubsetOf(copy, r.value));
  assertEquals(r.state, "differs");

  const { code, out } = await run(fake, ["--write"]);
  assertEquals(code, 3, out);
  assertEquals(fake.writes(), []);
  assertStringIncludes(out, "skip  shmupX/characters/dezaBoss0");
  assertEquals(fake.get(["shmupX", "characters", "dezaBoss0"]), copy);
  assertEquals(fake.outsideRoot(), root, "cmg's root is untouched either way");
});

Deno.test("in a split record, only a head of its pieces in write order reads as an interrupted run", async () => {
  // Key order, not the order the seed (or a GET) lists foo's fields in.
  const plan = await planHere(new FakeRtdb(rootSeed()));
  const foo = plan.records.find((r) => r.target === "shmupX/levels/foo")!;
  assertEquals(foo.pieces.map((p) => p.segments.slice(3).join("/")), [
    "atlasFrames",
    "gameId",
    "godMode",
    "name",
    "storyData/pages/0",
    "storyData/pages/1",
    "titleBgDataURL",
  ]);

  const fooAt = (...rest: string[]) => ["shmupX", "levels", "foo", ...rest];
  const edits: [string, (fake: FakeRtdb) => void][] = [
    ["a key deleted inside a piece that landed", (fake) => {
      fake.set(fooAt("atlasFrames", "a b"), null);
    }],
    ["a piece deleted from the middle", (fake) => {
      fake.set(fooAt("godMode"), null);
    }],
    ["a field cmg adds at the root that sorts among the others", (fake) => {
      fake.set(["levels", "foo", "cmgOnly"], 1);
    }],
  ];
  for (const [what, edit] of edits) {
    const fake = await written();
    edit(fake);
    const before = fake.get(fooAt());
    const { code, out } = await run(fake, ["--write"]);
    assertEquals(code, 3, `${what}: ${out}`);
    assertStringIncludes(out, "skip  shmupX/levels/foo", what);
    assertEquals(fake.writes(), [], what);
    assertEquals(fake.get(fooAt()), before, what);
  }

  // Pieces that landed out of write order are no run's doing either.
  const scattered = new FakeRtdb(rootSeed());
  scattered.set(fooAt("name"), "foo");
  scattered.set(fooAt("titleBgDataURL"), rootSeed().levels.foo.titleBgDataURL);
  const state =
    (await planHere(scattered)).records.find((r) =>
      r.target === "shmupX/levels/foo"
    )!.state;
  assertEquals(state, "differs");

  // The limit the header names: losing exactly the last piece looks like a
  // run that stopped before it, so the dry run shows it as partial, with the
  // one PUT a --write would send.
  const tail = await written();
  tail.set(fooAt("titleBgDataURL"), null);
  const dry = await run(tail, []);
  assertEquals(dry.code, 0);
  assert(/partial foo\s.*\(1 to write\)/.test(dry.out), dry.out);
});

Deno.test("a record edited under shmupX/ is left alone, and only --force replaces it, whole", async () => {
  const fake = new FakeRtdb(rootSeed());
  const edited = { ...rootSeed().levels.gs, name: "gs (edited)", mine: "yes" };
  fake.set(["shmupX", "levels", "gs"], edited);
  // An alias someone repointed is an edit too, even though it is one string.
  fake.set(["shmupX", "levelAliases", "streetfighter"], "gs");
  // A level saved straight into shmupX/ is not this copy's business.
  fake.set(["shmupX", "levels", "newGame"], { name: "newGame" });

  const plan = await planHere(fake);
  const state = (node: string, key: string) =>
    plan.records.find((r) => r.node === node && r.key === key)!.state;
  assertEquals(state("levels", "gs"), "differs");
  assertEquals(state("levelAliases", "streetfighter"), "differs");
  assertEquals(plan.extras.levels, ["newGame"]);
  // What the dry run counts: nothing for it without --force, one whole-record
  // body with it.
  const gs = plan.records.find((r) => r.node === "levels" && r.key === "gs")!;
  assertEquals(writesFor(gs), []);
  assertEquals(writesFor(gs, true).map((p) => p.segments.join("/")), [
    "shmupX/levels/gs",
  ]);
  assertStringIncludes(
    formatPlan(plan).join("\n"),
    "leaving 2 differing record(s) alone",
  );

  const first = await run(fake, ["--write"]);
  assertEquals(first.code, 3, first.out);
  assertStringIncludes(first.out, "skip  shmupX/levels/gs");
  assertStringIncludes(
    first.out,
    "also under shmupX/levels, left alone: newGame",
  );
  assertFalse(fake.writes().some((w) => w.path.startsWith("shmupX/levels/gs")));
  assertEquals(fake.get(["shmupX", "levels", "gs"]), edited);
  assertEquals(fake.get(["shmupX", "levelAliases", "streetfighter"]), "gs");
  assertEquals(fake.get(["shmupX", "levels", "newGame"]), { name: "newGame" });
  // Everything else went in and was verified.
  assertEquals(
    fake.get(["shmupX", "levels", "foo"]),
    (expectedSubtree() as { levels: Record<string, unknown> }).levels.foo,
  );

  assertEquals((await run(fake, ["--force"])).code, 2, "--force needs --write");

  fake.seen = [];
  const forced = await run(fake, ["--write", "--force"]);
  assertEquals(forced.code, 0, forced.out);
  // One body, so the edit's extra children go with it — no DELETE needed.
  assertEquals(fake.writes().map((w) => w.path), [
    "shmupX/levels/gs",
    "shmupX/levelAliases/streetfighter",
  ]);
  assertEquals(fake.get(["shmupX", "levels", "gs"]), rootSeed().levels.gs);
  assertEquals(fake.get(["shmupX", "levels", "newGame"]), { name: "newGame" });
});

Deno.test("a read-back that does not match what was sent fails the run", async () => {
  const fake = new FakeRtdb(rootSeed());
  fake.corrupt = (path, value) =>
    path === "shmupX/characters/dezaBoss0"
      ? { ...(value as object), hp: 1 }
      : value;
  const { code, err } = await run(fake, ["--write"]);
  assertEquals(code, 1);
  assertStringIncludes(err, "shmupX/characters/dezaBoss0 reads back as sha256");

  const fresh = new FakeRtdb(rootSeed());
  fresh.corrupt = (path, value) =>
    path === "shmupX/levels/foo/gameId" ? "foo-5d6de24c" : value;
  const plan = await planHere(fresh);
  const result = await withFake(
    fresh,
    () => applySplit(plan, { log: () => {} }),
  );
  assertEquals(result.mismatches.map((m) => m.target), ["shmupX/levels/foo"]);
  assertEquals(result.verified.length, 64);
});

// ---- the guard ----------------------------------------------------------------

Deno.test("no plan, however built, can write outside shmupX/<scoped node>/<key>", async () => {
  for (
    const bad of [
      ["levels", "foo"],
      ["shmupX"],
      ["shmupX", "levels"],
      ["shmupX", "sprites", "RAM_0"],
      ["shmupX", "leaderboards", "foo-a9f37ed7"],
      ["cmg", "levels", "foo"],
      ["leaderboards", "foo-a9f37ed7", "allTime"],
    ]
  ) {
    assertThrows(() => assertInsideRoot(bad), Error, "refusing to write");
  }
  assertInsideRoot(["shmupX", "levels", "foo"]);
  assertInsideRoot(["shmupX", "atlases", "dezaBoss0", "png"]);

  // A tampered plan is refused whole, before its first PUT.
  const fake = new FakeRtdb(rootSeed());
  const plan = await planHere(fake);
  plan.records[plan.records.length - 1].pieces = [{
    segments: ["levels", "foo"],
    value: { name: "oops" },
    bytes: 16,
  }];
  await assertRejects(
    () => withFake(fake, () => applySplit(plan, { log: () => {} })),
    Error,
    'refusing to write "levels/foo"',
  );
  assertEquals(fake.writes(), []);
  assertEquals(fake.get(["levels", "foo"]), rootSeed().levels.foo);
});

Deno.test("--db is the database's base; a subtree there would re-root every node", async () => {
  const fake = new FakeRtdb(rootSeed());
  const out: string[] = [];
  const code = await withFake(fake, () =>
    main(["--db", `${DB}/shmupX`], {
      log: () => {},
      error: (l) => out.push(l),
      stockFoo: STOCK_FOO,
    }));
  assertEquals(code, 2);
  assertStringIncludes(out.join("\n"), "base URL");
  assertEquals(fake.seen, []);
});

// ---- the pieces -----------------------------------------------------------------

Deno.test("pieces split by child, arrays by index, and never carry a null", () => {
  const value = {
    a: "x".repeat(50),
    b: [null, "y".repeat(50), "z"],
    c: 1,
  };
  const pieces = splitPieces(["r"], value, 40);
  assertEquals(pieces.map((p) => p.segments.join("/")), [
    "r/a",
    "r/b/1",
    "r/b/2",
    "r/c",
  ]);
  assert(pieces.every((p) => p.value !== null));
  assertEquals(splitPieces(["r"], value, 1_000).length, 1);
  // A single value bigger than the line still goes as one piece.
  assertEquals(splitPieces(["r"], "q".repeat(100), 10).length, 1);
});

Deno.test("a subset holds nothing the plan would not write, and nothing changed", () => {
  const intended = { a: 1, b: { c: [1, 2, 3], d: "x" } };
  assert(isSubsetOf({ a: 1 }, intended));
  assert(isSubsetOf({ b: { c: [1, null, 3] } }, intended));
  assert(isSubsetOf({ b: { c: { 2: 3 } } }, intended));
  assertFalse(isSubsetOf({ a: 2 }, intended));
  assertFalse(isSubsetOf({ a: 1, e: true }, intended));
  assertFalse(isSubsetOf({ b: { d: "y" } }, intended));
  assertFalse(isSubsetOf("x", intended));
});

Deno.test("partial is a head of the pieces, landed exactly, and nothing else", () => {
  const base = ["shmupX", "levels", "k"];
  const a = { p: 1, q: 2 };
  const intended = { a, b: { c: "x".repeat(10), d: "y" }, e: 2 };
  const pieces = splitPieces(base, intended, 20);
  assertEquals(pieces.map((p) => p.segments.slice(3).join("/")), [
    "a",
    "b/c",
    "b/d",
    "e",
  ]);
  const c = intended.b.c;
  const state = (current: unknown) => classify(current, intended, pieces, base);
  assertEquals(state(null), "new");
  assertEquals(state(structuredClone(intended)), "same");
  // What a run killed after its first, second or third PUT leaves.
  assertEquals(state({ a }), "partial");
  assertEquals(state({ a, b: { c } }), "partial");
  assertEquals(state({ a, b: { c, d: "y" } }), "partial");
  // Subsets no run leaves: the first piece missing, a gap, a piece half there
  // (a key deleted inside it, which re-sending the piece would put back).
  assertEquals(state({ b: { c } }), "differs");
  assertEquals(state({ a, e: 2 }), "differs");
  assertEquals(state({ a: { p: 1 } }), "differs");
  // And what is not a subset at all.
  assertEquals(state({ a, b: { c: "z" } }), "differs");
  assertEquals(state({ a, f: 3 }), "differs");
  assertEquals(state("x"), "differs");

  // Sent whole, a record has no in-between: any subset of it is an edit.
  const whole = splitPieces(base, intended);
  assertEquals(whole.length, 1);
  for (const current of [{ a }, { a, b: { c, d: "y" } }]) {
    assertEquals(classify(current, intended, whole, base), "differs");
  }
});
