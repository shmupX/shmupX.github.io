// `deno task sfc:openemu`: the cart in OpenEmu's library found by its contents,
// the battery slot named after it, the slot backed up and read back, and the
// auto save state retired from both the disk and the library database —
// all against a fixture Application Support folder, never the real one.

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  AUTO_STATE_BUNDLE,
  AUTO_STATE_NAME,
  autoStateLocation,
  batterySlot,
  findOpenEmuRom,
  installOpenEmuSram,
  openEmuPaths,
  retireAutoSaveState,
  statesFolder,
} from "../lib/sfc-openemu.ts";
import { formatSfcSram } from "../packages/shmup-engine/src/sfc/index.js";

const ROM_BYTES = 0x80000;
const HEADER = 0x7fc0;

/** A ROM whose internal header says what a Dezaemon cart's does (as tests/dezaemon_sfc_test.ts builds it). */
function fakeRom(title = "DEZAEMON"): Uint8Array {
  const body = new Uint8Array(ROM_BYTES);
  const name = title.padEnd(21, " ");
  for (let i = 0; i < 21; i++) body[HEADER + i] = name.charCodeAt(i);
  body[HEADER + 0x15] = 0x30;
  body[HEADER + 0x16] = 0x02;
  body[HEADER + 0x17] = 0x09;
  body[HEADER + 0x18] = 0x07;
  body[HEADER + 0x1c] = 0x34;
  body[HEADER + 0x1d] = 0x12;
  body[HEADER + 0x1e] = 0xcb;
  body[HEADER + 0x1f] = 0xed;
  return body;
}

const ROM_NAME =
  "Kaite Tsukutte Asoberu - Dezaemon (EN) (1994) (Shoot Em Up) (Super Nintendo)";

async function haveSqlite(): Promise<boolean> {
  try {
    return (await new Deno.Command("sqlite3", { args: ["-version"] }).output())
      .success;
  } catch {
    return false;
  }
}

/** A fixture Application Support folder: the ROM, a slot, two states, the library rows. */
async function fixture(): Promise<ReturnType<typeof openEmuPaths>> {
  const support = await Deno.makeTempDir({ prefix: "openemu-" });
  const paths = openEmuPaths(support);
  await Deno.mkdir(paths.romsDir, { recursive: true });
  await Deno.writeFile(
    join(paths.romsDir, "Super Metroid.sfc"),
    fakeRom("SUPER METROID"),
  );
  await Deno.writeFile(join(paths.romsDir, `${ROM_NAME}.sfc`), fakeRom());
  await Deno.mkdir(paths.batteryDir, { recursive: true });
  await Deno.writeFile(
    join(paths.batteryDir, `${ROM_NAME}.sav`),
    new Uint8Array(0x20000).fill(0xaa),
  );
  const states = join(paths.statesDir, ROM_NAME);
  await Deno.mkdir(join(states, AUTO_STATE_BUNDLE), { recursive: true });
  await Deno.writeTextFile(join(states, AUTO_STATE_BUNDLE, "State"), "auto");
  await Deno.mkdir(join(states, "Save-Game-1.oesavestate"), {
    recursive: true,
  });
  await Deno.writeTextFile(
    join(states, "Save-Game-1.oesavestate", "State"),
    "named",
  );
  if (await haveSqlite()) {
    const loc = (bundle: string) =>
      `SuperNES/${encodeURIComponent(ROM_NAME)}/${encodeURIComponent(bundle)}`;
    const sql =
      `CREATE TABLE ZSAVESTATE (Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZROM INTEGER, ZTIMESTAMP TIMESTAMP, ZCOREIDENTIFIER VARCHAR, ZCOREVERSION VARCHAR, ZLOCATION VARCHAR, ZNAME VARCHAR, ZUSERDESCRIPTION VARCHAR);
INSERT INTO ZSAVESTATE (Z_PK, Z_ENT, ZROM, ZNAME, ZLOCATION) VALUES (415, 11, 765, 'Save-Game-1', '${
        loc("Save-Game-1.oesavestate")
      }');
INSERT INTO ZSAVESTATE (Z_PK, Z_ENT, ZROM, ZNAME, ZLOCATION) VALUES (416, 11, 765, '${AUTO_STATE_NAME}', '${
        loc(AUTO_STATE_BUNDLE)
      }');
INSERT INTO ZSAVESTATE (Z_PK, Z_ENT, ZROM, ZNAME, ZLOCATION) VALUES (423, 11, 800, '${AUTO_STATE_NAME}', 'SuperNES/Other%20Game/${
        encodeURIComponent(AUTO_STATE_BUNDLE)
      }');`;
    await new Deno.Command("sqlite3", { args: [paths.database, sql] }).output();
  }
  return paths;
}

Deno.test("the cart is found by its header, and the slot and states are named after it", async () => {
  const paths = await fixture();
  try {
    const rom = await findOpenEmuRom(paths.romsDir);
    assert(rom, "no cart found");
    assertEquals(rom.name, `${ROM_NAME}.sfc`);
    assertEquals(rom.base, ROM_NAME);
    assertEquals(
      batterySlot(paths.batteryDir, rom),
      join(paths.batteryDir, `${ROM_NAME}.sav`),
    );
    assertEquals(
      statesFolder(paths.statesDir, rom),
      join(paths.statesDir, ROM_NAME),
    );
    // the row OpenEmu's library holds for the auto state, as it stores it
    assertEquals(
      autoStateLocation(rom),
      "SuperNES/Kaite%20Tsukutte%20Asoberu%20-%20Dezaemon%20(EN)%20(1994)%20(Shoot%20Em%20Up)%20(Super%20Nintendo)/Auto%20Save%20State.oesavestate",
    );
    assertEquals(await findOpenEmuRom(join(paths.support, "nowhere")), null);
  } finally {
    await Deno.remove(paths.support, { recursive: true });
  }
});

Deno.test("the slot is backed up, written and read back; a bad image is refused first", async () => {
  const paths = await fixture();
  try {
    const rom = (await findOpenEmuRom(paths.romsDir))!;
    let threw = false;
    try {
      await installOpenEmuSram(new Uint8Array(0x20000), {
        batteryDir: paths.batteryDir,
        rom,
      });
    } catch {
      threw = true;
    }
    assert(threw, "an image without the magic was installed");
    const before = await Deno.readFile(batterySlot(paths.batteryDir, rom));
    const sram = formatSfcSram();
    const r = await installOpenEmuSram(sram, {
      batteryDir: paths.batteryDir,
      rom,
    });
    assert(r.replaced);
    assert(r.backupPath && r.backupPath.includes("/backup/"));
    assertEquals(await Deno.readFile(r.backupPath), before);
    assertEquals(await Deno.readFile(r.slotPath), sram);
  } finally {
    await Deno.remove(paths.support, { recursive: true });
  }
});

Deno.test({
  name: "retiring the auto state moves its bundle and deletes only its row",
  ignore: !(await haveSqlite()),
  async fn() {
    const paths = await fixture();
    try {
      const rom = (await findOpenEmuRom(paths.romsDir))!;
      const r = await retireAutoSaveState({
        statesDir: paths.statesDir,
        batteryDir: paths.batteryDir,
        database: paths.database,
        rom,
      });
      assert(r.movedTo && r.movedTo.endsWith(".oesavestate"));
      assertEquals(await Deno.readTextFile(join(r.movedTo, "State")), "auto");
      assertEquals(r.rowsDeleted, 1);
      assertEquals(r.databaseNote, null);
      // the named state stays, on disk and in the library; the other game's auto state too
      assertEquals(
        await Deno.readTextFile(
          join(
            statesFolder(paths.statesDir, rom),
            "Save-Game-1.oesavestate",
            "State",
          ),
        ),
        "named",
      );
      const left = new TextDecoder().decode(
        (await new Deno.Command("sqlite3", {
          args: [paths.database, "SELECT Z_PK FROM ZSAVESTATE ORDER BY Z_PK;"],
          stdout: "piped",
        }).output()).stdout,
      ).trim().split("\n");
      assertEquals(left, ["415", "423"]);
      // a second retirement finds nothing and says so
      const again = await retireAutoSaveState({
        statesDir: paths.statesDir,
        batteryDir: paths.batteryDir,
        database: paths.database,
        rom,
      });
      assertEquals(again.movedTo, null);
      assertEquals(again.rowsDeleted, 0);
    } finally {
      await Deno.remove(paths.support, { recursive: true });
    }
  },
});
