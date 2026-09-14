// routes/api/update.ts is where an invisible refusal becomes something a
// player can read.
//
// The updater polls on the runtime's own timer, patches a dylib nobody sees and
// takes effect on a launch that has not happened yet, so "it will never update
// again" and "it is current" look identical from the outside. The one thing
// this route must never do is answer as though updates were fine when
// lib/self-update.ts has refused them — and the one thing it must never claim
// is a check, since `Deno.autoUpdate` reports nothing per poll.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { handler } from "../routes/api/update.ts";

// The handler only ever reads ctx.req, so that is the whole fixture. Narrowing
// it here rather than building a Fresh context keeps the test about the answer.
const route = handler as unknown as {
  GET(ctx: { req: Request }): Response | Promise<Response>;
};
const get = (init?: RequestInit): Promise<Response> =>
  Promise.resolve(
    route.GET({ req: new Request("http://127.0.0.1:8787/api/update", init) }),
  );

Deno.test("a cross-site page cannot read which build this is", async () => {
  const res = await get({ headers: { "sec-fetch-site": "cross-site" } });
  assertEquals(res.status, 403);
  await res.body?.cancel();
});

Deno.test("a checkout says why it is off, rather than saying nothing", async () => {
  // The test suite is a source checkout: no Deno.desktopVersion, so there is
  // nothing to update FROM and the refusal is the whole answer. `started` is
  // false because desktop.ts never ran, which is what keeps the dashboard from
  // showing a row about a binary this is not.
  const res = await get();
  assertEquals(res.status, 200);
  const body = await res.json();
  assert(body.ok);
  assertEquals(body.enabled, false);
  assertEquals(body.armed, false);
  assertEquals(body.started, false);
  assertEquals(body.url, null);
  assertStringIncludes(body.reason, "no updater");
});

Deno.test("nothing in the answer claims a check that never happened", async () => {
  // armedAt, not lastCheckedAt. The runtime has no per-poll callback, so an
  // armed channel whose manifest 404s every hour is indistinguishable from one
  // that is up to date; a field named for the second would be a fiction.
  const body = await (await get()).json();
  assert("armedAt" in body);
  assert(!("lastCheckedAt" in body));
  assert(!("lastChecked" in body));
  // And it is never cached: the whole point is to be re-read.
  const res = await get();
  assertEquals(res.headers.get("cache-control"), "no-store");
  await res.body?.cancel();
});
