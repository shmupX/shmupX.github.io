// lib/dezaemon-n64.ts: finding Dezaemon 3D and the 64DD IPL, and telling the
// dumps apart.
//
// No ROM is in CI (neither is ours to ship), so the finder is driven over a
// temporary dev-fixtures/ tree of synthetic images: 16 MB files whose header
// names DEZAEMON3D in each of the three byte orders, a 4 MB one whose header
// says 64DD IPL, and decoys. The translation itself is applied only to the
// real Japanese dump, whose sum the readme publishes — that path is exercised
// by the route on a machine that has the dump, and here only its refusal of
// a dump the readme does not name.

import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import {
  DEZAEMON_N64_ROM_BYTES,
  DEZAEMON_N64_SHA1_ENGLISH,
  DEZAEMON_N64_SHA1_JAPAN,
  editionOf,
  findDezaemonN64,
  forgetDezaemonN64,
  looksLikeDezaemon3d,
  looksLikeN64ddIpl,
  n64ByteOrder,
  n64Candidates,
  N64DD_IPL_BYTES,
  readDezaemonN64Rom,
  readN64Header,
  sha1Hex,
  toZ64,
} from "../lib/dezaemon-n64.ts";

/** A cartridge image in z64 order: the mark, a name at 0x20, a game code at 0x3B, filler after. */
function image(
  size: number,
  name: string,
  code = "NDZJ",
  fill = 0x5a,
): Uint8Array {
  const out = new Uint8Array(size).fill(fill);
  out.set([0x80, 0x37, 0x12, 0x40], 0);
  out.fill(0x20, 0x20, 0x34);
  for (let i = 0; i < name.length; i++) out[0x20 + i] = name.charCodeAt(i);
  for (let i = 0; i < 4; i++) out[0x3b + i] = code.charCodeAt(i);
  return out;
}

function swap16(z: Uint8Array): Uint8Array {
  const out = new Uint8Array(z.length);
  for (let i = 0; i + 1 < z.length; i += 2) {
    out[i] = z[i + 1];
    out[i + 1] = z[i];
  }
  return out;
}

function swap32(z: Uint8Array): Uint8Array {
  const out = new Uint8Array(z.length);
  for (let i = 0; i + 3 < z.length; i += 4) {
    out[i] = z[i + 3];
    out[i + 1] = z[i + 2];
    out[i + 2] = z[i + 1];
    out[i + 3] = z[i];
  }
  return out;
}

Deno.test("the three dump orders are told apart by their mark and put back into z64 order", () => {
  const z = image(0x40, "DEZAEMON3D");
  assertEquals(n64ByteOrder(z), "z64");
  const v = swap16(z);
  const n = swap32(z);
  assertEquals(n64ByteOrder(v), "v64");
  assertEquals(n64ByteOrder(n), "n64");
  assertEquals(toZ64(v), z);
  assertEquals(toZ64(n), z);
  assert(toZ64(z) === z, "a z64 image is returned as it is");
  assertEquals(n64ByteOrder(new Uint8Array(0x40)), null);
  assertEquals(n64ByteOrder(new Uint8Array(8)), null);
});

Deno.test("the 64DD IPL's own mark is an N64 image in every order", () => {
  // A real IPL opens 0x80270740, not a cartridge's 0x80371240.
  const z = image(0x40, "64DD IPL (JPN)", "    ");
  z.set([0x80, 0x27, 0x07, 0x40], 0);
  const orders = [
    [z, "z64"],
    [swap16(z), "v64"],
    [swap32(z), "n64"],
  ] as const;
  for (const [bytes, order] of orders) {
    const h = readN64Header(bytes);
    assertEquals(h.order, order);
    assertEquals(h.name, "64DD IPL (JPN)");
    assert(looksLikeN64ddIpl(h, "64DD_IPL.bin"), `${order} is an IPL`);
  }
  assertEquals(toZ64(swap32(z)), z);
});

Deno.test("the header is read through any order, and names the game", () => {
  const z = image(0x40, "DEZAEMON3D");
  const h = readN64Header(swap16(z));
  assertEquals(h.order, "v64");
  assertEquals(h.name, "DEZAEMON3D");
  assertEquals(h.gameCode, "NDZJ");
  assert(looksLikeDezaemon3d(h));
  assert(
    looksLikeDezaemon3d(readN64Header(image(0x40, "DEZAEMON 3D", "XXXX"))),
    "the name alone will do",
  );
  assert(
    looksLikeDezaemon3d(readN64Header(image(0x40, "ANYTHING", "NDZJ"))),
    "so will the code",
  );
  assert(
    !looksLikeDezaemon3d(readN64Header(image(0x40, "MARIO KART 64", "NKTJ"))),
  );
  assert(
    !looksLikeDezaemon3d(readN64Header(new Uint8Array(0x40))),
    "no mark, no game",
  );
  assert(
    looksLikeN64ddIpl(readN64Header(image(0x40, "64DD IPL", "    ")), "x.bin"),
  );
  assert(
    looksLikeN64ddIpl(readN64Header(image(0x40, "", "    ")), "64DD_IPL.n64"),
    "a blank name defers to the file name",
  );
  assert(
    !looksLikeN64ddIpl(readN64Header(image(0x40, "", "    ")), "something.n64"),
  );
  assert(
    !looksLikeN64ddIpl(readN64Header(image(0x40, "DEZAEMON3D")), "ipl.n64"),
    "a named cartridge is not an IPL",
  );
});

Deno.test("the readme's two sums name the editions; anything else is unknown", async () => {
  assertEquals(editionOf(DEZAEMON_N64_SHA1_JAPAN), "japan");
  assertEquals(editionOf(DEZAEMON_N64_SHA1_ENGLISH), "english");
  assertEquals(editionOf("00".repeat(20)), "unknown");
  assertEquals(
    await sha1Hex(new Uint8Array(0)),
    "da39a3ee5e6b4b0d3255bfef95601890afd80709",
  );
});

Deno.test("the finder walks dev-fixtures/ one level deep, by size and header, and memoises", async () => {
  const dir = await Deno.makeTempDir({ prefix: "shmupx-n64-" });
  try {
    const fixtures = join(dir, "dev-fixtures");
    await Deno.mkdir(join(fixtures, "N64"), { recursive: true });
    // decoys first in name order: a 16 MB image that is not Dezaemon, a small file with the right name
    await Deno.writeFile(
      join(fixtures, "a-other.z64"),
      image(DEZAEMON_N64_ROM_BYTES, "MARIO KART 64", "NKTJ"),
    );
    await Deno.writeFile(
      join(fixtures, "b-dezaemon-short.z64"),
      image(0x1000, "DEZAEMON3D"),
    );
    await Deno.writeFile(
      join(fixtures, "._dezaemon.z64"),
      image(DEZAEMON_N64_ROM_BYTES, "DEZAEMON3D"),
    );
    // the dump, one level down and byte-swapped
    await Deno.writeFile(
      join(fixtures, "N64", "Dezaemon 3D (J).v64"),
      swap16(image(DEZAEMON_N64_ROM_BYTES, "DEZAEMON3D")),
    );
    // the IPL, by its header
    await Deno.writeFile(
      join(fixtures, "N64", "ipl.n64"),
      image(N64DD_IPL_BYTES, "64DD IPL", "    ", 0x11),
    );
    forgetDezaemonN64();
    const candidates = await n64Candidates(dir);
    assertEquals(candidates.map((c) => c.path.slice(fixtures.length + 1)), [
      "a-other.z64",
      "N64/Dezaemon 3D (J).v64",
      "N64/ipl.n64",
    ]);
    const found = await findDezaemonN64(dir);
    assert(found.rom, "the dump was found");
    assertEquals(found.rom.name, "Dezaemon 3D (J).v64");
    assertEquals(found.rom.header.order, "v64");
    assertEquals(
      found.rom.edition,
      "unknown",
      "a synthetic image is not a dump the readme names",
    );
    assertEquals(
      found.rom.sha1,
      await sha1Hex(image(DEZAEMON_N64_ROM_BYTES, "DEZAEMON3D")),
      "the sum is of the z64 image",
    );
    assert(found.ipl);
    assertEquals(found.ipl.name, "ipl.n64");
    assertEquals(found.ipl.header.name, "64DD IPL");
    // memoised: the same listing answers without a second read
    const again = await findDezaemonN64(dir);
    assert(again === found);
    // an unknown dump is refused by the reader rather than patched into garbage
    await assertRejects(
      () => readDezaemonN64Rom(found.rom!, { root: dir }),
      Error,
      "does not know",
    );
    // $DEZAEMON_N64_ROM names a file anywhere, ahead of what was discovered
    const elsewhere = join(dir, "elsewhere.n64");
    await Deno.writeFile(
      elsewhere,
      swap32(image(DEZAEMON_N64_ROM_BYTES, "DEZAEMON3D", "NDZJ", 0x77)),
    );
    forgetDezaemonN64();
    const named = await findDezaemonN64(dir, { extra: [elsewhere] });
    assertEquals(named.rom?.name, "elsewhere.n64");
    assertEquals(named.rom?.header.order, "n64");
    // nothing there at all
    forgetDezaemonN64();
    const none = await findDezaemonN64(join(dir, "nowhere"));
    assertEquals(none, { rom: null, ipl: null });
  } finally {
    forgetDezaemonN64();
    await Deno.remove(dir, { recursive: true });
  }
});
