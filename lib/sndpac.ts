// Finding SNDPAC.BIN, and cutting it into something a browser can play.
//
// SNDPAC.BIN is the Dezaemon 2 disc's sample bank: 505,774 bytes holding every
// timbre the Saturn's SCSP played. It is disc content, so it is not in this
// repo and never will be. What IS here is the instrument map that indexes it
// (packages/shmup-engine/data/bgm-instruments.json), so anyone holding a disc
// can have the real samples and everyone else falls back to the synthesised
// voices the runtime has always used.
//
// The bank is looked for in dev-fixtures/, which is gitignored: drop a
// Dezaemon 2 disc image in there and the ISO 9660 reader pulls the file out.
//
// lib/ps2/tone-bank-pack.ts renders this for the console (audsrv ADPCM);
// buildWebToneBank() below renders it for the browser (raw PCM plus an index),
// so the cutting and loop-baking happen once, in the engine, for both.

import { basename, join } from "@std/path";
import {
  cutLayer,
  INSTRUMENT_COUNT,
  instrumentAt,
  layerAt,
  SCSP_BASE_RATE,
  uniqueSlices,
} from "../packages/shmup-engine/src/audio/tone-bank.js";
import {
  openDisc,
  readFile,
} from "../packages/shmup-engine/src/cd/iso9660-read.js";

/** Extensions worth opening as a disc image when scanning dev-fixtures/. */
const DISC_EXTENSIONS = [".bin", ".iso", ".img"];

export interface SndpacSource {
  bytes: Uint8Array;
  /** Human-readable provenance for the build log. */
  from: string;
}

async function readIfPresent(path: string): Promise<Uint8Array | null> {
  try {
    return await Deno.readFile(path);
  } catch {
    return null;
  }
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
  if (explicit) {
    const bytes = await readIfPresent(explicit);
    if (!bytes) throw new Error(`--sndpac: cannot read ${explicit}`);
    return { bytes, from: explicit };
  }

  const fixtures = join(root, "dev-fixtures");
  const cache = join(fixtures, ".cache", "SNDPAC.BIN");
  const cached = await readIfPresent(cache);
  if (cached) return { bytes: cached, from: cache };

  const bare = await readIfPresent(join(fixtures, "SNDPAC.BIN"));
  if (bare) return { bytes: bare, from: join(fixtures, "SNDPAC.BIN") };

  let entries: Deno.DirEntry[];
  try {
    entries = [...Deno.readDirSync(fixtures)];
  } catch {
    return null;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile) continue;
    const lower = entry.name.toLowerCase();
    if (!DISC_EXTENSIONS.some((ext) => lower.endsWith(ext))) continue;
    const path = join(fixtures, entry.name);
    const image = await readIfPresent(path);
    if (!image) continue;
    const disc = openDisc(image);
    if (!disc) continue;
    const found = readFile(disc, "SNDPAC.BIN");
    if (found) return { bytes: found, from: `${basename(path)} (ISO 9660)` };
  }
  return null;
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
