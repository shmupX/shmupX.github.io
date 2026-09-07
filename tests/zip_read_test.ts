// The browser unzipper, against the repo's own ZIP writer.
//
// static/zip-read.js is what an eShop install reads a game's build with, so
// what has to hold is that an archive comes back out as the files that went
// in — stored or deflated — and that the archive shapes it refuses (zip64,
// encryption, not a zip at all) fail with a reason rather than a wrong tree.
// lib/ps2/zip.ts writes both kinds of entry (it stores what does not shrink),
// so it is the witness; Deno has the DecompressionStream the reader inflates
// with, so the same code runs here and in the page.

import { assertEquals, assertRejects } from "@std/assert";
import { buildZip } from "../lib/ps2/zip.ts";
import { normalizeZipPath, unzip } from "../static/zip-read.js";

const encoder = new TextEncoder();
const DATE = new Date("2000-03-04T00:00:00Z");

/** Incompressible, so the writer stores it. */
function noise(n: number): Uint8Array {
  const out = new Uint8Array(n);
  let x = 0x12345678;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    out[i] = (x >>> 16) & 0xff;
  }
  return out;
}

type Entry = { path: string; dir: boolean; data: Uint8Array };
const byPath = (entries: Entry[]) =>
  new Map(entries.map((e) => [e.path, e] as const));

Deno.test("stored and deflated entries both round-trip byte for byte", async () => {
  const entries = [
    { path: "index.html", data: encoder.encode("<html>".repeat(300)) },
    { path: "game.js", data: encoder.encode("console.log(1)\n".repeat(200)) },
    { path: "assets/noise.bin", data: noise(4096) },
    { path: "assets/empty", data: new Uint8Array(0) },
  ];
  const zip = await buildZip(entries, DATE);
  const read = byPath(await unzip(zip));
  assertEquals([...read.keys()].sort(), entries.map((e) => e.path).sort());
  for (const entry of entries) {
    assertEquals(read.get(entry.path)!.dir, false);
    assertEquals(read.get(entry.path)!.data, entry.data, entry.path);
  }
});

Deno.test("every input shape is accepted", async () => {
  const zip = await buildZip([{ path: "a", data: encoder.encode("a") }], DATE);
  const buffer = zip.buffer.slice(
    zip.byteOffset,
    zip.byteOffset + zip.byteLength,
  ) as ArrayBuffer;
  for (const input of [zip, buffer, new Blob([buffer])]) {
    assertEquals((await unzip(input))[0].path, "a");
  }
});

Deno.test("paths come back as cache keys: relative, forward-slashed, inside the root", async () => {
  const zip = await buildZip([
    { path: "./index.html", data: encoder.encode("x") },
    { path: "/abs.txt", data: encoder.encode("x") },
    { path: "assets\\win.txt", data: encoder.encode("x") },
    { path: "a/./b.txt", data: encoder.encode("x") },
    { path: "assets/", data: new Uint8Array(0) },
    // Climbs out of the archive: must be dropped, not filed under /eshop/.
    { path: "../evil.js", data: encoder.encode("x") },
    { path: "assets/../../evil2.js", data: encoder.encode("x") },
  ], DATE);
  const read = byPath(await unzip(zip));
  assertEquals(
    [...read.keys()].sort(),
    ["a/b.txt", "abs.txt", "assets/", "assets/win.txt", "index.html"],
  );
  assertEquals(read.get("assets/")!.dir, true);
  assertEquals(read.get("assets/")!.data.length, 0);
});

Deno.test("normalizeZipPath", () => {
  assertEquals(normalizeZipPath("./a/b"), "a/b");
  assertEquals(normalizeZipPath("//a"), "a");
  assertEquals(normalizeZipPath("dir/"), "dir/");
  assertEquals(normalizeZipPath("a\\b"), "a/b");
  assertEquals(normalizeZipPath("../a"), null);
  assertEquals(normalizeZipPath("a/../b"), null);
  assertEquals(normalizeZipPath("."), "");
});

Deno.test("a data-descriptor flag does not change the read (central sizes rule)", async () => {
  const zip = await buildZip([
    { path: "game.js", data: encoder.encode("let x = 1;\n".repeat(100)) },
  ], DATE);
  // Set bit 3 on both headers, the way a streaming writer would; the sizes in
  // the central directory stay authoritative and the entry still reads.
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  view.setUint16(6, view.getUint16(6, true) | 0x0008, true); // local flags
  const eocd = zip.length - 22;
  const central = view.getUint32(eocd + 16, true);
  view.setUint16(central + 8, view.getUint16(central + 8, true) | 0x0008, true);
  const [entry] = await unzip(zip);
  assertEquals(new TextDecoder().decode(entry.data).length, 1100);
});

Deno.test("an encrypted entry is refused by name", async () => {
  const zip = await buildZip([{ path: "secret.js", data: noise(64) }], DATE);
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const central = view.getUint32(zip.length - 22 + 16, true);
  view.setUint16(central + 8, 0x0001, true);
  await assertRejects(() => unzip(zip), Error, '"secret.js" is encrypted');
});

Deno.test("zip64 is refused", async () => {
  const zip = await buildZip([{ path: "a", data: noise(64) }], DATE);
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  view.setUint16(zip.length - 22 + 10, 0xffff, true); // entry count sentinel
  await assertRejects(() => unzip(zip), Error, "zip64");
});

Deno.test("an unknown compression method is refused", async () => {
  const zip = await buildZip([{ path: "a.bz2", data: noise(64) }], DATE);
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const central = view.getUint32(zip.length - 22 + 16, true);
  view.setUint16(central + 10, 12, true); // bzip2
  await assertRejects(() => unzip(zip), Error, "compression method 12");
});

Deno.test("a corrupted body fails its CRC instead of installing", async () => {
  const data = noise(256);
  const zip = await buildZip([{ path: "a.bin", data }], DATE);
  // Stored entry: its bytes sit right after the 30-byte local header + name.
  zip[30 + "a.bin".length + 10] ^= 0xff;
  await assertRejects(() => unzip(zip), Error, "CRC");
});

Deno.test("a truncated download is reported as such", async () => {
  const zip = await buildZip([{ path: "a.bin", data: noise(256) }], DATE);
  await assertRejects(
    () => unzip(zip.subarray(0, zip.length - 40)),
    Error,
    "not a zip archive",
  );
});

Deno.test("random bytes are not a zip", async () => {
  await assertRejects(() => unzip(noise(1000)), Error, "not a zip archive");
  await assertRejects(() => unzip(new Uint8Array(4)), Error, "not a zip");
});

Deno.test("an archive with a comment still finds its end record", async () => {
  const zip = await buildZip([{ path: "a", data: encoder.encode("a") }], DATE);
  const comment = encoder.encode("built by shmupX");
  const out = new Uint8Array(zip.length + comment.length);
  out.set(zip);
  out.set(comment, zip.length);
  new DataView(out.buffer).setUint16(zip.length - 2, comment.length, true);
  assertEquals((await unzip(out))[0].path, "a");
});

Deno.test("an empty archive is an empty list", async () => {
  assertEquals(await unzip(await buildZip([], DATE)), []);
});
