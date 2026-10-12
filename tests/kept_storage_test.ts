// What a packaged app keeps of the page's localStorage (lib/kept-storage.ts):
// the installed cores and the arcade shelf have to be there at the next launch,
// and a slow write from an old page must not put back what a newer one removed.

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  applyKept,
  injectKeptStorage,
  KEPT_KEYS,
  keptStorageScript,
  readKept,
} from "../lib/kept-storage.ts";

Deno.test("a write keeps the kept keys, drops the rest, and an older write is ignored", async () => {
  const file = join(await Deno.makeTempDir(), "kept-storage.json");
  assertEquals(await readKept(file), { stamp: 0, values: {} });
  assertEquals(
    await applyKept(file, {
      stamp: 10,
      values: { "shmupx-emulators": '["arcade"]', "not-ours": "x" },
    }),
    204,
  );
  assertEquals((await readKept(file)).values, {
    "shmupx-emulators": '["arcade"]',
  });
  // An older page's late write does not undo the newer one.
  await applyKept(file, { stamp: 5, values: { "shmupx-emulators": "[]" } });
  assertEquals((await readKept(file)).values["shmupx-emulators"], '["arcade"]');
  // null removes.
  await applyKept(file, { stamp: 11, values: { "shmupx-emulators": null } });
  assertEquals((await readKept(file)).values, {});
  assertEquals(await applyKept(file, { values: {} }), 400);
});

Deno.test("concurrent writes land one at a time and the newest wins", async () => {
  const file = join(await Deno.makeTempDir(), "kept-storage.json");
  await Promise.all(
    [3, 1, 4, 2].map((n) =>
      applyKept(file, {
        stamp: n,
        values: { "shmupx-arcade-shelf": String(n) },
      })
    ),
  );
  assertEquals((await readKept(file)).values["shmupx-arcade-shelf"], "4");
});

Deno.test("the script goes first in <head> and cannot be closed early by a saved value", () => {
  const state = { stamp: 1, values: { "shmupx-arcade-shelf": "</script><b>" } };
  const html = injectKeptStorage(
    '<!doctype html><html><head lang="x"><title>t</title><script src="/app.js"></script></head></html>',
    state,
  );
  assert(html.startsWith('<!doctype html><html><head lang="x"><script>'));
  assert(html.indexOf("/app.js") > html.indexOf("Storage.prototype"));
  assertEquals(keptStorageScript(state).split("</script>").length, 2);
});

// A browser-shaped Storage: its methods live on the prototype, which is what the
// script patches. (Deno's own Storage answers through a Proxy that bypasses a
// patched prototype, so it cannot stand in for a browser's here.)
class FakeStorage {
  #m = new Map<string, string>();
  getItem(k: string) {
    return this.#m.has(k) ? this.#m.get(k)! : null;
  }
  setItem(k: string, v: string) {
    this.#m.set(String(k), String(v));
  }
  removeItem(k: string) {
    this.#m.delete(String(k));
  }
  clear() {
    this.#m.clear();
  }
}

Deno.test("in the page it restores what is missing and sends every change back", () => {
  const sent: { stamp: number; values: Record<string, unknown> }[] = [];
  const g = globalThis as Record<string, unknown>;
  const saved = { window: g.window, fetch: g.fetch, Storage: g.Storage };
  const ls = new FakeStorage();
  ls.setItem("shmupx-emulators", '["nes"]'); // already here: left alone
  g.Storage = FakeStorage;
  g.window = { localStorage: ls };
  g.fetch = (_url: string, init: RequestInit) => {
    sent.push(JSON.parse(String(init.body)));
    return Promise.resolve(new Response(null, { status: 204 }));
  };
  try {
    const script = keptStorageScript({
      stamp: 1,
      values: {
        "shmupx-emulators": '["arcade"]',
        "shmupx-arcade-shelf": "[1]",
      },
    });
    new Function(script.replace(/^<script>|<\/script>$/g, ""))();
    assertEquals(ls.getItem("shmupx-emulators"), '["nes"]');
    assertEquals(ls.getItem("shmupx-arcade-shelf"), "[1]");
    assertEquals(sent.length, 0, "restoring is not a change");
    ls.setItem("shmupx-arcade-shelf", "[1,2]");
    ls.setItem("unrelated", "x");
    ls.removeItem("shmupx-emulators");
    assertEquals(sent.length, 2);
    assertEquals(sent[1].values, {
      "shmupx-emulators": null,
      "shmupx-arcade-shelf": "[1,2]",
    });
    assert(sent[1].stamp >= sent[0].stamp && sent[0].stamp > 0);
    assertEquals(Object.keys(sent[1].values).sort(), [...KEPT_KEYS].sort());
  } finally {
    g.Storage = saved.Storage;
    g.window = saved.window;
    g.fetch = saved.fetch;
  }
});
