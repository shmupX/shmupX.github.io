// The shmupX root: one rule, three copies.
//
// shmupX's games live under `shmupX/` in the database it shares with cmg, and
// only levels, levelAliases, atlases and characters moved there. The app
// spells that rule in lib/rtdb-root.ts; harbor cannot import the app, so it
// keeps its own lib/rtdb-root.ts; and tools/build-level, plain Node with no
// build step, keeps a CommonJS lib/rtdb-root.js. If any two disagree, one
// surface reads a level from shmupX's tree while another reads cmg's root
// copy of the same name — a build of a different game, with nothing in the
// log to say so. So this runs all three over the same paths, the Node copy in
// a real Node, and fails on the first difference.

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import * as harbor from "../lib/rtdb-root.ts";
import * as app from "../../../lib/rtdb-root.ts";
import { harborRoot } from "../lib/repo-root.ts";

const ROOT = harborRoot();

/** Every shape a caller hands in: scoped, shared, REST tails, odd input. */
const PATHS = [
  "levels",
  "levels/gs",
  "levels/2019-PS2",
  "levels/Ramsie/bossData/boss1",
  "levels/Daioh P!/meta",
  "levels.json?shallow=true",
  "levelAliases",
  "levelAliases/2019",
  "levelAliases.json",
  "atlases/dezaBoss0",
  "atlases/foo.json",
  "characters?shallow=true",
  "characters/Daltonius",
  "/levels/foo",
  "//characters",
  "/sprites/RAM_0",
  // Everything that stays at the root.
  "leaderboards/foo-a9f37ed7/allTime",
  "sprites/RAM_0",
  "pixelSprites",
  "pixelRooms/ABCD",
  "tilemaps/level4-2",
  "maps/level1",
  "fonts/athenaFont",
  "eshop/index/2019",
  "dezaemon/index.json?shallow=true",
  "dezaemon/covers/ramsie/png",
  "dezaemonSfc/index",
  "builders/ABCD/launch",
  "exportWorkers/ABCDEFGH",
  "exportQueue/ABCDEFGH/job",
  "exportBlobs/job/0/1",
  "exportInputs/job/0",
  "netplay/room",
  "game",
  "games/evil-invaders",
  "spritePicker/inbox/CODE/batch",
  // Near misses and already-rooted paths.
  "levelsBackup/x",
  "mylevels",
  "x/levels/y",
  "Levels/x",
  "shmupX/levels/gs",
  "",
  "/",
];

/** What tools/build-level computes, in its own runtime. */
async function nodeCopy(paths: string[]): Promise<{
  root: string;
  nodes: string[];
  out: string[];
}> {
  const script = `
    const m = require(${
    JSON.stringify(join(ROOT, "tools", "build-level", "lib", "rtdb-root.js"))
  });
    const paths = JSON.parse(process.argv[1]);
    process.stdout.write(JSON.stringify({
      root: m.RTDB_ROOT,
      nodes: Array.from(m.SCOPED_NODES),
      out: paths.map((p) => m.rtdbPath(p)),
    }));
  `;
  const out = await new Deno.Command("node", {
    args: ["-e", script, JSON.stringify(paths)],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!out.success) throw new Error(new TextDecoder().decode(out.stderr));
  return JSON.parse(new TextDecoder().decode(out.stdout));
}

Deno.test("harbor's root is the contract's, exactly", () => {
  assertEquals(harbor.RTDB_ROOT, "shmupX");
  assertEquals([...harbor.SCOPED_NODES], [
    "levels",
    "levelAliases",
    "atlases",
    "characters",
  ]);
  assertEquals(harbor.rtdbPath("levels/gs"), "shmupX/levels/gs");
  assertEquals(
    harbor.rtdbPath("levelAliases/2019"),
    "shmupX/levelAliases/2019",
  );
  // The shelves and the export queue harbor also reads stay at the root.
  assertEquals(harbor.rtdbPath("dezaemon/index.json"), "dezaemon/index.json");
  assertEquals(harbor.rtdbPath("exportQueue/AB/x"), "exportQueue/AB/x");
  // Rooting twice is a no-op, so a caller that already rooted is safe.
  assertEquals(
    harbor.rtdbPath(harbor.rtdbPath("characters/a")),
    "shmupX/characters/a",
  );
});

Deno.test("harbor's copy agrees with the app's on every path", () => {
  assertEquals(harbor.RTDB_ROOT, app.RTDB_ROOT);
  assertEquals([...harbor.SCOPED_NODES], [...app.SCOPED_NODES]);
  for (const path of PATHS) {
    assertEquals(harbor.rtdbPath(path), app.rtdbPath(path), path);
  }
});

Deno.test("build-level's CommonJS copy agrees in a real Node", async () => {
  const node = await nodeCopy(PATHS);
  assertEquals(node.root, harbor.RTDB_ROOT);
  assertEquals(node.nodes, [...harbor.SCOPED_NODES]);
  PATHS.forEach((path, i) => {
    assertEquals(node.out[i], harbor.rtdbPath(path), path);
  });
});
