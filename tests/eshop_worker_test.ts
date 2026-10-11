// The service worker an eShop install waits on, under Deno with a stubbed
// navigator.serviceWorker.
//
// Two rules, both learned from UPDATE on a page a hard reload had left outside
// its worker: readyEmuWorker waits for the page to be claimed only when the
// register() it just made is the one that will do the claiming — a
// registration that was already active has no claim coming, and waiting on
// it is eight seconds of "⬇ 0%" before nothing — and installWebGame goes on
// to the download whether or not this page is controlled, since the files
// go into Cache Storage from here and the game's own frame is claimed by
// itself. Each case imports a fresh copy of the module (a query string makes
// one): the registration promise is memoised per module.

import { assert, assertEquals, assertRejects } from "@std/assert";

interface Reg {
  installing: object | null;
  waiting: object | null;
  active: object | null;
}

/** navigator.serviceWorker as the two code paths see it. */
function stubServiceWorker(
  { fresh, controlled }: { fresh: boolean; controlled: boolean },
) {
  const reg: Reg = {
    installing: fresh ? {} : null,
    waiting: null,
    active: fresh ? null : {},
  };
  const listeners: (() => void)[] = [];
  const sw = {
    controller: controlled ? {} : null,
    register: () => Promise.resolve(reg),
    ready: Promise.resolve(reg),
    addEventListener: (type: string, cb: () => void) => {
      if (type === "controllerchange") listeners.push(cb);
    },
    removeEventListener: () => {},
    /** The worker activating and claiming the page. */
    claim() {
      sw.controller = {};
      for (const cb of listeners.splice(0)) cb();
    },
  };
  Object.defineProperty(navigator, "serviceWorker", {
    value: sw,
    configurable: true,
  });
  return {
    reg,
    sw,
    restore: () => {
      // deno-lint-ignore no-explicit-any
      delete (navigator as any).serviceWorker;
    },
  };
}

let instance = 0;
async function freshPs2Library() {
  const url = new URL(
    `../static/ps2-library.js?instance=${++instance}`,
    import.meta.url,
  );
  return await import(url.href) as {
    readyEmuWorker(): Promise<Reg | null>;
  };
}

Deno.test("readyEmuWorker does not wait on a registration that was already active", async () => {
  const { reg, restore } = stubServiceWorker({
    fresh: false,
    controlled: false,
  });
  try {
    const lib = await freshPs2Library();
    const t0 = performance.now();
    assertEquals(await lib.readyEmuWorker(), reg);
    assert(
      performance.now() - t0 < 1000,
      "waited for a claim that was never coming",
    );
  } finally {
    restore();
  }
});

Deno.test("readyEmuWorker waits for the worker it just put in to claim the page", async () => {
  const { reg, sw, restore } = stubServiceWorker({
    fresh: true,
    controlled: false,
  });
  try {
    const lib = await freshPs2Library();
    let settled = false;
    const ready = lib.readyEmuWorker().then((r) => {
      settled = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 50));
    assertEquals(settled, false, "resolved before the page was claimed");
    sw.claim();
    assertEquals(await ready, reg);
  } finally {
    restore();
  }
});

Deno.test("readyEmuWorker answers at once on a page the worker already controls", async () => {
  const { reg, restore } = stubServiceWorker({
    fresh: false,
    controlled: true,
  });
  try {
    const lib = await freshPs2Library();
    assertEquals(await lib.readyEmuWorker(), reg);
  } finally {
    restore();
  }
});

Deno.test("installWebGame goes on to the download on a page outside its worker", async () => {
  const { restore } = stubServiceWorker({ fresh: false, controlled: false });
  const realFetch = globalThis.fetch;
  const asked: string[] = [];
  globalThis.fetch = ((input: string | URL | Request) => {
    asked.push(String(input));
    return Promise.resolve(new Response("gone", { status: 404 }));
  }) as typeof fetch;
  try {
    const url = new URL(
      "../static/eshop-library.js?instance=install",
      import.meta.url,
    );
    const lib = await import(url.href) as {
      installWebGame(
        entry: Record<string, unknown>,
        opts: Record<string, unknown>,
      ): Promise<unknown>;
    };
    const entry = {
      id: "2019",
      kind: "web",
      name: "2019",
      source: "url",
      downloadUrl: "/games/2019-web.zip",
      entry: "index.html",
      date: "10.08.26",
    };
    // Before: "the service worker is registered but is not in front of this
    // page … reload the page and try again", and no download at all.
    const err = await assertRejects(
      () => lib.installWebGame(entry, { force: true }),
      Error,
    );
    assert(
      /2019-web\.zip answered HTTP 404/.test(err.message),
      `stopped short of the download: ${err.message}`,
    );
    assertEquals(asked, ["/games/2019-web.zip"]);
  } finally {
    globalThis.fetch = realFetch;
    restore();
  }
});
