// The SRAM map itself: it must tile the cart exactly, and the stats must
// notice a half dump.

import { assert, assertEquals } from "@std/assert";
import {
  CONFIDENCES,
  coverage,
  REGION,
  regionFor,
  regionStats,
  SFC_REGIONS,
} from "../src/sfc/regions.js";

Deno.test("the 26 regions tile 0x00000-0x20000 with no gaps or overlaps", () => {
  assertEquals(SFC_REGIONS.length, 26);
  const cov = coverage();
  assertEquals(cov.gaps, []);
  assertEquals(cov.overlaps, []);
  assertEquals(cov.covered, true);
  for (let i = 1; i < SFC_REGIONS.length; i++) {
    assertEquals(SFC_REGIONS[i].offset, SFC_REGIONS[i - 1].end);
  }
  for (const r of SFC_REGIONS) {
    assert(CONFIDENCES.includes(r.confidence), `${r.name}: ${r.confidence}`);
    assertEquals(r.length, r.end - r.offset);
  }
});

Deno.test("coverage reports a gap and an overlap", () => {
  const cov = coverage([
    { name: "a", offset: 0, end: 0x10 },
    { name: "b", offset: 0x08, end: 0x20 },
    { name: "c", offset: 0x30, end: 0x40 },
  ], 0x50);
  assertEquals(cov.covered, false);
  assertEquals(cov.overlaps, [{ name: "b", offset: 0x08, end: 0x10 }]);
  assertEquals(cov.gaps, [{ offset: 0x20, end: 0x30 }, {
    offset: 0x40,
    end: 0x50,
  }]);
});

Deno.test("regionFor and REGION agree with the ROM's labels", () => {
  assertEquals(regionFor(0x7ff8)?.name, "checkString");
  assertEquals(regionFor(0x7fff)?.label, "CHECK STRINGS");
  assertEquals(regionFor(0x8000)?.label, "ENEMY DATA");
  assertEquals(regionFor(0x20000), null);
  assertEquals(REGION.graphics.label, "GRAPIC DATA");
  assertEquals(REGION.scroll.label, "SCROLL EFECT");
  assertEquals(REGION.hiScore.offset, 0x7e8e);
  assertEquals(REGION.appear.length, 6 * 0x1200);
});

Deno.test("regionStats marks blank regions and absent ones in a 64 KB dump", () => {
  const full = regionStats(new Uint8Array(0x20000));
  assertEquals(full.length, 26);
  assertEquals(
    full.every((s) => s.present && s.blank && s.entropy === 0),
    true,
  );
  const half = regionStats(new Uint8Array(0x10000));
  const graphics = half.find((s) => s.name === "graphics");
  assertEquals(graphics?.present, false);
  assertEquals(half.filter((s) => !s.present).length, 1);
  const bytes = new Uint8Array(0x20000);
  bytes.fill(0xff, REGION.reserved1.offset, REGION.reserved1.end);
  const stats = regionStats(bytes);
  assertEquals(stats.find((s) => s.name === "reserved1")?.ffRatio, 1);
});
