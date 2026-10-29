// Finding SNDPAC.BIN, and cutting it into something a browser can play.
//
// SNDPAC.BIN is the Dezaemon 2 disc's sample bank: 505,774 bytes holding every
// timbre the Saturn's SCSP played. The raw file is disc content and stays out
// of the repo; it is looked for in dev-fixtures/, which is gitignored — drop a
// Dezaemon 2 disc image in there and the ISO 9660 reader pulls the file out
// (lib/disc-file.ts, the scan shared with the part library). The instrument
// map that indexes it is committed (packages/shmup-engine/data/bgm-instruments.json).
//
// The CUT bank is published (decision 2026-10-28): buildWebToneBank() below
// renders it for the browser (raw PCM plus an index), and
// `deno task deza:tonebank --web` writes that into
// static/games/2028-ai/assets/tone-bank/, committed and served with the game,
// which the runtime and the editor's MUSIC play everywhere. On Steam it ships
// only in the members' Dezaemon 2 disc pack (lib/member-content.ts), like the
// ポリ吉 part library. Without it, the runtime falls back to the analysed
// periodic-wave voices.
//
// lib/ps2/tone-bank-pack.ts renders the bank for the console (audsrv ADPCM);
// the cutting and loop-baking happen once, in the engine, for both.

import { join } from "@std/path";
import { findDiscFile } from "./disc-file.ts";
import {
  cutLayer,
  INSTRUMENT_COUNT,
  instrumentAt,
  layerAt,
  SCSP_BASE_RATE,
  uniqueSlices,
} from "@shmupx/shmup-engine/tone-bank";
export interface SndpacSource {
  bytes: Uint8Array;
  /** Human-readable provenance for the build log. */
  from: string;
}

/**
 * Locate SNDPAC.BIN. In order: an explicit path, the extraction cache, a bare
 * copy in dev-fixtures/, then every disc image in dev-fixtures/. Returns null
 * when there is nothing to find — never throws, because a checkout without the
 * disc is the normal case.
 */
export async function findSndpac(
  root: string,
  explicit?: string | null,
): Promise<SndpacSource | null> {
  // The scan itself lives in lib/disc-file.ts, shared with the part library.
  return await findDiscFile(root, "SNDPAC.BIN", {
    explicit,
    flag: "--sndpac",
  });
}

/** Cache an extracted bank so later builds skip the disc scan. */
export async function cacheSndpac(root: string, bytes: Uint8Array) {
  const dir = join(root, "dev-fixtures", ".cache");
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeFile(join(dir, "SNDPAC.BIN"), bytes);
}

/**
 * The whole bank cut for Web Audio: one PCM blob (Int16 little-endian, every
 * distinct slice concatenated) and the index that says where each instrument
 * layer's samples start and how it loops.
 *
 * Loop points here are exact — Web Audio loops on a sample, unlike the SPU2's
 * 28-sample ADPCM blocks — so this is the reference rendering and the PS2 pack
 * is the one that has to compromise.
 */
export function buildWebToneBank(
  sndpac: Uint8Array,
): { index: WebToneBank; pcm: Uint8Array } {
  const cuts = [];
  let samples = 0;
  for (const slice of uniqueSlices()) {
    const cut = cutLayer(sndpac, layerAt(slice.layerIndexes[0]));
    if (!cut) continue;
    cuts.push({ slice, cut, at: samples });
    samples += cut.pcm.length;
  }

  const pcm = new Uint8Array(samples * 2);
  const view = new DataView(pcm.buffer);
  const sliceOfLayer = new Map<number, number>();
  const slices = cuts.map(({ slice, cut, at }, i) => {
    for (let s = 0; s < cut.pcm.length; s++) {
      view.setInt16((at + s) * 2, cut.pcm[s], true);
    }
    for (const layerIndex of slice.layerIndexes) {
      sliceOfLayer.set(layerIndex, i);
    }
    return {
      at,
      samples: cut.pcm.length,
      loop: cut.loop,
      loopStart: cut.loopStart,
    };
  });

  const instruments = [];
  for (let i = 0; i < INSTRUMENT_COUNT; i++) {
    const inst = instrumentAt(i)!;
    const layers = [];
    for (let k = 0; k < inst.layerCount; k++) {
      const layerIndex = inst.firstLayer + k;
      const slice = sliceOfLayer.get(layerIndex);
      if (slice === undefined) continue;
      const l = layerAt(layerIndex)!;
      layers.push({
        slice,
        noteLo: l.noteLo,
        noteHi: l.noteHi,
        rootPitch: l.rootPitch,
        fineTune: l.fineTune,
        level: l.level,
        pan: l.pan,
      });
    }
    instruments.push({ layers });
  }

  return {
    index: { sampleRate: SCSP_BASE_RATE, slices, instruments },
    pcm,
  };
}

export interface WebToneBank {
  sampleRate: number;
  slices: {
    at: number;
    samples: number;
    loop: boolean;
    loopStart: number;
  }[];
  instruments: {
    layers: {
      slice: number;
      noteLo: number;
      noteHi: number;
      rootPitch: number;
      fineTune: number;
      level: number;
      pan: number;
    }[];
  }[];
}

/** Where the published web bank lives, relative to the repo root. */
export const WEB_TONE_BANK_DIR = "static/games/2028-ai/assets/tone-bank";

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>),
  );
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The two published files, exactly as written: tone-bank.json (the index with
 * a header saying what it is and what it was cut from) and tone-bank.pcm.
 * Deterministic — the same SNDPAC.BIN gives the same bytes.
 */
export async function webToneBankFiles(
  sndpac: Uint8Array,
): Promise<{ index: WebToneBank; json: string; pcm: Uint8Array }> {
  const { index, pcm } = buildWebToneBank(sndpac);
  const header = {
    format: "deza-web-tone-bank",
    version: 1,
    pcmBytes: pcm.length,
    pcmSha256: await sha256(pcm),
    sndpacSha256: await sha256(sndpac),
  };
  const json = JSON.stringify({ ...header, ...index }) + "\n";
  return { index, json, pcm };
}
