// Builders for synthetic ISO 9660 data tracks, cooked (2048-byte sectors) or
// raw MODE1/2352, and for a small Dezaemon-2-shaped one. The retail disc is
// community content and never ships with the repo, so the writer's structural
// tests run on these; the disc-gated tests run on the real track when a
// checkout has one in dev-fixtures/.
//
// The layout is a master's in miniature: system area, the primary volume
// descriptor at LBA 16, the terminator, an L and an M path table, the root
// directory, then the files back to back from FIRST_FILE_LBA (each with as many
// slack sectors after it as asked), then an empty postgap.

import {
  buildMode1Sector,
  SECTOR_SIZE,
  USER_SIZE,
} from "../src/cd/cd-sector.js";
import { compressCmp } from "../src/compress.js";
import { SECTION_SIZES } from "../src/decompress.js";

export const ROOT_LBA = 20;
export const FIRST_FILE_LBA = 21;

const both32 = (b, at, v) => {
  b[at] = v & 0xff;
  b[at + 1] = (v >>> 8) & 0xff;
  b[at + 2] = (v >>> 16) & 0xff;
  b[at + 3] = v >>> 24;
  b[at + 4] = v >>> 24;
  b[at + 5] = (v >>> 16) & 0xff;
  b[at + 6] = (v >>> 8) & 0xff;
  b[at + 7] = v & 0xff;
};
const both16 = (b, at, v) => {
  b[at] = v & 0xff;
  b[at + 1] = v >>> 8;
  b[at + 2] = v >>> 8;
  b[at + 3] = v & 0xff;
};

function record(name, extent, size, isDir) {
  const nameBytes = typeof name === "string"
    ? new TextEncoder().encode(name)
    : name;
  const length = 33 + nameBytes.length + (nameBytes.length % 2 === 0 ? 1 : 0);
  const r = new Uint8Array(length);
  r[0] = length;
  both32(r, 2, extent);
  both32(r, 10, size);
  r.set([97, 8, 20, 12, 0, 0, 36], 18); // 1997-08-20 12:00:00 +9h
  r[25] = isDir ? 0x02 : 0x00;
  both16(r, 28, 1);
  r[32] = nameBytes.length;
  r.set(nameBytes, 33);
  return r;
}

/**
 * A data track holding `files` ([{name, data, slack = 0}], in disc order).
 * Returns {image, sectors, layout: [{name, extent, size, sectors}]}. `raw`
 * (default) writes MODE1/2352 sectors with real EDC/ECC; false writes 2048.
 */
export function buildVolume(files, { raw = true, postgap = 4 } = {}) {
  const layout = [];
  let lba = FIRST_FILE_LBA;
  for (const f of files) {
    const sectors = Math.max(1, Math.ceil(f.data.length / USER_SIZE));
    layout.push({
      name: f.name,
      extent: lba,
      size: f.data.length,
      sectors,
      data: f.data,
    });
    lba += sectors + (f.slack ?? 0);
  }
  const count = lba + postgap;
  const user = Array.from({ length: count }, () => new Uint8Array(USER_SIZE));

  const pvd = user[16];
  pvd[0] = 1;
  pvd.set(new TextEncoder().encode("CD001"), 1);
  pvd[6] = 1;
  pvd.set(new TextEncoder().encode("SYNTHETIC".padEnd(32)), 40);
  both32(pvd, 80, count);
  both16(pvd, 120, 1);
  both16(pvd, 124, 1);
  both16(pvd, 128, USER_SIZE);
  both32(pvd, 132, 10);
  pvd.set([18, 0, 0, 0], 140); // type L path table, LE
  pvd.set([0, 0, 0, 19], 148); // type M path table, BE
  pvd.set(record(new Uint8Array([0]), ROOT_LBA, USER_SIZE, true), 156);
  const term = user[17];
  term[0] = 255;
  term.set(new TextEncoder().encode("CD001"), 1);
  term[6] = 1;
  user[18].set([1, 0, ROOT_LBA, 0, 0, 0, 1, 0, 0, 0]);
  user[19].set([1, 0, 0, 0, 0, ROOT_LBA, 0, 1, 0, 0]);

  const root = user[ROOT_LBA];
  let at = 0;
  for (
    const r of [
      record(new Uint8Array([0]), ROOT_LBA, USER_SIZE, true),
      record(new Uint8Array([1]), ROOT_LBA, USER_SIZE, true),
    ]
  ) {
    root.set(r, at);
    at += r.length;
  }
  for (const f of layout) {
    const r = record(`${f.name};1`, f.extent, f.size, false);
    if (at + r.length > USER_SIZE) {
      throw new Error("synthetic root directory is one sector");
    }
    root.set(r, at);
    at += r.length;
    for (let i = 0; i < f.sectors; i++) {
      user[f.extent + i].set(
        f.data.subarray(i * USER_SIZE, (i + 1) * USER_SIZE),
      );
    }
  }

  const sectorSize = raw ? SECTOR_SIZE : USER_SIZE;
  const image = new Uint8Array(count * sectorSize);
  user.forEach((u, i) => {
    if (raw) {
      buildMode1Sector(
        i,
        u,
        image.subarray(i * SECTOR_SIZE, (i + 1) * SECTOR_SIZE),
      );
    } else image.set(u, i * USER_SIZE);
  });
  return {
    image,
    sectors: count,
    layout: layout.map(({ data: _, ...l }) => l),
  };
}

/** Deterministic filler bytes. */
export function pattern(length, seed = 1) {
  const out = new Uint8Array(length);
  let s = seed >>> 0;
  for (let i = 0; i < length; i++) {
    s = (s * 1103515245 + 12345) >>> 0;
    out[i] = (s >>> 16) & 0xff;
  }
  return out;
}

/** A stand-in for the retail D2MENU overlay: its size, and the stock words of
 * the cold-path flag clear at +0x281A that disc-inject.js patches. */
export function stockMenuOverlay() {
  const raw = pattern(33568, 7);
  const stock = [0xe200, 0x2320, 0x6133, 0x7101, 0x2120, 0x7302, 0x2320];
  stock.forEach((w, i) => {
    raw[0x281a + 2 * i] = w >> 8;
    raw[0x281a + 2 * i + 1] = w & 0xff;
  });
  return raw;
}

/** Eight sections of the right sizes, sec0..sec7, filled from `seed`. Mostly
 * zero, the way a real game is, so they compress to a realistic size. */
export function syntheticSections(seed = 3) {
  return SECTION_SIZES.map((size, i) => {
    const s = new Uint8Array(size);
    s.set(pattern(Math.min(size, 4096), seed * 16 + i));
    return s;
  });
}

/**
 * A Dezaemon-2-shaped track: the files disc-inject.js and the launcher's disc
 * detector look for, with SGM_INIT.CMP holding `boot` (eight sections) and
 * `bootSlack` empty sectors after it, and D2MENU.CMP holding `menu` (the
 * decompressed overlay; the stock stand-in by default).
 */
export function dezaemonVolume(
  {
    boot = syntheticSections(1),
    bootSlack = 4,
    raw = true,
    menu = stockMenuOverlay(),
  } = {},
) {
  const image = new Uint8Array(SECTION_SIZES.reduce((a, b) => a + b, 0));
  let at = 0;
  for (const i of [0, 1, 2, 3, 5, 4, 6, 7]) {
    image.set(boot[i], at);
    at += boot[i].length;
  }
  return buildVolume([
    { name: "0KERNEL.BIN", data: pattern(5000, 11) },
    { name: "DEZA2.PAL", data: pattern(576, 12) },
    { name: "D2MENU.CMP", data: compressCmp(menu), slack: 1 },
    { name: "SGM_INIT.CMP", data: compressCmp(image), slack: bootSlack },
    { name: "GAME.CMP", data: compressCmp(pattern(9000, 13)) },
  ], { raw });
}
