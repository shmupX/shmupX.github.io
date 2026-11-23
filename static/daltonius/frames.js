// Every frame the Computer Precinct draws, each one art/<name>.png.
//
// Daltonius's poses are his record's own (scripts/gs/draw_daltonius.py), the
// die_* frames are his death scene from the same script, and the rest are cut
// from gs's atlas: the tag (bby-ship), its beam and barrier, and his RAM and
// laptop bullets. tests/daltonius_precinct_test.ts checks each is on disk.

export const DALTONIUS_FRAMES = [
  "idle0", "idle1",
  "shootA0", "shootA1", "shootA2",
  "shootB0", "shootB1", "shootB2", "shootB3", "shootB4",
  "syungoku0", "syungoku1", "syungoku2", "syungoku_finish", "syungoku_finish_ten",
  "fired0", "fired1", "fired2",
  "die_bulge0", "die_bulge1", "die_bulge2",
  "die_froth0", "die_froth1", "die_froth2",
  "die_toot0", "die_toot1", "die_toot2", "die_toot3",
  "die_flat",
].map((n) => `Daltonius_${n}`);

export const GS_FRAMES = ["bby-ship", "beam0", "beam1", "barrier0", "RAM_0", "laptop0", "laptop1"];

export const FRAMES = [...DALTONIUS_FRAMES, ...GS_FRAMES];
