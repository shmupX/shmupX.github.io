// Compose a 256x480 title-screen cover from decodeSave() output.
// Pure data -> RGBA. No browser, no canvas API, no game engine, no network.
//
// Canvas is the runtime's own portrait viewport (game.bundle.js
// GAME_DIMENSIONS = {WIDTH:256, HEIGHT:480, CENTER_X:128}). The background
// map is 14 cols x 16px tiles centred at x=16, with map row 0 on the BOTTOM
// screen row (buildStageBackground: dy = (rowCount-1-r)*TILE).
//
// The title itself is NOT taken from decodeSave().titleArt/sprites: those are
// trimmed to each slot's own bounding box, which throws away how the author
// placed art inside the 8-cell-wide TITLE page. Instead refs 144..231 of the
// global sprite bank are rendered as ONE 8x11 cell block (128x176 px) — the
// KUMITATE TITLE page exactly as drawn (TITLE 1 = rows 0-2, TITLE 2 = rows
// 3-7, the three credit strips = rows 8-10).

import { renderFrame } from "../../packages/shmup-engine/src/decode/decode-sprites.js";
import { SEC5_REGIONS } from "../../packages/shmup-engine/src/decode/decode-stage.js";

export const COVER_W = 256;
export const COVER_H = 480;
export const TILE = 16;
export const BG_X = 16; // floor((256 - 14*16) / 2)
export const BG_SCREEN_ROWS = COVER_H / TILE; // 30
export const TITLE_FIRST_REF = 144;
export const TITLE_BLOCK = { first: 144, w: 8, h: 11 }; // 128x176 px
export const TITLE_SCALE = 2; // 128*2 == COVER_W exactly
export const TITLE_Y = 40; // top of the 2x block; occupies y 40..392
export const BACKDROP_DIM = 0.45;
export const DARK_INK_LUMA = 40; // luma below this counts as "dark"
export const DARK_INK_MAX = 0.65; // plate when more of the logo than this is dark
export const PLATE_RGB = [176, 176, 176];

// ---------------------------------------------------------------- canvas ---

export function makeCanvas(w, h, rgb = [0, 0, 0]) {
  const px = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    px[i * 4] = rgb[0];
    px[i * 4 + 1] = rgb[1];
    px[i * 4 + 2] = rgb[2];
    px[i * 4 + 3] = 255;
  }
  return px;
}

// src-over composite, nearest-neighbour integer upscale, optional H/V flip.
export function blit(dst, dw, dh, src, sw, sh, dx, dy, opts = {}) {
  const { scale = 1, hflip = false, vflip = false } = opts;
  for (let y = 0; y < sh * scale; y++) {
    const ty = dy + y;
    if (ty < 0 || ty >= dh) continue;
    let sy = (y / scale) | 0;
    if (vflip) sy = sh - 1 - sy;
    for (let x = 0; x < sw * scale; x++) {
      const tx = dx + x;
      if (tx < 0 || tx >= dw) continue;
      let sx = (x / scale) | 0;
      if (hflip) sx = sw - 1 - sx;
      const so = (sy * sw + sx) * 4;
      const a = src[so + 3];
      if (!a) continue;
      const to = (ty * dw + tx) * 4;
      if (a === 255) {
        dst[to] = src[so];
        dst[to + 1] = src[so + 1];
        dst[to + 2] = src[so + 2];
        dst[to + 3] = 255;
      } else {
        const ia = 255 - a;
        dst[to] = (src[so] * a + dst[to] * ia) / 255;
        dst[to + 1] = (src[so + 1] * a + dst[to + 1] * ia) / 255;
        dst[to + 2] = (src[so + 2] * a + dst[to + 2] * ia) / 255;
        dst[to + 3] = Math.max(dst[to + 3], a);
      }
    }
  }
}

function dim(px, f) {
  for (let i = 0; i < px.length; i += 4) {
    px[i] *= f;
    px[i + 1] *= f;
    px[i + 2] *= f;
  }
}

// ------------------------------------------------------------ title page ---

// Read `w x h` cells of the GLOBAL sprite bank starting at ref `first`.
// Word bits: 0-9 = CG cell, bit14 = H-flip, bit15 = V-flip, 0xFFFF = empty.
// (Sprite-bank bit order — the OPPOSITE of the background tilemap's.)
export function readBankBlock(sec5, first, w, h) {
  const { offset } = SEC5_REGIONS.spriteBank;
  const cells = [];
  for (let i = 0; i < w * h; i++) {
    const at = offset + (first + i) * 2;
    const word = (sec5[at] << 8) | sec5[at + 1];
    cells.push({
      empty: word === 0xffff,
      cell: word & 0x3ff,
      hflip: (word & 0x4000) !== 0,
      vflip: (word & 0x8000) !== 0,
    });
  }
  return { w, h, cells };
}

// decoded -> {w:128, h:176, rgba} or null when the CG/sec5 layers are missing.
export function renderTitlePage(decoded, block = TITLE_BLOCK) {
  const sec5 = decoded.sections?.[5]?.decompressed;
  const pages = decoded.sections?.slice(0, 4).map((s) => s.decompressed);
  const palettes = decoded.cg?.palettes;
  if (!sec5 || !palettes || !pages || pages.some((p) => !p)) return null;
  return renderFrame(
    pages,
    palettes,
    readBankBlock(sec5, block.first, block.w, block.h),
  );
}

// Opaque bbox + mean luma of the opaque pixels. null when fully transparent.
export function imgInk(img) {
  let minX = img.w, minY = img.h, maxX = -1, maxY = -1, n = 0, luma = 0;
  for (let y = 0; y < img.h; y++) {
    for (let x = 0; x < img.w; x++) {
      const o = (y * img.w + x) * 4;
      if (!img.rgba[o + 3]) continue;
      n++;
      luma += 0.299 * img.rgba[o] + 0.587 * img.rgba[o + 1] +
        0.114 * img.rgba[o + 2];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (!n) return null;
  return { minX, minY, maxX, maxY, opaque: n, meanLuma: luma / n };
}

// -------------------------------------------------------------- backdrop ---

// Busiest 30-row window (one screenful) over every stage. Deterministic:
// highest tile count, ties -> lowest stage then lowest row. Not just rows
// 0..29: plenty of stages open on empty sky ("Bound" stage 0 does).
export function pickBackdrop(bgStages) {
  let best = { stage: -1, row: 0, tiles: 0 };
  for (let s = 0; s < bgStages.length; s++) {
    const g = bgStages[s];
    if (!g) continue;
    const perRow = new Int32Array(g.rows);
    for (let r = 0; r < g.rows; r++) {
      let n = 0;
      for (let c = 0; c < g.cols; c++) {
        if (g.words[r * g.cols + c] !== 0xffff) n++;
      }
      perRow[r] = n;
    }
    const win = Math.min(BG_SCREEN_ROWS, g.rows);
    let sum = 0;
    for (let r = 0; r < win; r++) sum += perRow[r];
    let bestRow = 0, bestSum = sum;
    for (let r0 = 1; r0 + win <= g.rows; r0++) {
      sum += perRow[r0 + win - 1] - perRow[r0 - 1];
      if (sum > bestSum) {
        bestSum = sum;
        bestRow = r0;
      }
    }
    if (bestSum > best.tiles) best = { stage: s, row: bestRow, tiles: bestSum };
  }
  return best;
}

// One screenful starting at map row `row0`, runtime row order (map row N at
// canvas y = (29 - (N - row0)) * 16). Background word bits: bit15 = H-flip,
// bit14 = V-flip, bits 0-9 = ordinal into decoded.bgCells.
export function drawBackdrop(canvas, decoded, stageIdx, row0 = 0) {
  const g = decoded.bgStages[stageIdx];
  if (!g) return 0;
  let drawn = 0;
  const rows = Math.min(BG_SCREEN_ROWS, g.rows - row0);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < g.cols; c++) {
      const word = g.words[(row0 + r) * g.cols + c];
      if (word === 0xffff) continue;
      const cell = decoded.bgCells[word & 0x3ff];
      if (!cell) continue;
      blit(
        canvas,
        COVER_W,
        COVER_H,
        cell.rgba,
        cell.w,
        cell.h,
        BG_X + c * TILE,
        (BG_SCREEN_ROWS - 1 - r) * TILE,
        { hflip: (word & 0x8000) !== 0, vflip: (word & 0x4000) !== 0 },
      );
      drawn++;
    }
  }
  return drawn;
}

// -------------------------------------------------------------- fallback ---

function bestBossSprite(decoded) {
  let best = null, area = 0;
  for (const b of decoded.bosses || []) {
    const k = (b.spriteKeys || [])[0];
    const s = k === undefined ? null : decoded.sprites[k];
    if (s && s.w * s.h > area) {
      area = s.w * s.h;
      best = s;
    }
  }
  return best;
}

function enemyStrip(decoded, max = 12) {
  const seen = new Set(), out = [];
  for (const e of decoded.enemies || []) {
    const k = (e.spriteKeys || [])[0];
    if (k === undefined || seen.has(k)) continue;
    const s = decoded.sprites[k];
    if (!s) continue;
    seen.add(k);
    out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

// ------------------------------------------------------------- composite ---

export function composeCover(decoded, opts = {}) {
  const {
    dimFactor = BACKDROP_DIM,
    titleScale = TITLE_SCALE,
    titleY = TITLE_Y,
    upscale = 1,
    backdrop = true,
  } = opts;
  let canvas = makeCanvas(COVER_W, COVER_H);
  const layers = [];

  // layer 0 — stage backdrop
  const pick = backdrop
    ? pickBackdrop(decoded.bgStages || [])
    : { stage: -1, row: 0, tiles: 0 };
  let bgTiles = 0;
  if (pick.stage >= 0) {
    bgTiles = drawBackdrop(canvas, decoded, pick.stage, pick.row);
    layers.push({
      layer: "backdrop",
      stage: pick.stage,
      row: pick.row,
      tiles: bgTiles,
    });
  }

  // layer 1 — the drawn TITLE page, untrimmed, as one 128x176 block
  const page = renderTitlePage(decoded);
  const ink = page ? imgInk(page) : null;
  const hasTitle = !!ink;
  if (bgTiles && hasTitle) dim(canvas, dimFactor);

  if (hasTitle) {
    const pageX = Math.round(COVER_W / 2 - page.w * titleScale / 2);
    // Dark-on-dark art (black logos drawn for a light Saturn title bg) would
    // vanish on the black canvas: measure, per ink pixel, the luma contrast
    // against what is already behind it, and drop a light plate behind the
    // ink bbox when too much of the logo would disappear.
    let darkInk = 0, behindDark = 0, seen = 0;
    for (let y = 0; y < page.h; y++) {
      for (let x = 0; x < page.w; x++) {
        const so = (y * page.w + x) * 4;
        if (!page.rgba[so + 3]) continue;
        const li = 0.299 * page.rgba[so] + 0.587 * page.rgba[so + 1] +
          0.114 * page.rgba[so + 2];
        if (li < DARK_INK_LUMA) darkInk++;
        const tx = pageX + x * titleScale, ty = titleY + y * titleScale;
        if (tx < 0 || tx >= COVER_W || ty < 0 || ty >= COVER_H) continue;
        const to = (ty * COVER_W + tx) * 4;
        seen++;
        const lb = 0.299 * canvas[to] + 0.587 * canvas[to + 1] +
          0.114 * canvas[to + 2];
        if (lb < DARK_INK_LUMA) behindDark++;
      }
    }
    const darkInkFraction = darkInk / ink.opaque;
    const darkBehindFraction = seen ? behindDark / seen : 1;
    // Plate only when the LOGO ITSELF is largely dark (drawn for a light
    // Saturn title background) and what is behind it is dark too.
    if (darkInkFraction > DARK_INK_MAX && darkBehindFraction > 0.5) {
      const rx = pageX + ink.minX * titleScale - 4;
      const ry = titleY + ink.minY * titleScale - 4;
      const rw = (ink.maxX - ink.minX + 1) * titleScale + 8;
      const rh = (ink.maxY - ink.minY + 1) * titleScale + 8;
      for (let y = Math.max(0, ry); y < Math.min(COVER_H, ry + rh); y++) {
        for (let x = Math.max(0, rx); x < Math.min(COVER_W, rx + rw); x++) {
          const o = (y * COVER_W + x) * 4;
          canvas[o] = PLATE_RGB[0];
          canvas[o + 1] = PLATE_RGB[1];
          canvas[o + 2] = PLATE_RGB[2];
        }
      }
      layers.push({
        layer: "plate",
        darkInkFraction: +darkInkFraction.toFixed(3),
        darkBehindFraction: +darkBehindFraction.toFixed(3),
        meanLuma: +ink.meanLuma.toFixed(1),
      });
    }
    blit(canvas, COVER_W, COVER_H, page.rgba, page.w, page.h, pageX, titleY, {
      scale: titleScale,
    });
    layers.push({
      layer: "titlePage",
      w: page.w,
      h: page.h,
      scale: titleScale,
      opaque: ink.opaque,
      meanLuma: +ink.meanLuma.toFixed(1),
    });
  } else {
    // fallback A: biggest boss, integer-scaled to fit 224x300
    const boss = bestBossSprite(decoded);
    if (boss) {
      const k = Math.max(1, Math.min((224 / boss.w) | 0, (300 / boss.h) | 0));
      if (bgTiles) dim(canvas, dimFactor);
      blit(
        canvas,
        COVER_W,
        COVER_H,
        boss.rgba,
        boss.w,
        boss.h,
        Math.round(COVER_W / 2 - boss.w * k / 2),
        Math.round(190 - boss.h * k / 2),
        { scale: k },
      );
      layers.push({
        layer: "fallback-boss",
        key: boss.key,
        w: boss.w,
        h: boss.h,
        scale: k,
      });
    }
    // fallback B: up to 12 distinct enemy first-frames, 4 per row, 56px cells
    const strip = enemyStrip(decoded);
    if (strip.length) {
      if (!boss && bgTiles) dim(canvas, dimFactor);
      const CELL = 56, PER_ROW = 4;
      const rows = Math.ceil(strip.length / PER_ROW);
      const x0 = Math.round(COVER_W / 2 - (PER_ROW * CELL) / 2);
      const y0 = Math.round(340 - (rows * CELL) / 2);
      strip.forEach((s, i) => {
        const k = Math.max(
          1,
          Math.min(((CELL - 4) / s.w) | 0, ((CELL - 4) / s.h) | 0),
        );
        blit(
          canvas,
          COVER_W,
          COVER_H,
          s.rgba,
          s.w,
          s.h,
          Math.round(x0 + (i % PER_ROW) * CELL + CELL / 2 - s.w * k / 2),
          Math.round(y0 + ((i / PER_ROW) | 0) * CELL + CELL / 2 - s.h * k / 2),
          { scale: k },
        );
      });
      layers.push({ layer: "fallback-enemies", count: strip.length });
    }
    // fallback C: CG page 0 (128x512) — present whenever cg decoded at all
    if (!boss && !strip.length && !bgTiles && decoded.cg?.pages?.[0]) {
      const p = decoded.cg.pages[0];
      blit(canvas, COVER_W, COVER_H, p.rgba, p.width, p.height, 64, 0);
      layers.push({ layer: "fallback-cgpage", w: p.width, h: p.height });
    }
  }

  let w = COVER_W, h = COVER_H;
  if (upscale > 1) {
    const up = makeCanvas(COVER_W * upscale, COVER_H * upscale);
    blit(
      up,
      COVER_W * upscale,
      COVER_H * upscale,
      canvas,
      COVER_W,
      COVER_H,
      0,
      0,
      { scale: upscale },
    );
    canvas = up;
    w *= upscale;
    h *= upscale;
  }
  return {
    w,
    h,
    rgba: canvas,
    layers,
    backdropStage: pick.stage,
    backdropRow: pick.row,
    hasTitleArt: hasTitle,
  };
}

// Diagnostics: fraction not pure black, alpha coverage, mean luma.
export function inkStats(rgba) {
  let ink = 0, lumaSum = 0, alpha = 0;
  const n = rgba.length / 4;
  for (let i = 0; i < rgba.length; i += 4) {
    lumaSum += 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
    if (rgba[i] || rgba[i + 1] || rgba[i + 2]) ink++;
    if (rgba[i + 3]) alpha++;
  }
  return {
    pixels: n,
    inkFraction: ink / n,
    alphaFraction: alpha / n,
    meanLuma: lumaSum / n,
  };
}
