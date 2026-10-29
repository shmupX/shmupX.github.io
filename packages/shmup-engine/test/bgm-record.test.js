// The level record's dezaemonBgm carries a cart's whole soundtrack: all 24
// slots, the raw BGM table and the SFX set, so import -> cloud -> export is
// the identity and the music maker can open any slot.
import { assert, assertEquals } from "@std/assert";
import { SONG_SIZE, SONG_SLOTS } from "../src/decode/decode-song.js";
import {
  b64ToBytes,
  bankFromBgm,
  bgmFromBank,
  bgmFromSave,
  bgmTableOf,
  bytesToB64,
  emptySong,
  emptySongBank,
  isEmptySong,
  sec6FromBgm,
  shipsAsSong,
} from "../src/audio/bgm-record.js";
import { placeNote, setHeader, setRhythm } from "../src/audio/song-edit.js";
import { buildDezaemonBgm, encodeDezaSong } from "../src/audio/song-write.js";
import { cartSaves, hasCartCorpus, requireCorpus, skipCorpus, slotsOf } from "./_song-corpus.js";
import { SETTINGS_OFFSET } from "./_song-corpus.js";

function sec6Of(slots) {
  const sec6 = emptySongBank();
  slots.forEach((s, i) => {
    if (s) sec6.set(s, i * SONG_SIZE);
  });
  return sec6;
}

/** A JSON round trip, as the cloud stores it. */
const viaCloud = (r) => JSON.parse(JSON.stringify(r));

const melody = placeNote(emptySong(), { part: 0, step: 0, len: 4, pitch: 25, inst: 13 });
const bandOnly = setRhythm(emptySong(), 0, { bank: 3, pattern: 0, chord: 0, key: 3 });
const dirtyBlank = setHeader(emptySong(), { tempoIndex: 20 }); // no notes, not the blank

Deno.test("shipsAsSong: notes or an audible accompaniment ship; the blank and a silent band do not", () => {
  assertEquals(shipsAsSong(melody), true);
  assertEquals(shipsAsSong(bandOnly), true, "bank 3 pattern 0 plays chords and bass");
  assertEquals(shipsAsSong(emptySong()), false);
  assertEquals(shipsAsSong(dirtyBlank), false);
  assertEquals(isEmptySong(emptySong()), true);
  assertEquals(isEmptySong(dirtyBlank), false);
});

Deno.test("bgmFromSave: played slots in songs, every other non-blank slot in bank, the raw table kept", () => {
  const slots = [];
  slots[0] = melody; // title
  slots[4] = bandOnly; // stage 1 main: accompaniment only, now ships
  slots[9] = melody; // unreferenced: bank
  slots[11] = dirtyBlank; // referenced, silent: bank
  const table = [0, 23, 23, 0, 4, 11, 4, 11, 4, 11, 4, 11, 4, 11, 4, 11, 4, 11, 4, 11, 4, 11, 4, 11];
  const sec6 = sec6Of(slots);
  const rec = bgmFromSave({ bgmTable: table, sfxSet: 2 }, sec6, 3);
  assertEquals(rec.special, [0, 23, 23, 0]);
  assertEquals(rec.stages, [[4, 11], [4, 11], [4, 11]]);
  assertEquals(Object.keys(rec.songs).sort(), ["0", "4"]);
  assertEquals(Object.keys(rec.bank).sort(), ["11", "9"]);
  assertEquals(rec.table, table);
  assertEquals(rec.sfxSet, 2);
  const back = viaCloud(rec);
  assertEquals(sec6FromBgm(back), sec6);
  assertEquals(bgmTableOf(back), table);
});

Deno.test("a legacy record writes exactly what the writer always wrote", () => {
  const legacy = buildDezaemonBgm({ songs: [melody, melody, melody] });
  assertEquals(legacy.table, undefined);
  assertEquals(legacy.bank, undefined);
  const sec6 = sec6FromBgm(legacy);
  for (let i = 0; i < SONG_SLOTS; i++) {
    const slot = sec6.subarray(i * SONG_SIZE, (i + 1) * SONG_SIZE);
    assertEquals([...slot], [...(i < 3 ? melody : emptySong())], `slot ${i}`);
  }
  const old = new Array(24).fill(0);
  legacy.special.forEach((v, i) => (old[i] = v));
  legacy.stages.forEach((p, s) => {
    old[4 + 2 * s] = p[0];
    old[5 + 2 * s] = p[1];
  });
  assertEquals(bgmTableOf(legacy), old);
});

Deno.test("special and stages override the raw table only where they differ", () => {
  const table = new Array(24).fill(0).map((_, i) => i);
  const rec = { table, special: [5, 1, 2, 3], stages: [[4, 5]] };
  const out = bgmTableOf(rec);
  assertEquals(out[0], 5);
  assertEquals(out.slice(1), table.slice(1));
});

Deno.test("records read back after RTDB turns slot maps into arrays with holes", () => {
  const rec = bgmFromSave({ bgmTable: new Array(24).fill(2), sfxSet: 1 }, sec6Of([null, null, melody, null, bandOnly]), 1);
  const asArrays = viaCloud(rec);
  asArrays.songs = [null, null, rec.songs[2]];
  asArrays.bank = [null, null, null, null, rec.bank[4]];
  assertEquals(sec6FromBgm(asArrays), sec6FromBgm(rec));
});

Deno.test("bankFromBgm and bgmFromBank are inverses, and the music maker's edits land in the right half", () => {
  const sec6 = sec6Of([melody, null, null, null, bandOnly, null, melody]);
  const table = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23];
  const rec = bgmFromSave({ bgmTable: table, sfxSet: 3 }, sec6, 2);
  const bank = bankFromBgm(viaCloud(rec));
  assertEquals(bank.table, table);
  assertEquals(bank.sfxSet, 3);
  assertEquals(bank.stageCount, 2);
  assertEquals(viaCloud(bgmFromBank(bank, { previous: rec })), viaCloud(rec));
  // Compose into slot 20 and point stage 1's boss at it: it moves to `songs`.
  bank.slots[20] = placeNote(bank.slots[20], { part: 1, step: 0, pitch: 30, inst: 2 });
  bank.table[5] = 20;
  bank.names = { 20: "BOSS RUSH" };
  const edited = bgmFromBank(bank, { previous: rec, edited: 1234 });
  assert("20" in edited.songs);
  assertEquals(edited.stages[0], [4, 20]);
  assertEquals(edited.names, { 20: "BOSS RUSH" });
  assertEquals(edited.edited, 1234);
  assertEquals(sec6FromBgm(edited).subarray(20 * SONG_SIZE, 21 * SONG_SIZE), bank.slots[20]);
});

Deno.test("a sequence keeps only the slots that ship", () => {
  const rec = buildDezaemonBgm({ songs: [melody, encodeDezaSong({}), melody] });
  const bank = bankFromBgm(rec);
  const out = bgmFromBank(bank, { previous: rec });
  assertEquals(out.sequence, [0, 2]);
});

Deno.test("b64 helpers round-trip", () => {
  const bytes = Uint8Array.from({ length: 9000 }, (_, i) => (i * 37) & 255);
  assertEquals(b64ToBytes(bytesToB64(bytes)), bytes);
});

Deno.test({
  name: "every cart: sec6, the BGM table and the SFX set come back from the record byte for byte",
  ignore: skipCorpus(hasCartCorpus()),
  fn() {
    requireCorpus(hasCartCorpus(), "dev-fixtures/Saturn/*.sav");
    let largest = 0;
    let songsShipped = 0;
    let banked = 0;
    for (const cart of cartSaves()) {
      for (const stageCount of [1, 10]) {
        const rec = viaCloud(bgmFromSave({ bgmTable: cart.bgmTable, sfxSet: cart.sfxSet }, cart.sec6, stageCount));
        const sec6 = sec6FromBgm(rec);
        const at = sec6.findIndex((v, k) => v !== cart.sec6[k]);
        assertEquals(at, -1, `${cart.file}#${cart.entry} (${stageCount} stages): sec6 differs at ${at}`);
        const raw = [...cart.sec5.subarray(SETTINGS_OFFSET + 0x41, SETTINGS_OFFSET + 0x59)];
        assertEquals(bgmTableOf(rec), raw, `${cart.file}: BGM table`);
        assertEquals(rec.sfxSet, cart.sec5[SETTINGS_OFFSET + 0x59], `${cart.file}: SFX set`);
        if (stageCount === 10) {
          largest = Math.max(largest, JSON.stringify(rec).length);
          songsShipped += Object.keys(rec.songs).length;
          banked += Object.keys(rec.bank).length;
        }
      }
      // The bank view over the same record is the cart's slots.
      const bank = bankFromBgm(bgmFromSave(cart, cart.sec6, 10));
      assertEquals(bank.slots.map((s) => s.join()), slotsOf(cart.sec6).map((s) => s.join()), cart.file);
    }
    console.log(
      `${cartSaves().length} carts: ${songsShipped} slots in songs, ${banked} in bank; largest record ${largest} chars`,
    );
  },
});
