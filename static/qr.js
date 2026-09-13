// QR codes, drawn in the page — so a pairing code or a finished build can be
// handed to a phone by pointing its camera at a screen instead of typing.
//
// Two places need one. The BUILD CODE is eight letters the player has to copy
// from a desktop into a browser on another device (static/export-queue.js says
// why the two ends never meet); a QR of the editor URL with `?builder=CODE`
// on it makes that hand-off a camera point instead of eight keystrokes, and
// the editor already reads that parameter. And an APK built on a desktop is a
// file on that desktop's disk — the phone that will install it can fetch it
// straight off the LAN, if something tells it the URL.
//
// Written out rather than pulled in: the launcher ships no bundler for
// static/ (the editor imports these modules raw, at runtime) and this is the
// whole of ISO/IEC 18004 that two short strings need. Shared the same way
// static/export-queue.js and static/eshop-library.js are — the editor imports
// it at runtime, the dashboard at bundle time — and pure, so tests/qr_test.ts
// checks it under Deno against a reference encoder.
//
// Numeric, alphanumeric and byte modes, versions 1-40, all four error
// correction levels, all eight masks with the standard penalty scoring. What
// it does NOT do is ECI, kanji mode, structured append or micro QR: nothing
// here encodes anything but ASCII URLs and codes.

// ── The tables the format is ────────────────────────────────────────────────
// Error correction codewords per block, and how many blocks, indexed
// [ecc level][version]. Index 0 of each row is unused — versions start at 1.

const ECC_CODEWORDS_PER_BLOCK = {
  L: [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  M: [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  Q: [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  H: [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
};

const ECC_BLOCKS = {
  L: [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  M: [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  Q: [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  H: [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
};

/** The two bits each level contributes to the format information. */
const ECC_FORMAT_BITS = { L: 1, M: 0, Q: 3, H: 2 };

/** The 45 characters alphanumeric mode can pack two-to-eleven-bits. */
const ALPHANUMERIC = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:";

const MIN_VERSION = 1;
const MAX_VERSION = 40;

/** Penalty weights for the four mask-scoring rules. */
const PENALTY_N1 = 3;
const PENALTY_N2 = 3;
const PENALTY_N3 = 40;
const PENALTY_N4 = 10;

// ── Bit buffers ─────────────────────────────────────────────────────────────

/** Push the low `len` bits of `value`, most significant first. */
function appendBits(bits, value, len) {
  if (len < 0 || len > 31 || value >>> len !== 0) {
    throw new RangeError("qr: " + value + " does not fit in " + len + " bits");
  }
  for (let i = len - 1; i >= 0; i--) bits.push((value >>> i) & 1);
}

function getBit(value, i) {
  return ((value >>> i) & 1) !== 0;
}

// ── Segments ────────────────────────────────────────────────────────────────
// One mode for the whole string, chosen by what it is made of. Mixing modes
// would pack a little tighter, but every payload here is a URL or a code —
// one is pure byte, the other pure alphanumeric — and a mixed encoder is a
// lot of machinery for nothing.

function isNumeric(text) {
  return text.length > 0 && /^[0-9]+$/.test(text);
}

function isAlphanumeric(text) {
  if (!text.length) return false; // an empty payload is a byte segment of none
  for (const ch of text) if (!ALPHANUMERIC.includes(ch)) return false;
  return true;
}

/** UTF-8 bytes of a string, without depending on TextEncoder's presence. */
function utf8(text) {
  if (typeof TextEncoder === "function") return new TextEncoder().encode(text);
  const out = [];
  for (const ch of text) {
    let c = ch.codePointAt(0);
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
  }
  return Uint8Array.from(out);
}

/**
 * The mode this text will be sent in, its mode indicator, how many characters
 * the count field must describe, and the payload bits themselves.
 */
function makeSegment(text) {
  if (isNumeric(text)) {
    const bits = [];
    for (let i = 0; i < text.length;) {
      const n = Math.min(3, text.length - i);
      appendBits(bits, Number(text.substr(i, n)), n * 3 + 1);
      i += n;
    }
    return { mode: "numeric", indicator: 1, count: text.length, bits };
  }
  if (isAlphanumeric(text)) {
    const bits = [];
    let i = 0;
    for (; i + 2 <= text.length; i += 2) {
      appendBits(
        bits,
        ALPHANUMERIC.indexOf(text[i]) * 45 + ALPHANUMERIC.indexOf(text[i + 1]),
        11,
      );
    }
    if (i < text.length) appendBits(bits, ALPHANUMERIC.indexOf(text[i]), 6);
    return { mode: "alphanumeric", indicator: 2, count: text.length, bits };
  }
  const bytes = utf8(text);
  const bits = [];
  for (const b of bytes) appendBits(bits, b, 8);
  return { mode: "byte", indicator: 4, count: bytes.length, bits };
}

/** How many bits the character-count field takes, which widens with version. */
function countBits(mode, version) {
  const i = version <= 9 ? 0 : version <= 26 ? 1 : 2;
  if (mode === "numeric") return [10, 12, 14][i];
  if (mode === "alphanumeric") return [9, 11, 13][i];
  return [8, 16, 16][i];
}

// ── Capacity ────────────────────────────────────────────────────────────────

/**
 * Modules a version has left for data and error correction once the function
 * patterns — finders, timing, alignment, the format and version fields — have
 * taken theirs.
 */
function rawDataModules(version) {
  const size = version * 4 + 17;
  let result = size * size;
  result -= 8 * 8 * 3; // the three finders, with their separators and format strips
  result -= 15 * 2 + 1; // the two format copies and the dark module
  result -= (size - 16) * 2; // the timing rows
  if (version >= 2) {
    const numAlign = Math.floor(version / 7) + 2;
    result -= (numAlign - 1) * (numAlign - 1) * 25;
    result -= (numAlign - 2) * 2 * 20; // the ones sitting on a timing row
    if (version >= 7) result -= 6 * 3 * 2; // the version field, twice
  }
  return result;
}

/**
 * Data bits a version and level leave for the payload.
 *
 * Through the codeword count rather than straight off the module count: a
 * version whose data region is not a whole number of codewords spends the
 * leftover 3, 4 or 7 modules on remainder bits, which carry nothing. Counting
 * them as capacity picks a version too small at the boundary — and then pads
 * the stream past the codewords the version actually has.
 */
function dataCapacityBits(version, ecc) {
  return (Math.floor(rawDataModules(version) / 8) -
    ECC_CODEWORDS_PER_BLOCK[ecc][version] * ECC_BLOCKS[ecc][version]) * 8;
}

// ── GF(256) and Reed-Solomon ────────────────────────────────────────────────
// The field is the one the format names: x^8 + x^4 + x^3 + x^2 + 1 (0x11D).

function gfMul(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

/** The generator polynomial of the given degree, minus its leading term. */
function rsDivisor(degree) {
  const result = new Uint8Array(degree);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMul(result[j], root);
      if (j + 1 < degree) result[j] ^= result[j + 1];
    }
    root = gfMul(root, 0x02);
  }
  return result;
}

function rsRemainder(data, divisor) {
  const result = new Uint8Array(divisor.length);
  for (const b of data) {
    const factor = b ^ result[0];
    result.copyWithin(0, 1);
    result[result.length - 1] = 0;
    for (let i = 0; i < divisor.length; i++) {
      result[i] ^= gfMul(divisor[i], factor);
    }
  }
  return result;
}

/**
 * Split the data into the version's blocks, give each its own error
 * correction, and interleave them back into the order the matrix is filled in.
 *
 * Short blocks are padded with a byte that is dropped on the way out — it
 * exists only so every block is the same length while they are read across.
 */
function addEccAndInterleave(data, version, ecc) {
  const numBlocks = ECC_BLOCKS[ecc][version];
  const blockEccLen = ECC_CODEWORDS_PER_BLOCK[ecc][version];
  const rawCodewords = Math.floor(rawDataModules(version) / 8);
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
  const shortBlockLen = Math.floor(rawCodewords / numBlocks);

  const blocks = [];
  const divisor = rsDivisor(blockEccLen);
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const dat = Array.from(
      data.slice(k, k + shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1)),
    );
    k += dat.length;
    const eccBytes = rsRemainder(dat, divisor);
    if (i < numShortBlocks) dat.push(0);
    blocks.push(dat.concat(Array.from(eccBytes)));
  }

  const result = [];
  for (let i = 0; i < blocks[0].length; i++) {
    for (let j = 0; j < blocks.length; j++) {
      // The padding byte of a short block is not transmitted.
      if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) {
        result.push(blocks[j][i]);
      }
    }
  }
  return Uint8Array.from(result);
}

// ── The matrix ──────────────────────────────────────────────────────────────

/** Where the alignment patterns sit, on both axes, for this version. */
function alignmentPositions(version) {
  if (version === 1) return [];
  const numAlign = Math.floor(version / 7) + 2;
  const step = version === 32
    ? 26
    : Math.ceil((version * 4 + 4) / (numAlign * 2 - 2)) * 2;
  const result = [6];
  for (let pos = version * 4 + 17 - 7; result.length < numAlign; pos -= step) {
    result.splice(1, 0, pos);
  }
  return result;
}

function newGrid(size, fill) {
  const rows = [];
  for (let y = 0; y < size; y++) rows.push(new Uint8Array(size).fill(fill));
  return rows;
}

/**
 * Everything that is the same for every payload of a version: the three
 * finders, the timing rows, the alignment grid, and the format and version
 * fields (the format's real bits are written later, once a mask is chosen).
 */
function drawFunctionPatterns(modules, isFunction, version, ecc) {
  const size = modules.length;
  const set = (x, y, dark) => {
    modules[y][x] = dark ? 1 : 0;
    isFunction[y][x] = 1;
  };

  for (let i = 0; i < size; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }

  // A finder is a 7x7 pattern plus its separator, drawn as rings by distance.
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        const x = cx + dx;
        const y = cy + dy;
        if (x >= 0 && x < size && y >= 0 && y < size) {
          set(x, y, dist !== 2 && dist !== 4);
        }
      }
    }
  }

  const align = alignmentPositions(version);
  for (let i = 0; i < align.length; i++) {
    for (let j = 0; j < align.length; j++) {
      // The three corners are already finder, not alignment.
      const corner = (i === 0 && j === 0) ||
        (i === 0 && j === align.length - 1) ||
        (i === align.length - 1 && j === 0);
      if (corner) continue;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          set(align[i] + dx, align[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    }
  }

  drawFormatBits(modules, isFunction, ecc, 0);
  drawVersionBits(modules, isFunction, version);
}

/**
 * The format field — level and mask, with its BCH check and the format mask —
 * written into both of the places the decoder looks.
 */
function drawFormatBits(modules, isFunction, ecc, mask) {
  const size = modules.length;
  const set = (x, y, dark) => {
    modules[y][x] = dark ? 1 : 0;
    isFunction[y][x] = 1;
  };
  const data = (ECC_FORMAT_BITS[ecc] << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;

  for (let i = 0; i <= 5; i++) set(8, i, getBit(bits, i));
  set(8, 7, getBit(bits, 6));
  set(8, 8, getBit(bits, 7));
  set(7, 8, getBit(bits, 8));
  for (let i = 9; i < 15; i++) set(14 - i, 8, getBit(bits, i));

  for (let i = 0; i < 8; i++) set(size - 1 - i, 8, getBit(bits, i));
  for (let i = 8; i < 15; i++) set(8, size - 15 + i, getBit(bits, i));
  set(8, size - 8, true); // the dark module, which is always set
}

/** Version 7 and up state their version twice, with a BCH check. */
function drawVersionBits(modules, isFunction, version) {
  if (version < 7) return;
  const size = modules.length;
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  const bits = (version << 12) | rem;
  for (let i = 0; i < 18; i++) {
    const dark = getBit(bits, i);
    const a = size - 11 + (i % 3);
    const b = Math.floor(i / 3);
    modules[b][a] = dark ? 1 : 0;
    isFunction[b][a] = 1;
    modules[a][b] = dark ? 1 : 0;
    isFunction[a][b] = 1;
  }
}

/** The zigzag: two columns at a time, right to left, skipping the timing one. */
function drawCodewords(modules, isFunction, data) {
  const size = modules.length;
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!isFunction[y][x] && i < data.length * 8) {
          modules[y][x] = getBit(data[i >>> 3], 7 - (i & 7)) ? 1 : 0;
          i++;
        }
      }
    }
  }
}

function maskBit(mask, x, y) {
  switch (mask) {
    case 0:
      return (x + y) % 2 === 0;
    case 1:
      return y % 2 === 0;
    case 2:
      return x % 3 === 0;
    case 3:
      return (x + y) % 3 === 0;
    case 4:
      return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5:
      return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6:
      return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    default:
      return ((((x + y) % 2) + ((x * y) % 3)) % 2) === 0;
  }
}

/** XOR the mask over every module that is not a function pattern. */
function applyMask(modules, isFunction, mask) {
  const size = modules.length;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!isFunction[y][x] && maskBit(mask, x, y)) modules[y][x] ^= 1;
    }
  }
}

// ── Mask scoring ────────────────────────────────────────────────────────────
// The four rules of the specification: long runs, 2x2 blocks, finder-lookalike
// sequences, and how far from half the modules are dark. Lowest total wins.

function finderPenaltyAddHistory(runLength, history, size) {
  if (history[0] === 0) runLength += size; // the light border the symbol sits in
  history.pop();
  history.unshift(runLength);
}

function finderPenaltyCountPatterns(history) {
  const n = history[1];
  const core = n > 0 && history[2] === n && history[3] === n * 3 &&
    history[4] === n && history[5] === n;
  return (core && history[0] >= n * 4 && history[6] >= n ? 1 : 0) +
    (core && history[6] >= n * 4 && history[0] >= n ? 1 : 0);
}

function finderPenaltyTerminate(runColor, runLength, history, size) {
  if (runColor) {
    finderPenaltyAddHistory(runLength, history, size);
    runLength = 0;
  }
  finderPenaltyAddHistory(runLength + size, history, size);
  return finderPenaltyCountPatterns(history);
}

function penaltyScore(modules) {
  const size = modules.length;
  let result = 0;

  for (let y = 0; y < size; y++) {
    let runColor = 0;
    let runLen = 0;
    const history = [0, 0, 0, 0, 0, 0, 0];
    for (let x = 0; x < size; x++) {
      if (modules[y][x] === runColor) {
        runLen++;
        if (runLen === 5) result += PENALTY_N1;
        else if (runLen > 5) result++;
      } else {
        finderPenaltyAddHistory(runLen, history, size);
        if (!runColor) result += finderPenaltyCountPatterns(history) * PENALTY_N3;
        runColor = modules[y][x];
        runLen = 1;
      }
    }
    result += finderPenaltyTerminate(runColor, runLen, history, size) * PENALTY_N3;
  }

  for (let x = 0; x < size; x++) {
    let runColor = 0;
    let runLen = 0;
    const history = [0, 0, 0, 0, 0, 0, 0];
    for (let y = 0; y < size; y++) {
      if (modules[y][x] === runColor) {
        runLen++;
        if (runLen === 5) result += PENALTY_N1;
        else if (runLen > 5) result++;
      } else {
        finderPenaltyAddHistory(runLen, history, size);
        if (!runColor) result += finderPenaltyCountPatterns(history) * PENALTY_N3;
        runColor = modules[y][x];
        runLen = 1;
      }
    }
    result += finderPenaltyTerminate(runColor, runLen, history, size) * PENALTY_N3;
  }

  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const c = modules[y][x];
      if (c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1]) {
        result += PENALTY_N2;
      }
    }
  }

  let dark = 0;
  for (const row of modules) for (const m of row) dark += m;
  const total = size * size;
  const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
  return result + k * PENALTY_N4;
}

// ── The encoder ─────────────────────────────────────────────────────────────

/**
 * `text` as a QR symbol.
 *
 * Returns the module grid and its side length; `modules[y][x]` is 1 for a dark
 * module. The quiet zone is NOT part of it — a renderer adds its own, which is
 * what `qrSvg` does.
 *
 * Throws when the text will not fit in version 40 at the level asked for,
 * which for anything this app encodes means a bug rather than a long URL.
 */
export function encodeQr(text, options = {}) {
  const ecc = options.ecc || "M";
  if (!ECC_BLOCKS[ecc]) throw new RangeError("qr: no such level " + ecc);
  const minVersion = Math.max(MIN_VERSION, options.minVersion || MIN_VERSION);
  const maxVersion = Math.min(MAX_VERSION, options.maxVersion || MAX_VERSION);

  const segment = makeSegment(String(text));

  let version = 0;
  let dataUsedBits = 0;
  for (let v = minVersion; v <= maxVersion; v++) {
    const used = 4 + countBits(segment.mode, v) + segment.bits.length;
    if (used <= dataCapacityBits(v, ecc)) {
      version = v;
      dataUsedBits = used;
      break;
    }
  }
  if (!version) {
    throw new RangeError(
      "qr: " + segment.bits.length + " data bits do not fit a version " +
        maxVersion + " symbol at level " + ecc,
    );
  }

  const capacityBits = dataCapacityBits(version, ecc);
  const bits = [];
  appendBits(bits, segment.indicator, 4);
  appendBits(bits, segment.count, countBits(segment.mode, version));
  for (const b of segment.bits) bits.push(b);
  if (bits.length !== dataUsedBits) {
    throw new Error("qr: bit count disagrees with the version chosen");
  }

  // Terminator, then to a byte boundary, then the two alternating pad bytes.
  appendBits(bits, 0, Math.min(4, capacityBits - bits.length));
  appendBits(bits, 0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacityBits; pad ^= 0xec ^ 0x11) {
    appendBits(bits, pad, 8);
  }

  const dataCodewords = new Uint8Array(bits.length / 8);
  for (let i = 0; i < bits.length; i++) {
    dataCodewords[i >>> 3] |= bits[i] << (7 - (i & 7));
  }

  const allCodewords = addEccAndInterleave(dataCodewords, version, ecc);

  const size = version * 4 + 17;
  const modules = newGrid(size, 0);
  const isFunction = newGrid(size, 0);
  drawFunctionPatterns(modules, isFunction, version, ecc);
  drawCodewords(modules, isFunction, allCodewords);

  // Every mask is tried and scored; the specification's tie-break is the
  // lowest number, which falls out of keeping the first best.
  let bestMask = options.mask;
  if (bestMask === undefined || bestMask === null) {
    let bestScore = Infinity;
    for (let mask = 0; mask < 8; mask++) {
      applyMask(modules, isFunction, mask);
      drawFormatBits(modules, isFunction, ecc, mask);
      const score = penaltyScore(modules);
      if (score < bestScore) {
        bestScore = score;
        bestMask = mask;
      }
      applyMask(modules, isFunction, mask); // undo — XOR is its own inverse
    }
  }
  applyMask(modules, isFunction, bestMask);
  drawFormatBits(modules, isFunction, ecc, bestMask);

  return { size, version, ecc, mask: bestMask, modules };
}

// ── Rendering ───────────────────────────────────────────────────────────────

/**
 * The symbol as an SVG string, ready for innerHTML.
 *
 * One `<path>` of the dark modules rather than a rectangle each: a version 10
 * symbol is ~1,200 of them, and a thousand elements in the editor's menu is a
 * scroll janking for no reason. `scale` is module side in user units and the
 * viewBox carries the four-module quiet zone the format requires — without it
 * a reader sitting on a dark page never finds the finders.
 *
 * Colours default to currentColor on transparent, so the symbol inherits the
 * panel it is dropped into. A phone camera needs the contrast the other way
 * round (dark on light), which is why the callers that matter pass light.
 */
export function qrSvg(text, options = {}) {
  const { size, modules } = encodeQr(text, options);
  const quiet = options.quiet === undefined ? 4 : options.quiet;
  const dim = size + quiet * 2;
  const dark = options.dark || "currentColor";
  const light = options.light || "none";

  let path = "";
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (modules[y][x]) path += "M" + (x + quiet) + " " + (y + quiet) + "h1v1h-1z";
    }
  }
  const label = options.label === undefined ? String(text) : options.label;
  const title = label ? "<title>" + escapeXml(label) + "</title>" : "";
  const bg = light === "none"
    ? ""
    : '<rect width="' + dim + '" height="' + dim + '" fill="' + light + '"/>';
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + dim + " " + dim +
    '" shape-rendering="crispEdges" role="img"' +
    (label ? ' aria-label="' + escapeXml(label) + '"' : ' aria-hidden="true"') +
    ">" + title + bg + '<path fill="' + dark + '" d="' + path + '"/></svg>';
}

function escapeXml(s) {
  return String(s).replace(/[&<>"]/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]
  ));
}

/**
 * The pairing link a BUILD CODE stands for: the editor, already paired.
 *
 * The editor reads `?builder=` off its own URL on boot and stores it (see
 * `fromUrl` in static/editor/index.html), so scanning this is the whole of
 * typing the code — which is the point of printing it next to the letters
 * rather than instead of them.
 */
export function builderPairUrl(code, origin) {
  const base = String(origin || "").replace(/\/+$/, "");
  return base + "/editor/?builder=" + encodeURIComponent(String(code || ""));
}
