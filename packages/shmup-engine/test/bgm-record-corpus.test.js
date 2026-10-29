// A cart's music survives the whole trip the editor puts it through:
// decodeSave -> mapSaveToGame (dezaemonBgm) -> the cloud (JSON) ->
// buildSaveFromGame, with sec6, the 24-entry BGM table and the SFX set byte
// for byte. Before the record carried `bank` and `table`, an import kept only
// the slots the table named and an export refilled the rest with the blank.
// (bgm-record.test.js holds the record itself equal over every cart; this is
// the full pipeline on three of them, since an export builds the whole game.)
//
// Gated on the community carts in dev-fixtures/Saturn/.

import { assertEquals } from "@std/assert";
import { decodeSave } from "../src/decode/index.js";
import { mapSaveToGame } from "../src/map-to-game.js";
import { buildSaveFromGame } from "../src/write/game-to-save.js";
import { deinterleave } from "../src/bup-deinterleave.js";
import * as bup from "../src/bup-parse.js";
import { isGameSave } from "../src/payload-table.js";
import { requireCorpus, SETTINGS_OFFSET, skipCorpus } from "./_song-corpus.js";

const SATURN = new URL("../../../dev-fixtures/Saturn/", import.meta.url);
const CARTS = ["Dez 2 - Ramsie.sav", "Dez 2 - Biometal Gust.sav", "Dezaemon 2 (DAIOH).sav"];

function readCart(name) {
  try {
    return Deno.readFileSync(new URL(encodeURIComponent(name), SATURN));
  } catch {
    return null;
  }
}

for (const name of CARTS) {
  const bytes = readCart(name);
  Deno.test({
    name: `${name}: import, cloud and export keep sec6, the BGM table and the SFX set byte for byte`,
    ignore: skipCorpus(bytes !== null),
    fn() {
      requireCorpus(bytes !== null, name);
      const [save] = bup.parse(deinterleave(bytes)).filter(isGameSave);
      const decoded = decodeSave(save.payload.buffer);
      const { gameJson } = mapSaveToGame(decoded, {});
      const level = JSON.parse(JSON.stringify(gameJson));
      // No atlas: the art falls back to placeholders, which is all the
      // music needs.
      const { sections } = buildSaveFromGame(level, {});
      const sec6 = decoded.sections[6].decompressed;
      assertEquals(sections[6].findIndex((v, k) => v !== sec6[k]), -1, "sec6");
      const sec5 = decoded.sections[5].decompressed;
      assertEquals(
        [...sections[5].subarray(SETTINGS_OFFSET + 0x41, SETTINGS_OFFSET + 0x5a)],
        [...sec5.subarray(SETTINGS_OFFSET + 0x41, SETTINGS_OFFSET + 0x5a)],
        "BGM table and SFX set",
      );
    },
  });
}
