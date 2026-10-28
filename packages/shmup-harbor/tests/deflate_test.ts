// A corrupt zlib stream must fail the inflate that was asked for and nothing
// else. pump() writes the bytes and reads the result concurrently; when the
// readable errors first, the write's promise rejects too, and if nobody is
// listening to it any more Deno reports an unhandled rejection and exits —
// which on Deploy is the isolate serving every other request. art.ts hands
// decodePng PNGs read from an open-write catalog, so one bad atlas would do it.

import { assertEquals, assertRejects } from "@std/assert";
import { deflate, inflate } from "../lib/ps2/deflate.ts";

Deno.test("a corrupt deflate stream rejects the inflate, and leaves no unhandled rejection behind", async () => {
  const good = await deflate(new TextEncoder().encode("x".repeat(4096)));
  const bad = good.slice();
  // Keep the zlib header, wreck the deflate blocks after it.
  for (let i = 2; i < bad.length; i++) bad[i] ^= 0xa5;

  let unhandled: unknown = null;
  const onUnhandled = (ev: PromiseRejectionEvent) => {
    unhandled = ev.reason;
    ev.preventDefault();
  };
  globalThis.addEventListener("unhandledrejection", onUnhandled);
  try {
    await assertRejects(() => inflate(bad));
    // Give a stray rejection a few turns of the event loop to surface.
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 10));
  } finally {
    globalThis.removeEventListener("unhandledrejection", onUnhandled);
  }
  assertEquals(unhandled, null);

  // And a good stream still round-trips.
  assertEquals(
    new TextDecoder().decode(await inflate(good)),
    "x".repeat(4096),
  );
});
