// The PS2 tone-bank pack, end to end: SNDPAC.BIN in, audsrv ADPCM out.
//
// Gated on a local sound bank (a Dezaemon 2 disc image or SNDPAC.BIN in
// dev-fixtures/) because the bank is disc content — see lib/ps2/tone-bank-pack.ts.

import { assert, assertEquals } from "@std/assert";
import { dirname, fromFileUrl, resolve } from "@std/path";
import {
  buildToneBankPack,
  findSndpac,
  TONE_BANK_DIR,
} from "../lib/ps2/tone-bank-pack.ts";
import { ADPCM_BLOCK_SAMPLES } from "../lib/ps2/adpcm.ts";

const ROOT = resolve(dirname(fromFileUrl(import.meta.url)), "..");
const bank = await findSndpac(ROOT, null);
const gated = { ignore: bank === null };
if (!bank) {
  console.log(
    "  (tone bank pack: skipped — no SNDPAC.BIN or disc image in dev-fixtures/)",
  );
}

// The SPU2 decoder, so the pack is judged by what a console would hear.
const DEC_F: [number, number][] = [
  [0, 0],
  [60, 0],
  [115, -52],
  [98, -55],
  [122, -60],
];

function decodeAdp(adp: Uint8Array): Int16Array {
  const n = new DataView(adp.buffer, adp.byteOffset).getUint32(12, true);
  const out = new Int16Array(n);
  let s1 = 0;
  let s2 = 0;
  let at = 0;
  for (let b = 16; b + 16 <= adp.length && at < n; b += 16) {
    const shift = adp[b] & 0x0f;
    const [f0, f1] = DEC_F[Math.min((adp[b] >> 4) & 0x0f, 4)];
    for (let i = 0; i < ADPCM_BLOCK_SAMPLES && at < n; i++) {
      const byte = adp[b + 2 + (i >> 1)];
      const s = (((i & 1 ? byte >> 4 : byte & 0x0f) << 12) << 16) >> 16;
      const v = Math.min(
        32767,
        Math.max(-32768, (s >> shift) + ((s1 * f0 + s2 * f1) >> 6)),
      );
      out[at++] = v;
      s2 = s1;
      s1 = v;
    }
  }
  return out;
}

const pack = bank ? buildToneBankPack(bank.bytes) : null;

function index() {
  const file = pack!.files.find((f) => f.path.endsWith("tonebank.json"))!;
  return JSON.parse(new TextDecoder().decode(file.data));
}

Deno.test(
  "the pack renders one .adp per distinct cut plus an index",
  gated,
  () => {
    const adp = pack!.files.filter((f) => f.path.endsWith(".adp"));
    assertEquals(adp.length, 85);
    assertEquals(pack!.wavFiles.length, 85);
    assertEquals(pack!.files.length, 86);
    for (const file of pack!.files) {
      assert(file.path.startsWith(`${TONE_BANK_DIR}/`), file.path);
    }
    // Names must survive the ISO writer's mangling unchanged.
    for (const file of adp) {
      const base = file.path.split("/").pop()!;
      assertEquals(base, base.toUpperCase().toLowerCase());
      assert(/^tb\d\d\.adp$/.test(base), base);
    }
  },
);

Deno.test(
  "every one of the 590 layers resolves to a rendered cut",
  gated,
  () => {
    const json = index();
    assertEquals(json.instruments.length, 116);
    let layers = 0;
    for (const inst of json.instruments) {
      for (const layer of inst.layers) {
        layers++;
        assert(json.slices[layer.slice], `layer ${layers} points at nothing`);
        assert(layer.rootPitch >= 0 && layer.rootPitch <= 127);
        assert(layer.noteLo <= layer.noteHi);
      }
    }
    assertEquals(layers, 590);
  },
);

Deno.test("looping cuts are block-aligned and flagged", gated, () => {
  const json = index();
  let looping = 0;
  for (const slice of json.slices) {
    if (!slice.loop) continue;
    looping++;
    assertEquals(
      slice.loopStart % ADPCM_BLOCK_SAMPLES,
      0,
      `${slice.file} loop start is off a block boundary`,
    );
    assertEquals(
      (slice.samples - slice.loopStart) % ADPCM_BLOCK_SAMPLES,
      0,
      `${slice.file} loop length is not a whole number of blocks`,
    );
    const adp = pack!.files.find((f) =>
      f.path.endsWith(`/${slice.file}`)
    )!.data;
    assertEquals(adp[6], 1, `${slice.file} header loop flag`);
    const loopBlock = slice.loopStart / ADPCM_BLOCK_SAMPLES;
    const lastBlock = Math.ceil(slice.samples / ADPCM_BLOCK_SAMPLES) - 1;
    assertEquals(
      adp[16 + loopBlock * 16 + 1] & 4,
      4,
      `${slice.file} loop start`,
    );
    assertEquals(adp[16 + lastBlock * 16 + 1] & 3, 3, `${slice.file} loop end`);
  }
  assertEquals(looping, 83);
});

Deno.test("the ADPCM matches its PCM twin", gated, () => {
  let worst = Infinity;
  let worstFile = "";
  for (const file of pack!.files) {
    if (!file.path.endsWith(".adp")) continue;
    const wav = pack!.wavFiles.find((w) =>
      w.path === file.path.replace(".adp", ".wav")
    )!
      .data;
    const view = new DataView(wav.buffer, wav.byteOffset);
    const n = (wav.length - 44) / 2;
    const pcm = new Int16Array(n);
    for (let i = 0; i < n; i++) pcm[i] = view.getInt16(44 + i * 2, true);
    const decoded = decodeAdp(file.data);
    assertEquals(decoded.length, n, file.path);
    let err = 0;
    let signal = 0;
    for (let i = 0; i < n; i++) {
      const d = decoded[i] - pcm[i];
      err += d * d;
      signal += pcm[i] * pcm[i];
    }
    const snr = 10 * Math.log10(signal / (err || 1e-9));
    if (snr < worst) {
      worst = snr;
      worstFile = file.path;
    }
  }
  // 4-bit ADPCM on loud, dense percussion is the floor here; the headroom fit
  // in fitToHeadroom() is what keeps it from falling to single digits.
  assert(worst > 15, `${worstFile} decoded at only ${worst.toFixed(1)} dB SNR`);
});
