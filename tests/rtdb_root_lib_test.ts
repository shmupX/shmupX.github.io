// lib/rtdb-root.ts: shmupX's games live under `shmupX/` in the database it
// shares with cmg, and only levels, levelAliases, atlases and characters
// moved there. Everything else a path can name stays at the root.

import { assertEquals } from "@std/assert";
import { RTDB_ROOT, rtdbPath, SCOPED_NODES } from "../lib/rtdb-root.ts";

Deno.test("the root and the nodes under it are the contract's, exactly", () => {
  assertEquals(RTDB_ROOT, "shmupX");
  assertEquals([...SCOPED_NODES], [
    "levels",
    "levelAliases",
    "atlases",
    "characters",
  ]);
});

Deno.test("a path into a scoped node gains the root", () => {
  assertEquals(rtdbPath("levels"), "shmupX/levels");
  assertEquals(rtdbPath("levels/2019-PS2"), "shmupX/levels/2019-PS2");
  assertEquals(
    rtdbPath("levels/gs/bossData/boss1"),
    "shmupX/levels/gs/bossData/boss1",
  );
  assertEquals(rtdbPath("levelAliases/2019"), "shmupX/levelAliases/2019");
  assertEquals(rtdbPath("atlases/dezaBoss0"), "shmupX/atlases/dezaBoss0");
  assertEquals(rtdbPath("characters/Daltonius"), "shmupX/characters/Daltonius");
  // A level key is whatever its author typed, spaces and all.
  assertEquals(
    rtdbPath("levels/Daioh P!/meta"),
    "shmupX/levels/Daioh P!/meta",
  );
});

Deno.test("a REST spelling — .json suffix, a query — is still recognised", () => {
  assertEquals(
    rtdbPath("levels.json?shallow=true"),
    "shmupX/levels.json?shallow=true",
  );
  assertEquals(
    rtdbPath("characters?shallow=true"),
    "shmupX/characters?shallow=true",
  );
  assertEquals(rtdbPath("levelAliases.json"), "shmupX/levelAliases.json");
  assertEquals(rtdbPath("atlases/foo.json"), "shmupX/atlases/foo.json");
});

Deno.test("leading slashes are tolerated and kept where they were", () => {
  assertEquals(rtdbPath("/levels/foo"), "/shmupX/levels/foo");
  assertEquals(rtdbPath("//characters"), "//shmupX/characters");
  assertEquals(rtdbPath("/sprites/RAM_0"), "/sprites/RAM_0");
});

Deno.test("every other node is left at the root, untouched", () => {
  for (
    const path of [
      "leaderboards/foo-a9f37ed7/allTime",
      "sprites/RAM_0",
      "pixelSprites",
      "pixelRooms/ABCD",
      "tilemaps/level4-2",
      "maps/x",
      "fonts/y",
      "eshop/index/2019",
      "dezaemon/saves/a",
      "dezaemonSfc/index",
      "builders/abc",
      "exportWorkers/builders",
      "exportQueue/job",
      "exportBlobs/job/0",
      "exportInputs/job",
      "netplay/room",
      "game",
      "games/evil-invaders",
      "spritePicker/inbox",
      "",
      "/",
    ]
  ) {
    assertEquals(rtdbPath(path), path, path);
  }
});

Deno.test("only a whole first segment matches, and rooting twice is a no-op", () => {
  assertEquals(rtdbPath("levelsBackup/x"), "levelsBackup/x");
  assertEquals(rtdbPath("mylevels"), "mylevels");
  assertEquals(rtdbPath("x/levels/y"), "x/levels/y");
  assertEquals(rtdbPath("Levels/x"), "Levels/x", "keys are case-sensitive");
  assertEquals(rtdbPath("shmupX/levels/gs"), "shmupX/levels/gs");
  assertEquals(rtdbPath(rtdbPath("atlases/a")), "shmupX/atlases/a");
});
