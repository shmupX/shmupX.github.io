// The packaged app's download-once store (lib/offline-store.ts): a romset or
// a track fetched once must play with the network gone, and nothing half-
// written or failed may ever be served as if it were the file.

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  bodyProblem,
  serveStored,
  storedPath,
  sweepPartials,
} from "../lib/offline-store.ts";

const UPSTREAM = "https://codemonkey.games";
const ROM = "/games/zunzunkyou-no-yabou/zunkyou.zip";

/** A fetch that answers from `files` and counts what it was asked. */
function fakeUpstream(files: Record<string, string>) {
  const asked: string[] = [];
  const impl = ((url: string) => {
    asked.push(url);
    const path = new URL(url).pathname;
    return Promise.resolve(
      path in files
        ? new Response(files[path], { status: 200 })
        : new Response("no", { status: 404 }),
    );
  }) as typeof fetch;
  return { asked, impl };
}

const offline =
  (() => Promise.reject(new TypeError("network is down"))) as typeof fetch;

const get = (path: string, headers: Record<string, string> = {}) =>
  new Request("http://127.0.0.1:51595" + path, { headers });

Deno.test("a file is downloaded once and then served with the network gone", async () => {
  const root = await Deno.makeTempDir();
  const up = fakeUpstream({ [ROM]: "PK-romset-bytes" });
  const first = await serveStored(get(ROM), ROM, {
    root,
    source: UPSTREAM + ROM,
    fetchImpl: up.impl,
  });
  assertEquals(first.status, 200);
  assertEquals(await first.text(), "PK-romset-bytes");
  assertEquals(up.asked, [UPSTREAM + ROM]);

  const again = await serveStored(get(ROM), ROM, {
    root,
    source: UPSTREAM + ROM,
    fetchImpl: offline,
  });
  assertEquals(again.status, 200);
  assertEquals(await again.text(), "PK-romset-bytes");
  // Kept at the path the page asked for.
  assertEquals(
    await Deno.readTextFile(
      join(
        root,
        "games",
        "zunzunkyou-no-yabou",
        "zunkyou.zip",
      ),
    ),
    "PK-romset-bytes",
  );
});

Deno.test("the install's one-byte probe downloads the whole board and answers 206", async () => {
  const root = await Deno.makeTempDir();
  const up = fakeUpstream({ [ROM]: "PK-romset-bytes" });
  const probe = await serveStored(get(ROM, { range: "bytes=0-0" }), ROM, {
    root,
    source: UPSTREAM + ROM,
    fetchImpl: up.impl,
  });
  assertEquals(probe.status, 206);
  assertEquals(await probe.text(), "P");
  const launch = await serveStored(get(ROM), ROM, {
    root,
    source: UPSTREAM + ROM,
    fetchImpl: offline,
  });
  assertEquals(await launch.text(), "PK-romset-bytes");
});

Deno.test("keys that ask at once share one download", async () => {
  const root = await Deno.makeTempDir();
  const track = "/games/2028-ai/assets/custom-bgm/614ade7f06c50da0.mp3";
  const up = fakeUpstream({ [track]: "ID3-track" });
  const answers = await Promise.all(
    [0, 1, 2, 3].map(() =>
      serveStored(get(track), track, {
        root,
        source: UPSTREAM + track,
        fetchImpl: up.impl,
      })
    ),
  );
  assertEquals(up.asked.length, 1);
  for (const res of answers) assertEquals(await res.text(), "ID3-track");
});

Deno.test("an upstream error is passed on and nothing is kept", async () => {
  const root = await Deno.makeTempDir();
  const missing = "/games/nope/nope.zip";
  const res = await serveStored(get(missing), missing, {
    root,
    source: UPSTREAM + missing,
    fetchImpl: fakeUpstream({}).impl,
  });
  assertEquals(res.status, 404);
  await res.body?.cancel();
  const down = await serveStored(get(missing), missing, {
    root,
    source: UPSTREAM + missing,
    fetchImpl: offline,
  });
  assertEquals(down.status, 502);
  assert((await down.text()).includes("network is down"));
  // No temp files left behind either.
  const left: string[] = [];
  for await (const e of Deno.readDir(root)) left.push(e.name);
  assertEquals(left, []);
});

Deno.test("a manifest is refreshed when the upstream answers and kept when it does not", async () => {
  const root = await Deno.makeTempDir();
  const manifest = "/games/2028-ai/assets/custom-bgm/manifest.json";
  const opts = (fetchImpl: typeof fetch) => ({
    root,
    source: UPSTREAM + manifest,
    fetchImpl,
  });
  await (await serveStored(
    get(manifest),
    manifest,
    opts(fakeUpstream({ [manifest]: '{"a":"1.mp3"}' }).impl),
  )).body?.cancel();
  const fresh = await serveStored(
    get(manifest),
    manifest,
    opts(fakeUpstream({ [manifest]: '{"a":"2.mp3"}' }).impl),
  );
  assertEquals(await fresh.text(), '{"a":"2.mp3"}');
  const held = await serveStored(get(manifest), manifest, opts(offline));
  assertEquals(await held.text(), '{"a":"2.mp3"}');
});

Deno.test("a path that could step outside the store is refused", () => {
  const root = "/data/offline";
  assertEquals(storedPath(root, "/games/../../etc/passwd"), null);
  assertEquals(storedPath(root, "/games/%2e%2e/x.zip"), null);
  assertEquals(storedPath(root, "/games/a%2Fb.zip"), null);
  assertEquals(storedPath(root, "/games//x.zip"), null);
  assertEquals(storedPath(root, "/games/"), null);
  assertEquals(
    storedPath(root, ROM),
    join(
      root,
      "games",
      "zunzunkyou-no-yabou",
      "zunkyou.zip",
    ),
  );
});

const sha256 = async (text: string) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
    ),
  ).map((b) => b.toString(16).padStart(2, "0")).join("");

Deno.test("a body that is not the file is never kept, and a held copy outlives it", async () => {
  const root = await Deno.makeTempDir();
  const opts = (body: string, headers: Record<string, string>) => ({
    root,
    source: UPSTREAM + ROM,
    fetchImpl:
      (() => Promise.resolve(new Response(body, { headers }))) as typeof fetch,
  });
  // A captive-portal-shaped page where the romset should be.
  const portal = await serveStored(
    get(ROM),
    ROM,
    opts("<html>sign in</html>", {
      "content-type": "text/html",
    }),
  );
  assertEquals(portal.status, 502);
  assert((await portal.text()).includes("a page came back"));
  // A body that does not hash to the deploy's ETag.
  const swapped = await serveStored(
    get(ROM),
    ROM,
    opts("PK-other", {
      etag: `W/"${await sha256("PK-romset-bytes")}"`,
    }),
  );
  assertEquals(swapped.status, 502);
  await swapped.body?.cancel();
  // The real one, with its ETag, is kept...
  const real = await serveStored(
    get(ROM),
    ROM,
    opts("PK-romset-bytes", {
      etag: `W/"${await sha256("PK-romset-bytes")}"`,
    }),
  );
  assertEquals(await real.text(), "PK-romset-bytes");
  // ...and nothing about the failures was left on disk.
  const dir = join(root, "games", "zunzunkyou-no-yabou");
  const names: string[] = [];
  for await (const e of Deno.readDir(dir)) names.push(e.name);
  assertEquals(names, ["zunkyou.zip"]);
});

Deno.test("what each kind of file must look like", () => {
  const res = (headers: Record<string, string> = {}) =>
    new Response(null, { headers });
  const body = (head: number[], size = 4) => ({
    sha256: "x",
    size,
    head: Uint8Array.from([...head, 0, 0, 0, 0, 0, 0, 0, 0].slice(0, 8)),
  });
  assertEquals(
    bodyProblem("/a/x.wasm", res(), body([0, 0x61, 0x73, 0x6d])),
    null,
  );
  assertEquals(
    bodyProblem("/a/x.wasm", res(), body([0x3c, 0x21])),
    "not WebAssembly",
  );
  assertEquals(bodyProblem("/a/x.zip", res(), body([0x50, 0x4b])), null);
  assertEquals(bodyProblem("/a/x.zip", res(), body([0x3c])), "not a zip");
  assertEquals(
    bodyProblem("/a/x.json", res(), { ...body([0x7b]), text: "{nope" }),
    "not JSON",
  );
  assertEquals(
    bodyProblem("/a/x.mp3", res({ "content-length": "10" }), body([0x49], 4)),
    "4 of 10 bytes arrived",
  );
  // A body fetch decompressed is longer than the length on the wire.
  assertEquals(
    bodyProblem(
      "/a/x.js",
      res({ "content-length": "10", "content-encoding": "gzip" }),
      body([0x76], 40),
    ),
    null,
  );
  assertEquals(
    bodyProblem(
      "/arcade/play.html",
      res({ "content-type": "text/html" }),
      body([0x3c]),
    ),
    null,
  );
});

Deno.test("stale temp files from a killed download are swept, live ones left", async () => {
  const root = await Deno.makeTempDir();
  const old = join(root, "games", "a.zip.1.part");
  const live = join(root, "games", "b.zip.2.part");
  await Deno.mkdir(join(root, "games"));
  await Deno.writeTextFile(old, "x");
  await Deno.writeTextFile(live, "y");
  const hourAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
  await Deno.utime(old, hourAgo, hourAgo);
  assertEquals(await sweepPartials(root), 1);
  const left: string[] = [];
  for await (const e of Deno.readDir(join(root, "games"))) left.push(e.name);
  assertEquals(left, ["b.zip.2.part"]);
  assertEquals(await sweepPartials(join(root, "missing")), 0);
});
