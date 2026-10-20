// MODE1/2352 sectors as a CD mastering tool writes them. The retail Dezaemon 2
// track is the oracle when a checkout has it: every one of its 3,251 sectors
// must come back byte for byte from its LBA and user bytes alone. Without it,
// fixed known answers (taken from that same implementation once it matched
// the whole track) and the properties every sector must have keep the code
// honest.

import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  buildMode1Sector,
  cdEdc,
  FAD_OFFSET,
  isValidMode1Sector,
  msfFromLba,
  SECTOR_SIZE,
  USER_OFFSET,
  USER_SIZE,
} from "../src/cd/cd-sector.js";
import { pattern } from "./_iso-synthetic.js";
import { hasDiscImage, loadDiscImage } from "./_fixtures.js";

const hex = (bytes) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const sha256 = async (bytes) =>
  hex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));

Deno.test("an empty sector's header, EDC and whole bytes match the retail track's", async () => {
  const s = buildMode1Sector(3101, new Uint8Array(0));
  assertEquals(s.length, SECTOR_SIZE);
  assertEquals(hex(s.subarray(0, 12)), "00ffffffffffffffffffff00");
  assertEquals(
    hex(s.subarray(12, 16)),
    "00432601",
    "FAD 3251 = 00:43:26, mode 1",
  );
  assertEquals(hex(s.subarray(2064, 2068)), "9aa48c38", "EDC, little-endian");
  assertEquals(
    await sha256(s),
    "8f9255aa9cf1f7e6fcdfc3604829babe5e7fa268455539cb7d1428a3d5788983",
  );
  assertEquals(
    await sha256(buildMode1Sector(3250, new Uint8Array(0))),
    "64f70241e9a863fcd46c8512165a96b192be79386389084b0a918fd20a7f880d",
  );
});

Deno.test("the header counts frames from the 2 s lead-in, in BCD", () => {
  assertEquals(FAD_OFFSET, 150);
  assertEquals(msfFromLba(0), [0x00, 0x02, 0x00]);
  assertEquals(msfFromLba(74), [0x00, 0x02, 0x74]);
  assertEquals(msfFromLba(75), [0x00, 0x03, 0x00]);
  assertEquals(msfFromLba(4500 - 150), [0x01, 0x00, 0x00]);
});

Deno.test("the EDC covers the sync, the header and the user bytes, and the gap is zero", () => {
  const s = buildMode1Sector(500, pattern(USER_SIZE, 9));
  const sum = cdEdc(s, 0, 2064);
  assertEquals(
    [s[2064], s[2065], s[2066], s[2067]],
    [sum & 0xff, (sum >>> 8) & 0xff, (sum >>> 16) & 0xff, sum >>> 24],
  );
  assertEquals(s.subarray(2068, 2076).every((b) => b === 0), true);
  assertEquals(
    s.subarray(USER_OFFSET, USER_OFFSET + USER_SIZE),
    pattern(USER_SIZE, 9),
  );
});

Deno.test("a sector stops validating when any part of it changes", () => {
  const good = buildMode1Sector(1416, pattern(USER_SIZE, 4));
  assert(isValidMode1Sector(good, 1416));
  assert(!isValidMode1Sector(good, 1417), "the header names its own LBA");
  for (const at of [5, 13, USER_OFFSET + 1000, 2065, 2070, 2100, 2300]) {
    const bad = Uint8Array.from(good);
    bad[at] ^= 0x10;
    assert(
      !isValidMode1Sector(bad, 1416),
      `a flipped bit at ${at} went unnoticed`,
    );
  }
});

Deno.test("a short user block is zero-padded, an oversized one refused", () => {
  const short = buildMode1Sector(30, new Uint8Array([1, 2, 3]));
  assertEquals(Array.from(short.subarray(16, 20)), [1, 2, 3, 0]);
  assert(isValidMode1Sector(short, 30));
  assertThrows(() => buildMode1Sector(30, new Uint8Array(USER_SIZE + 1)));
  assertThrows(() => buildMode1Sector(-1, new Uint8Array(0)));
});

Deno.test("building into a subarray rewrites that sector of a whole image in place", () => {
  const image = new Uint8Array(3 * SECTOR_SIZE).fill(0xaa);
  buildMode1Sector(
    1,
    pattern(100, 2),
    image.subarray(SECTOR_SIZE, 2 * SECTOR_SIZE),
  );
  assert(isValidMode1Sector(image.subarray(SECTOR_SIZE, 2 * SECTOR_SIZE), 1));
  assertEquals(image[SECTOR_SIZE - 1], 0xaa, "the sector before is untouched");
  assertEquals(image[2 * SECTOR_SIZE], 0xaa, "the sector after is untouched");
});

Deno.test({
  name: "every sector of the retail Dezaemon 2 track rebuilds byte for byte",
  ignore: !hasDiscImage(),
  fn() {
    const track = loadDiscImage();
    assertEquals(track.length % SECTOR_SIZE, 0);
    const bad = [];
    for (let lba = 0; lba < track.length / SECTOR_SIZE; lba++) {
      if (
        !isValidMode1Sector(
          track.subarray(lba * SECTOR_SIZE, (lba + 1) * SECTOR_SIZE),
          lba,
        )
      ) bad.push(lba);
    }
    assertEquals(
      bad,
      [],
      `sectors that did not rebuild: ${bad.slice(0, 10).join(", ")}`,
    );
  },
});
