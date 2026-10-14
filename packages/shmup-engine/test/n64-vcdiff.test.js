// src/n64/vcdiff.js: the xdelta3 (VCDIFF) applier for the translation patch.
//
// Three kinds of evidence. A patch assembled by hand, instruction by
// instruction, pins the RFC semantics (RUN, ADD, COPY from the source and
// from the window's own output, overlapping copies, the near and same
// caches, paired codes, a VCD_TARGET window, the Adler-32) against an
// expected target the test builds by other means. A patch xdelta3 itself
// wrote (-S lzma, three windows whose LZMA sections continue across them;
// committed as base64, its source regenerated from a seeded LCG) pins the
// real encoder's output. And the real translation patch in static/n64dd/,
// when the checkout has it, is parsed and dry-run: no ROM is here, so the
// strongest check is that both windows' instruction streams consume their
// sections exactly and land on 8,388,608 bytes each.
import {
  assert,
  assertEquals,
  assertStrictEquals,
  assertThrows,
} from "@std/assert";
import { decodeBase64 } from "@std/encoding/base64";
import {
  adler32,
  applyVcdiff,
  dryRunVcdiff,
  parseVcdiff,
  VCDIFF_CODE_TABLE,
} from "../src/n64/vcdiff.js";

// ---------------------------------------------------------- hand assembly

/** A VCDIFF integer: base 128, high bit first, bit 7 continues. */
function int(value) {
  const out = [];
  do {
    out.unshift(value & 0x7f);
    value = Math.floor(value / 128);
  } while (value > 0);
  for (let i = 0; i < out.length - 1; i++) out[i] |= 0x80;
  return out;
}

const be32 = (
  v,
) => [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
const ascii = (s) => [...s].map((c) => c.charCodeAt(0));

/** One window, uncompressed sections, as xdelta3 lays it out. */
function assembleWindow(
  {
    winIndicator,
    segment = null,
    targetLength,
    data,
    inst,
    addr,
    adler = null,
  },
) {
  const head = [winIndicator];
  if (segment) head.push(...int(segment.length), ...int(segment.position));
  const delta = [
    ...int(targetLength),
    0, // del_indicator: nothing compressed
    ...int(data.length),
    ...int(inst.length),
    ...int(addr.length),
    ...(adler === null ? [] : be32(adler)),
    ...data,
    ...inst,
    ...addr,
  ];
  return [...head, ...int(delta.length), ...delta];
}

function assemblePatch(
  windows,
  { hdrIndicator = 0x04, appHeader = "hand//made/" } = {},
) {
  const head = [0xd6, 0xc3, 0xc4, 0x00, hdrIndicator];
  if (hdrIndicator & 0x04) {
    head.push(...int(appHeader.length), ...ascii(appHeader));
  }
  return Uint8Array.from([...head, ...windows.flat()]);
}

const SOURCE = Uint8Array.from({ length: 64 }, (_, i) => (i * 7 + 3) & 0xff);

/**
 * The hand-made patch and the target it must produce. Window 0 copies from
 * the whole source and from itself; window 1 is a VCD_TARGET window over
 * window 0's output; window 2 has no segment and no checksum.
 */
function handMade() {
  const s = SOURCE;
  const out = []; // window 0's output, built by the instructions' definitions
  const push = (bytes) => out.push(...bytes);
  const copyOut = (at, size) => {
    for (let i = 0; i < size; i++) out.push(out[at + i]);
  };
  // 1. RUN 5 x "A"                                   code 0, size 5 in the stream
  push(ascii("AAAAA"));
  // 2. ADD "xyz"                                     code 1 + 3
  push(ascii("xyz"));
  // 3. COPY 8 from source 16, mode 0 (SELF)          code 19 + (8 - 3); near[0] = 16
  push(s.subarray(16, 24));
  // 4. COPY 8 from source 24, mode 2 (near[0] + 8)   code 19 + 16 x 2 + 5
  push(s.subarray(24, 32));
  // 5. COPY 6 from the output at 5, mode 1 (HERE):   here = 64 + 24, address 64 + 5 -> value 19
  copyOut(5, 6);
  // 6. COPY 10 from the output 4 bytes back (HERE, value 4): an overlapping copy
  copyOut(out.length - 4, 10);
  // 7. COPY 4 from source 16 by the same cache, mode 6: same[16] is 16 since step 3
  push(s.subarray(16, 20));
  // 8. ADD "!" + COPY 4 from source 0, mode 0        code 163
  push(ascii("!"));
  push(s.subarray(0, 4));
  // 9. COPY 4 from source 60, mode 0 + ADD "?"       code 247
  push(s.subarray(60, 64));
  push(ascii("?"));
  const window0 = Uint8Array.from(out);
  assertStrictEquals(window0.length, 54);

  const w0 = assembleWindow({
    winIndicator: 0x05, // VCD_SOURCE | VCD_ADLER32
    segment: { position: 0, length: 64 },
    targetLength: 54,
    data: [...ascii("A"), ...ascii("xyz"), ...ascii("!"), ...ascii("?")],
    inst: [0, ...int(5), 4, 24, 56, 38, 42, 116, 163, 247],
    addr: [
      ...int(16),
      ...int(8),
      ...int(19),
      ...int(4),
      16,
      ...int(0),
      ...int(60),
    ],
    adler: adler32(window0),
  });
  const window1 = Uint8Array.from([...window0, ...ascii("ok")]);
  const w1 = assembleWindow({
    winIndicator: 0x06, // VCD_TARGET | VCD_ADLER32
    segment: { position: 0, length: 54 },
    targetLength: 56,
    data: ascii("ok"),
    inst: [19, ...int(54), 3], // COPY size-from-stream mode 0; ADD 2
    addr: int(0),
    adler: adler32(window1),
  });
  const w2 = assembleWindow({
    winIndicator: 0x00,
    targetLength: 4,
    data: ascii("end."),
    inst: [5],
    addr: [],
  });
  const target = Uint8Array.from([...window0, ...window1, ...ascii("end.")]);
  return { patch: assemblePatch([w0, w1, w2]), target, window0, window1 };
}

Deno.test("adler32 is zlib's", () => {
  assertStrictEquals(adler32(Uint8Array.from(ascii("Wikipedia"))), 0x11e60398);
  assertStrictEquals(adler32(new Uint8Array(0)), 1);
});

Deno.test("the standard code table has the RFC's 256 entries where the RFC puts them", () => {
  const [RUN, ADD, COPY] = [2, 1, 3];
  assertStrictEquals(VCDIFF_CODE_TABLE.length, 256);
  assertEquals([...VCDIFF_CODE_TABLE[0]], [RUN, 0, 0, 0, 0, 0]);
  assertEquals([...VCDIFF_CODE_TABLE[1]], [ADD, 0, 0, 0, 0, 0]);
  assertEquals([...VCDIFF_CODE_TABLE[18]], [ADD, 17, 0, 0, 0, 0]);
  assertEquals([...VCDIFF_CODE_TABLE[19]], [COPY, 0, 0, 0, 0, 0]);
  assertEquals([...VCDIFF_CODE_TABLE[34]], [COPY, 18, 0, 0, 0, 0]);
  assertEquals([...VCDIFF_CODE_TABLE[162]], [COPY, 18, 8, 0, 0, 0]);
  assertEquals([...VCDIFF_CODE_TABLE[163]], [ADD, 1, 0, COPY, 4, 0]);
  assertEquals([...VCDIFF_CODE_TABLE[234]], [ADD, 4, 0, COPY, 6, 5]);
  assertEquals([...VCDIFF_CODE_TABLE[235]], [ADD, 1, 0, COPY, 4, 6]);
  assertEquals([...VCDIFF_CODE_TABLE[246]], [ADD, 4, 0, COPY, 4, 8]);
  assertEquals([...VCDIFF_CODE_TABLE[247]], [COPY, 4, 0, ADD, 1, 0]);
  assertEquals([...VCDIFF_CODE_TABLE[255]], [COPY, 4, 8, ADD, 1, 0]);
});

Deno.test("applyVcdiff applies a hand-assembled patch: RUN, ADD, COPY from the source and from the output, pairs, a VCD_TARGET window", () => {
  const { patch, target } = handMade();
  assertEquals(applyVcdiff(SOURCE, patch), target);
  assertStrictEquals(target.length, 114);
  // A longer source is fine: the patch addresses only its first 64 bytes.
  const longer = new Uint8Array(100);
  longer.set(SOURCE);
  assertEquals(applyVcdiff(longer, patch), target);
});

Deno.test("parseVcdiff reports the windows, their segments, the target length and the source needed", () => {
  const { patch, window0, window1 } = handMade();
  const parsed = parseVcdiff(patch);
  assertStrictEquals(parsed.hdrIndicator, 0x04);
  assertStrictEquals(parsed.secondaryId, null);
  assertStrictEquals(parsed.appHeaderText, "hand//made/");
  assertStrictEquals(parsed.windows.length, 3);
  assertStrictEquals(parsed.targetLength, 114);
  assertStrictEquals(parsed.sourceLengthNeeded, 64);
  assert(parsed.usesSource);
  assert(parsed.usesTarget);
  const [w0, w1, w2] = parsed.windows;
  assertEquals(w0.segment, { from: "source", position: 0, length: 64 });
  assertStrictEquals(w0.targetOffset, 0);
  assertStrictEquals(w0.adler32, adler32(window0));
  assertStrictEquals(w0.data.compressed, false);
  assertStrictEquals(w0.inst.decodedLength, 10);
  assertEquals(w1.segment, { from: "target", position: 0, length: 54 });
  assertStrictEquals(w1.targetOffset, 54);
  assertStrictEquals(w1.adler32, adler32(window1));
  assertStrictEquals(w2.segment, null);
  assertStrictEquals(w2.adler32, null);
  assertStrictEquals(w2.targetOffset, 110);
});

Deno.test("dryRunVcdiff counts a window's instructions and bytes by kind without a source", () => {
  const { patch } = handMade();
  const run = dryRunVcdiff(patch);
  assertStrictEquals(run.windows, 3);
  assertStrictEquals(run.targetLength, 114);
  const w0 = run.perWindow[0];
  assertStrictEquals(w0.instructions, 11);
  assertStrictEquals(w0.add, 3);
  assertStrictEquals(w0.run, 1);
  assertStrictEquals(w0.copySource, 5);
  assertStrictEquals(w0.copyTarget, 2);
  assertStrictEquals(w0.addBytes, 5);
  assertStrictEquals(w0.runBytes, 5);
  assertStrictEquals(w0.copySourceBytes, 28);
  assertStrictEquals(w0.copyTargetBytes, 16);
  assertStrictEquals(w0.sourceLow, 0);
  assertStrictEquals(w0.sourceHigh, 64);
  assertStrictEquals(run.perWindow[2].sourceLow, null);
});

Deno.test("applyVcdiff refuses a source shorter than the patch reads", () => {
  const { patch } = handMade();
  const err = assertThrows(
    () => applyVcdiff(SOURCE.subarray(0, 63), patch),
    Error,
  );
  assert(err.message.includes("63 bytes"), err.message);
  assert(err.message.includes("first 64"), err.message);
});

Deno.test("applyVcdiff refuses a window whose Adler-32 does not match, naming the window", () => {
  const { patch, target } = handMade();
  const wrong = SOURCE.slice();
  wrong[17] ^= 0xff; // inside the first source COPY
  const err = assertThrows(() => applyVcdiff(wrong, patch), Error);
  assert(err.message.startsWith("window 0 "), err.message);
  assert(err.message.includes("checksum mismatch"), err.message);
  assert(
    err.message.includes(adler32(target.subarray(0, 54)).toString(16)),
    err.message,
  );
  // Without verification the bytes come out, wrong.
  const unverified = applyVcdiff(wrong, patch, { verify: false });
  assertStrictEquals(unverified.length, 114);
  assert(unverified.some((b, i) => b !== target[i]));
  // A corrupted stored checksum is caught on its own window.
  const parsed = parseVcdiff(patch);
  const bad = patch.slice();
  const w1 = parsed.windows[1];
  // The Adler-32 sits right before the data section.
  bad[w1.data.offset - 1] ^= 0x01;
  const err1 = assertThrows(() => applyVcdiff(SOURCE, bad), Error);
  assert(err1.message.startsWith("window 1 "), err1.message);
});

Deno.test("parseVcdiff refuses what it cannot decode, clearly", () => {
  const { patch } = handMade();
  const magic = [0xd6, 0xc3, 0xc4, 0x00];
  assertThrows(
    () => parseVcdiff(Uint8Array.from([...magic, 0x01, 0x01])),
    Error,
    "DJW",
  );
  assertThrows(
    () => parseVcdiff(Uint8Array.from([...magic, 0x01, 0x10])),
    Error,
    "FGK",
  );
  assertThrows(
    () => parseVcdiff(Uint8Array.from([...magic, 0x02])),
    Error,
    "code table",
  );
  assertThrows(
    () => parseVcdiff(Uint8Array.from([...magic, 0x08])),
    Error,
    "reserved",
  );
  assertThrows(
    () => parseVcdiff(Uint8Array.from([0xd6, 0xc3, 0xc4, 0x01, 0])),
    Error,
    "magic",
  );
  assertThrows(
    () => parseVcdiff(patch.subarray(0, patch.length - 3)),
    Error,
    "ends",
  );
  // A window marked compressed under a header that names no compressor: the
  // del_indicator sits before the three one-byte section lengths and the Adler-32.
  const compressedWindow = patch.slice();
  compressedWindow[parseVcdiff(patch).windows[0].data.offset - 4 - 3 - 1] =
    0x07;
  assertThrows(() => parseVcdiff(compressedWindow), Error, "secondary");
});

// ---------------------------------------------------- xdelta3's own output

// 65,536 bytes: 512-byte stretches alternating an LCG's noise and cycled
// text, so the patch's LZMA streams see both literals and matches.
function lcgSource() {
  const text = "dezaemon 3d sample text; ";
  const out = new Uint8Array(65536);
  let x = 7;
  for (let i = 0; i < out.length; i++) {
    if (Math.floor(i / 512) % 2 === 0) {
      x = (Math.imul(x, 1103515245) + 12345) & 0x7fffffff;
      out[i] = (x >>> 16) & 0xff;
    } else {
      out[i] = text.charCodeAt(i % text.length);
    }
  }
  return out;
}

/** The source with an insert, a repeat, a deletion, a zero run and a tail. */
function lcgTarget(src) {
  return Uint8Array.from([
    ...src.subarray(0, 10000),
    ...ascii("ENGLISH PATCH "),
    ...src.subarray(10000, 30000),
    ...src.subarray(5000, 9000),
    ...src.subarray(30500),
    ...new Uint8Array(3000),
    ...src.subarray(0, 500),
  ]);
}

// xdelta3 3.2.2: xdelta3 -e -S lzma -W 32768 -B 32768 -s source target.
// Three windows of 32,768 / 32,768 / 7,014 target bytes; del_indicator 7, 3
// and 1, so the data stream continues across all three windows, the inst
// stream across two, and the plain sections sit beside them.
const XDELTA3_LZMA_PATCH = [
  "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",
].join("");

Deno.test("applyVcdiff applies a patch xdelta3 wrote with LZMA sections continuing across three windows", () => {
  const source = lcgSource();
  assertStrictEquals(
    adler32(source),
    0x74bb8c57,
    "the LCG source is the one the patch was made from",
  );
  const patch = decodeBase64(XDELTA3_LZMA_PATCH);
  const parsed = parseVcdiff(patch);
  assertStrictEquals(parsed.secondaryName, "LZMA");
  assertStrictEquals(
    parsed.appHeaderText,
    "fixture-target.bin//fixture-source.bin/",
  );
  assertStrictEquals(parsed.windows.length, 3);
  assertEquals(parsed.windows.map((w) => w.deltaIndicator), [7, 3, 1]);
  assertEquals(parsed.windows.map((w) => w.targetLength), [32768, 32768, 7014]);
  assertEquals(parsed.windows.map((w) => w.adler32), [
    0xddebd3d2,
    0x1002bdae,
    0x7476d1a1,
  ]);
  assertStrictEquals(parsed.sourceLengthNeeded, 65536);
  const target = lcgTarget(source);
  assertStrictEquals(target.length, 72550);
  assertStrictEquals(adler32(target), 0xde4d633d);
  assertEquals(applyVcdiff(source, patch), target);
  const run = dryRunVcdiff(patch);
  assertStrictEquals(
    run.perWindow.reduce(
      (n, w) =>
        n + w.addBytes + w.runBytes + w.copySourceBytes + w.copyTargetBytes,
      0,
    ),
    72550,
  );
  // The wrong source is caught by the first window's checksum.
  const wrong = source.slice();
  wrong[20000] ^= 1;
  const err = assertThrows(() => applyVcdiff(wrong, patch), Error);
  assert(err.message.startsWith("window 0 "), err.message);
});

// ------------------------------------------------- the translation patch

const REAL_PATCH = new URL(
  "../../../static/n64dd/dezaemon-3d-usa-2024.09.12.xdelta",
  import.meta.url,
);

function hasRealPatch() {
  try {
    Deno.statSync(REAL_PATCH);
    return true;
  } catch {
    return false;
  }
}

Deno.test({
  name:
    "parseVcdiff reads the translation patch: 2 windows, 16,777,216 target bytes, LZMA everywhere",
  ignore: !hasRealPatch(),
  fn() {
    const patch = Deno.readFileSync(REAL_PATCH);
    const parsed = parseVcdiff(patch);
    assertStrictEquals(parsed.hdrIndicator, 0x05);
    assertStrictEquals(parsed.secondaryName, "LZMA");
    assert(
      parsed.appHeaderText.includes("Dezaemon 3D (Japan)"),
      parsed.appHeaderText,
    );
    assertStrictEquals(parsed.windows.length, 2);
    assertStrictEquals(parsed.targetLength, 16777216);
    assertStrictEquals(parsed.sourceLengthNeeded, 16719088);
    assert(
      parsed.sourceLengthNeeded <= 16777216,
      "a 16 MiB .z64 covers the source",
    );
    assert(!parsed.usesTarget);
    for (const w of parsed.windows) {
      assertStrictEquals(w.targetLength, 8388608);
      assertStrictEquals(w.winIndicator, 0x05);
      assertStrictEquals(w.deltaIndicator, 7);
      assertStrictEquals(w.segment.from, "source");
    }
    assertEquals(parsed.windows.map((w) => w.adler32), [
      0x9baceb3d,
      0x0aa12fb9,
    ]);
    assertEquals(parsed.windows.map((w) => w.segment.position), [0, 470487]);
  },
});

Deno.test({
  name:
    "dryRunVcdiff walks the translation patch: both windows consume their sections exactly and produce 8,388,608 bytes",
  ignore: !hasRealPatch(),
  fn() {
    const run = dryRunVcdiff(Deno.readFileSync(REAL_PATCH));
    assertStrictEquals(run.windows, 2);
    assertStrictEquals(run.targetLength, 16777216);
    // The figures an independent Python walker (liblzma for the sections)
    // reached for the same patch.
    const [w0, w1] = run.perWindow;
    assertStrictEquals(w0.instructions, 56930);
    assertEquals(w0.sections, { data: 45716, inst: 62588, addr: 77327 });
    assertEquals([
      w0.addBytes,
      w0.runBytes,
      w0.copySourceBytes,
      w0.copyTargetBytes,
    ], [43578, 208482, 7680202, 456346]);
    assertStrictEquals(w0.sourceHigh, 8382809);
    assertStrictEquals(w1.instructions, 27232);
    assertEquals(w1.sections, { data: 377678, inst: 32322, addr: 30991 });
    assertEquals([
      w1.addBytes,
      w1.runBytes,
      w1.copySourceBytes,
      w1.copyTargetBytes,
    ], [377677, 40, 7860461, 150430]);
    assertStrictEquals(w1.sourceHigh, 16719088);
    for (const w of run.perWindow) {
      assertStrictEquals(
        w.addBytes + w.runBytes + w.copySourceBytes + w.copyTargetBytes,
        8388608,
      );
      assert(w.sourceHigh <= 16777216);
    }
  },
});
