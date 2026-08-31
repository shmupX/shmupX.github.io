// The ZIP writer, read back the way an unzipper reads it.
//
// lib/ps2/zip.ts is what `--zip` hands a browser download or a chat window, so
// the thing that matters is that a real unzipper can walk it: the central
// directory has to agree with every local header, the offsets it records have
// to land on those headers, and each entry's bytes have to come back out
// unchanged whether the entry was deflated or stored.

import { assert, assertEquals } from "@std/assert";
import { buildZip, crc32 } from "../lib/ps2/zip.ts";

const encoder = new TextEncoder();
const DATE = new Date("2000-03-04T00:00:00Z");

/** Incompressible: the packer must fall back to STORE for this one. */
function noise(n: number): Uint8Array {
  const out = new Uint8Array(n);
  let x = 0x12345678;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    out[i] = (x >>> 16) & 0xff;
  }
  return out;
}

async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  const stream = new Blob([copy]).stream().pipeThrough(
    new DecompressionStream("deflate-raw"),
  );
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Walk the archive the way an unzipper does — end record, then the central
 * directory, then each entry's local header — and hand back what it holds.
 */
async function readZip(
  zip: Uint8Array,
): Promise<Map<string, { data: Uint8Array; method: number }>> {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const decoder = new TextDecoder();
  let eocd = -1;
  for (let i = zip.length - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  assert(eocd >= 0, "no end-of-central-directory record");
  const count = view.getUint16(eocd + 10, true);
  let at = view.getUint32(eocd + 16, true);
  assertEquals(
    view.getUint32(eocd + 12, true),
    eocd - at,
    "the central directory's recorded size must reach the end record",
  );

  const out = new Map<string, { data: Uint8Array; method: number }>();
  for (let n = 0; n < count; n++) {
    assertEquals(view.getUint32(at, true), 0x02014b50, "central header magic");
    const method = view.getUint16(at + 10, true);
    const sum = view.getUint32(at + 16, true);
    const compressed = view.getUint32(at + 20, true);
    const size = view.getUint32(at + 24, true);
    const nameLen = view.getUint16(at + 28, true);
    const offset = view.getUint32(at + 42, true);
    const name = decoder.decode(zip.subarray(at + 46, at + 46 + nameLen));
    at += 46 + nameLen + view.getUint16(at + 30, true) +
      view.getUint16(at + 32, true);

    // The local header the directory points at must describe the same entry.
    assertEquals(
      view.getUint32(offset, true),
      0x04034b50,
      "local header magic",
    );
    assertEquals(view.getUint16(offset + 8, true), method, `${name}: method`);
    assertEquals(view.getUint32(offset + 14, true), sum, `${name}: crc`);
    assertEquals(view.getUint32(offset + 22, true), size, `${name}: size`);
    const body = offset + 30 + view.getUint16(offset + 26, true) +
      view.getUint16(offset + 28, true);
    const stored = zip.subarray(body, body + compressed);
    const data = method === 8 ? await inflateRaw(stored) : stored;
    assertEquals(crc32(data), sum, `${name}: content does not match its crc`);
    out.set(name, { data, method });
  }
  return out;
}

Deno.test("every entry comes back out byte for byte", async () => {
  const text = encoder.encode("console.log(1)\n".repeat(200));
  const entries = [
    { path: "App/main.js", data: text },
    { path: "App/assets/level.json", data: encoder.encode("{}") },
    { path: "App/assets/sounds/a.adp", data: noise(4096) },
    { path: "App/empty", data: new Uint8Array(0) },
  ];
  const read = await readZip(await buildZip(entries, DATE));
  assertEquals(read.size, entries.length);
  for (const entry of entries) {
    assertEquals(read.get(entry.path)!.data, entry.data, entry.path);
  }
});

Deno.test("compression is used only when it pays", async () => {
  const read = await readZip(
    await buildZip([
      { path: "text", data: encoder.encode("a".repeat(5000)) },
      { path: "noise", data: noise(4096) },
    ], DATE),
  );
  assertEquals(read.get("text")!.method, 8, "repetitive text should deflate");
  assertEquals(read.get("noise")!.method, 0, "noise should be stored as-is");
});

Deno.test("the same tree twice is the same archive", async () => {
  const entries = [{ path: "App/main.js", data: encoder.encode("hello") }];
  assertEquals(
    await buildZip(entries, DATE),
    await buildZip(entries, DATE),
    "a rebuild must be reproducible — nothing may read the clock",
  );
});

Deno.test("an empty archive is still a valid one", async () => {
  assertEquals((await readZip(await buildZip([], DATE))).size, 0);
});
