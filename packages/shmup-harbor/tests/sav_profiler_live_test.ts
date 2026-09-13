// The `--live` third pane of the sav-profiler, in the parts that do not need
// a browser.
//
// The end-to-end run is sav_profiler_e2e_test.ts, gated behind
// SAV_PROFILER_E2E=1 because it wants Mednafen, the BIOS, the disc, the
// Accessibility grant and now a second Chrome. What is left over is still
// worth pinning: the level interception's request handling, the N-pane
// stacking, and the promise that a run WITHOUT --live is unchanged.

import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import {
  interceptLevel,
  LEVEL_PATH,
  LIVE_URL,
} from "../tools/sav-profiler/lib/web.ts";
import { pair, row } from "../tools/sav-profiler/lib/report.ts";
import { defaults, profile } from "../tools/sav-profiler/main.ts";
import { newRaster } from "../lib/ps2/png.ts";

/** A Cdp stand-in: records sends, and lets a test fire a paused request. */
function fakeCdp() {
  const sent: { method: string; params: Record<string, unknown> }[] = [];
  const handlers = new Map<string, ((p: Record<string, unknown>) => void)[]>();
  return {
    sent,
    // deno-lint-ignore require-await
    async send(method: string, params: Record<string, unknown> = {}) {
      sent.push({ method, params });
      return {} as Record<string, unknown>;
    },
    on(method: string, h: (p: Record<string, unknown>) => void) {
      handlers.set(method, [...(handlers.get(method) ?? []), h]);
    },
    off(method: string, h: (p: Record<string, unknown>) => void) {
      handlers.set(
        method,
        (handlers.get(method) ?? []).filter((x) => x !== h),
      );
    },
    fire(method: string, params: Record<string, unknown>) {
      for (const h of handlers.get(method) ?? []) h(params);
    },
    handlerCount(method: string) {
      return (handlers.get(method) ?? []).length;
    },
  };
}

// deno-lint-ignore no-explicit-any
const asCdp = (f: ReturnType<typeof fakeCdp>) => f as any;

Deno.test("the deployed page's level fetch is fulfilled with the cart's record", async () => {
  const cdp = fakeCdp();
  const record = { name: "a level", stage0: { enemylist: [] } };
  const level = await interceptLevel(asCdp(cdp), record);

  // Armed at the REQUEST stage for that one URL — the response never has to
  // be paused, because it is replaced wholesale.
  const enable = cdp.sent.find((s) => s.method === "Fetch.enable");
  assert(enable, "Fetch.enable was not sent");
  const patterns = enable.params.patterns as Record<string, unknown>[];
  assertStrictEquals(patterns.length, 1);
  assertStrictEquals(patterns[0].requestStage, "Request");
  assert(String(patterns[0].urlPattern).includes(LEVEL_PATH));

  cdp.sent.length = 0;
  cdp.fire("Fetch.requestPaused", {
    requestId: "1",
    request: { url: `${LIVE_URL.replace("/games/2028-ai", "")}${LEVEL_PATH}` },
  });
  await new Promise((r) => setTimeout(r, 0));
  const fulfil = cdp.sent.find((s) => s.method === "Fetch.fulfillRequest");
  assert(fulfil, "the level request was not fulfilled");
  assertStrictEquals(fulfil.params.responseCode, 200);
  assertStrictEquals(atob(String(fulfil.params.body)), JSON.stringify(record));
  assertStrictEquals(level.served(), 1);

  await level.stop();
  assertStrictEquals(cdp.handlerCount("Fetch.requestPaused"), 0);
  assert(cdp.sent.some((s) => s.method === "Fetch.disable"));
});

Deno.test("anything that is not the level goes to the network untouched", async () => {
  const cdp = fakeCdp();
  const level = await interceptLevel(asCdp(cdp), { name: "x" });
  cdp.sent.length = 0;
  cdp.fire("Fetch.requestPaused", {
    requestId: "7",
    request: { url: "https://codemonkey.games/games/2028-ai/game.bundle.js" },
  });
  await new Promise((r) => setTimeout(r, 0));
  // The bundle, the atlases and the fonts must come from Deploy — serving
  // them ourselves would make the pane a copy of the local runtime.
  assert(cdp.sent.some((s) => s.method === "Fetch.continueRequest"));
  assert(!cdp.sent.some((s) => s.method === "Fetch.fulfillRequest"));
  assertStrictEquals(level.served(), 0);
  await level.stop();
});

Deno.test("a fulfil that fails is not counted as served", async () => {
  // The pane would be playing whatever the deploy serves, which is NOT this
  // cart — reporting it as served would make the comparison a lie.
  const cdp = fakeCdp();
  const send = cdp.send.bind(cdp);
  // deno-lint-ignore require-await
  cdp.send = async (method: string, params: Record<string, unknown> = {}) => {
    if (method === "Fetch.fulfillRequest") throw new Error("message too large");
    return send(method, params);
  };
  const level = await interceptLevel(asCdp(cdp), { name: "x" });
  cdp.fire("Fetch.requestPaused", {
    requestId: "3",
    request: { url: `https://codemonkey.games${LEVEL_PATH}` },
  });
  await new Promise((r) => setTimeout(r, 0));
  assertStrictEquals(level.served(), 0);
  assertStrictEquals(level.error(), "message too large");
  await level.stop();
});

Deno.test("row() stacks any number of panes, and two are what pair() gave", () => {
  const red = newRaster(604, 480);
  const green = newRaster(256, 480);
  const blue = newRaster(256, 480);
  const two = row([red, green], 480);
  // 604 + gap + 256
  assertStrictEquals(two.width, 604 + 8 + 256);
  assertStrictEquals(two.height, 480);
  // pair() is now a wrapper, so it must agree exactly
  const viaPair = pair(red, green, 480);
  assertEquals(
    { w: viaPair.width, h: viaPair.height },
    { w: two.width, h: two.height },
  );
  const three = row([red, green, blue], 480);
  assertStrictEquals(three.width, 604 + 8 + 256 + 8 + 256);
  assertStrictEquals(three.height, 480);
  // and one pane is just that pane
  assertStrictEquals(row([green], 480).width, 256);
  assertStrictEquals(row([], 480).width, 0);
});

Deno.test("a mortal live run against production is refused, not submitted", async () => {
  // ?god=1 is the only thing keeping a live run out of the production
  // leaderboard, so --no-god against codemonkey.games must not start at all.
  const opts = {
    ...defaults(),
    sav: "packages/shmup-engine/fixtures/does-not-matter.sav",
    live: true,
    god: false,
    saturn: false,
    web: false,
    log: () => {},
  };
  const err = await profile(opts).then(() => null, (e) => e as Error);
  assert(err, "a mortal production run should have been refused");
  assert(
    /leaderboard/i.test(err.message),
    `expected the leaderboard refusal, got: ${err.message}`,
  );
  // ...and a staging host is nobody's production board, so it is allowed
  // through this check (it fails later, on the missing .sav).
  const staging = await profile({
    ...opts,
    liveUrl: "https://staging.example.test/games/2028-ai",
  }).then(() => null, (e) => e as Error);
  assert(staging, "expected the run to fail on the missing sav");
  assert(
    !/leaderboard/i.test(staging.message),
    `staging should not hit the leaderboard guard, got: ${staging.message}`,
  );
});

Deno.test("the live pane is off unless it is asked for", () => {
  // It needs the network, so a default run — including the in-page
  // ?debug=1 path, which spreads defaults() — must never reach for it.
  const d = defaults();
  assertStrictEquals(d.live, false);
  assertStrictEquals(d.liveUrl, LIVE_URL);
  assert(LIVE_URL.startsWith("https://codemonkey.games/"));
});
