// The remote export queue has two ends that never import each other: the
// desktop worker (lib/export-worker.ts, Deno) and the browser module
// (static/export-queue.js, plain ESM the editor imports at runtime). They
// agree on database paths, on the shape of a job and on how the artifact
// bytes are chunked only by construction, so this pins the seams: the
// constants, the chunk codec end to end, and the pure helpers each side
// leans on to read the stream.

import {
  assert,
  assertEquals,
  assertNotEquals,
  assertRejects,
} from "@std/assert";
import { encodeBase64 } from "@std/encoding/base64";
import {
  applyAtPath,
  artifactKind,
  CHUNK_BYTES,
  CODE_ALPHABET,
  CODE_LENGTH,
  decodeJobRecord,
  EXPORT_DB,
  EXPORT_PATHS,
  type ExportJob,
  ExportWorker,
  formatBuilderCode,
  type JobInput,
  jobsToPrune,
  newBuilderCode,
  normalizeBuilderCode,
  parseSseChunk,
  pickNextJob,
} from "@shmupx/shmup-harbor/export-worker";
import * as client from "../static/export-queue.js";

Deno.test("both ends name the same database and paths", () => {
  assertEquals(client.EXPORT_DB, EXPORT_DB);
  assertEquals(client.EXPORT_PATHS, EXPORT_PATHS);
  assertEquals(client.CODE_ALPHABET, CODE_ALPHABET);
  assertEquals(client.CODE_LENGTH, CODE_LENGTH);
  // Chunks are cut by the sender and counted by the receiver, in both
  // directions now that a job can carry its own game up.
  assertEquals(client.CHUNK_BYTES, CHUNK_BYTES);
});

Deno.test("build codes are well-formed and normalise the same on both ends", () => {
  for (let i = 0; i < 50; i++) {
    const code = newBuilderCode();
    assertEquals(code.length, CODE_LENGTH);
    for (const ch of code) assert(CODE_ALPHABET.includes(ch), ch);
    assertEquals(normalizeBuilderCode(code), code);
    assertEquals(client.normalizeBuilderCode(code), code);
    // Typed with the dash, in lower case, with stray spaces.
    const typed = " " + formatBuilderCode(code).toLowerCase() + " ";
    assertEquals(normalizeBuilderCode(typed), code);
    assertEquals(client.normalizeBuilderCode(typed), code);
    assertEquals(client.formatBuilderCode(code), formatBuilderCode(code));
  }
  // Ambiguous glyphs are not in the alphabet, so a code carrying one is bad.
  assertEquals(normalizeBuilderCode("ABCD-EFG0"), "");
  assertEquals(normalizeBuilderCode("ABCDEFG"), "");
  assertEquals(client.normalizeBuilderCode("ABCD-EFG1"), "");
  assertNotEquals(newBuilderCode(), newBuilderCode());
});

Deno.test("SSE chunks split into events and keep the partial tail", () => {
  const one = parseSseChunk(
    'event: put\ndata: {"path":"/","data":null}\n\nevent: keep-alive\ndata: null\n\nevent: patch\ndata: {"pa',
  );
  assertEquals(one.events, [
    { event: "put", data: '{"path":"/","data":null}' },
    { event: "keep-alive", data: "null" },
  ]);
  assertEquals(one.rest, 'event: patch\ndata: {"pa');
  const two = parseSseChunk(one.rest + 'th":"/a","data":{"x":1}}\r\n\r\n');
  assertEquals(two.events, [
    { event: "patch", data: '{"path":"/a","data":{"x":1}}' },
  ]);
  assertEquals(two.rest, "");
  // Multi-line data joins with newlines; a bare blank block is not an event.
  const three = parseSseChunk("data: a\ndata: b\n\n\n\n");
  assertEquals(three.events, [{ event: "message", data: "a\nb" }]);
});

Deno.test("stream events apply to the mirror the same way on both ends", () => {
  const cases: [string, unknown, boolean][] = [
    ["/", { j1: { status: "queued", level: "foo" } }, false],
    ["/j2", { status: "queued", level: "bar" }, false],
    ["/j1", { status: "building", progress: "staging" }, true],
    ["/j2/progress", "uploading 3 / 8", false],
    ["/j1/artifacts/0", { name: "foo.iso", chunks: 2 }, false],
    ["/j2", null, false],
  ];
  let ts: Record<string, unknown> = {};
  let js: Record<string, unknown> = {};
  for (const [path, data, merge] of cases) {
    ts = applyAtPath(ts, path, data, merge);
    js = client.applyAtPath(js, path, data, merge) as Record<string, unknown>;
    assertEquals(js, ts, path);
  }
  assertEquals(ts, {
    j1: {
      status: "building",
      level: "foo",
      progress: "staging",
      artifacts: { 0: { name: "foo.iso", chunks: 2 } },
    },
  });
  // A root put with null empties the mirror rather than crashing it.
  assertEquals(applyAtPath(ts, "/", null, false), {});
  assertEquals(client.applyAtPath(js, "/", null, false), {});
});

function job(
  id: string,
  status: ExportJob["status"],
  extra: Partial<ExportJob> = {},
): ExportJob {
  return {
    id,
    level: "foo",
    platform: "ps2",
    requestedAt: 0,
    status,
    ...extra,
  };
}

Deno.test("the worker builds the oldest queued job first", () => {
  assertEquals(pickNextJob({}), null);
  const jobs = {
    "0000b-x": job("0000b-x", "queued"),
    "0000a-x": job("0000a-x", "done"),
    "0000c-x": job("0000c-x", "queued"),
    "00009-x": job("00009-x", "building"),
  };
  assertEquals(pickNextJob(jobs)?.id, "0000b-x");
  // Client ids sort the way the worker picks: by the time they were minted
  // (the suffix past the dash is noise, and two ids from one millisecond may
  // land in either order — that is fine, they are the same moment).
  const first = client.newJobId();
  const second = client.newJobId();
  const stamp = (id: string) => id.slice(0, id.indexOf("-"));
  assert(stamp(first) <= stamp(second), `${first} > ${second}`);
  assertEquals(stamp(first).length, 9);
});

Deno.test("finished jobs free their chunks and then expire", () => {
  const HOUR = 3600_000;
  const now = 100 * 24 * HOUR;
  const art = [{
    name: "a.iso",
    size: 1,
    kind: "iso",
    contentType: "",
    chunks: 1,
    chunkBytes: 1,
    path: "exportBlobs/x/0",
  }];
  const jobs = {
    fresh: job("fresh", "done", { finishedAt: now - HOUR, artifacts: art }),
    taken: job("taken", "done", {
      finishedAt: now - HOUR,
      artifacts: art,
      received: now,
    }),
    stale: job("stale", "done", {
      finishedAt: now - 30 * HOUR,
      artifacts: art,
    }),
    freed: job("freed", "done", {
      finishedAt: now - 30 * HOUR,
      artifacts: art,
      blobsFreed: true,
    }),
    ancient: job("ancient", "failed", { finishedAt: now - 8 * 24 * HOUR }),
    waiting: job("waiting", "queued", { requestedAt: now - 9 * 24 * HOUR }),
    running: job("running", "building", { startedAt: now - 9 * 24 * HOUR }),
  };
  assertEquals(jobsToPrune(jobs, now), {
    freeBlobs: ["taken", "stale"],
    remove: ["ancient"],
  });
});

Deno.test("the worker's chunks come back through the client's decoder", async () => {
  // Deterministic bytes that cross every base64 alignment.
  const size = CHUNK_BYTES * 2 + 12345;
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) bytes[i] = (i * 7 + (i >> 8)) & 0xff;
  const chunks = Math.ceil(size / CHUNK_BYTES);
  const store: Record<string, string> = {};
  for (let i = 0; i < chunks; i++) {
    store[String(i)] = encodeBase64(
      bytes.subarray(i * CHUNK_BYTES, Math.min((i + 1) * CHUNK_BYTES, size)),
    );
  }
  // Stand in for the database: the client GETs each chunk by index.
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    const m = url.match(/\/(\d+)\.json$/);
    const body = m ? store[m[1]] : undefined;
    return Promise.resolve(
      body === undefined
        ? new Response("null", { status: 404 })
        : Response.json(body),
    );
  }) as typeof fetch;
  try {
    const seen: number[] = [];
    const blob = await client.fetchQueuedArtifact(
      {
        artifacts: [{
          name: "a.bin",
          size,
          kind: "file",
          contentType: "application/octet-stream",
          chunks,
          chunkBytes: CHUNK_BYTES,
          path: "exportBlobs/j/0",
        }],
      },
      0,
      (got: number) => seen.push(got),
    );
    assertEquals(blob.size, size);
    assertEquals(new Uint8Array(await blob.arrayBuffer()), bytes);
    assertEquals(seen[seen.length - 1], size);
  } finally {
    globalThis.fetch = realFetch;
  }
});

Deno.test("artifact kinds come off the extension", () => {
  assertEquals(artifactKind("Foo.APK"), "apk");
  assertEquals(artifactKind("foo.AppImage"), "appimage");
  assertEquals(artifactKind("foo.iso"), "iso");
  assertEquals(artifactKind("foo"), "file");
  // The per-game Windows export is an .msi rather than a portable .exe, since
  // `deno desktop` has no single-file Windows output. Without its own kind it
  // would fall through to "file" and lose its download label.
  assertEquals(artifactKind("foo.msi"), "msi");
  assertEquals(artifactKind("FOO.MSI"), "msi");
  assertEquals(
    client.artifactActionLabel({ kind: "msi" }),
    "DOWNLOAD INSTALLER (.MSI)",
  );
  assertEquals(client.artifactActionLabel({ kind: "apk" }), "INSTALL APK");
  assertEquals(
    client.artifactActionLabel({ kind: "usb-zip" }),
    "DOWNLOAD USB FOLDER (.ZIP)",
  );
});

Deno.test("a worker is online while its heartbeat is fresh", () => {
  const now = 1_000_000_000;
  assert(!client.workerOnline(null, now));
  assert(client.workerOnline({ seenAt: now - 10_000 }, now));
  assert(!client.workerOnline({ seenAt: now - 120_000 }, now));
  // A clean stop outranks the last beat.
  assert(
    !client.workerOnline({ seenAt: now - 1000, stoppedAt: now - 500 }, now),
  );
  assert(
    client.workerOnline({ seenAt: now - 500, stoppedAt: now - 1000 }, now),
  );
  assertEquals(
    client.workerTargets({
      platforms: { ps2: true, android: true, ios: false },
    }),
    ["ANDROID", "PS2"],
  );
});

// ── A job that carries its own game ─────────────────────────────────────────
// A cart imported in the browser has no cloud level for the desktop to fetch,
// so queueExport() sends the record itself: gzipped, base64, 512 KB chunks
// under exportInputs/<jobId>, with the job written only once they have all
// landed. The worker reads them back with decodeJobRecord(). Both halves of
// that seam are here, against a database that is a plain object.

/** Enough incompressible bulk to cross the chunk boundary, as an atlas does. */
function bulkyRecord(bytes: number): Record<string, unknown> {
  const raw = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i += 65536) {
    crypto.getRandomValues(raw.subarray(i, Math.min(i + 65536, bytes)));
  }
  return {
    name: "Dez 2 - foo",
    enemylist: [[0, 1, 0], [2, 0, 3]],
    dezaemonTitle: { source: "cart" },
    atlasImageDataURL: "data:image/png;base64," + encodeBase64(raw),
  };
}

/** The database as an object, so a test can watch what order it is written in. */
function fakeDb() {
  const store: Record<string, unknown> = {};
  const calls: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const path = url.slice(EXPORT_DB.length + 1, -".json".length);
    const method = init?.method ?? "GET";
    calls.push(`${method} ${path}`);
    if (method === "PUT") {
      store[path] = JSON.parse(String(init?.body ?? "null"));
      return Promise.resolve(Response.json(store[path] ?? null));
    }
    if (method === "DELETE") {
      for (const key of Object.keys(store)) {
        if (key === path || key.startsWith(path + "/")) delete store[key];
      }
      return Promise.resolve(Response.json(null));
    }
    return Promise.resolve(Response.json(store[path] ?? null));
  }) as typeof fetch;
  return {
    store,
    calls,
    restore: () => {
      globalThis.fetch = real;
    },
  };
}

/**
 * The worker's own reader, which is the half under test — a build never gets
 * a record any other way, so a hand-rolled copy here would prove nothing.
 */
function readJobRecord(job: ExportJob): Promise<unknown> {
  const worker = new ExportWorker() as unknown as {
    fetchJobRecord(j: ExportJob, log: (line: string) => void): Promise<unknown>;
  };
  return worker.fetchJobRecord(job, () => {});
}

Deno.test("a job's own game goes up in chunks the worker reads back", async () => {
  // static/export-queue.js is browser code: `window` is only ever touched
  // behind a guard, but the identifier itself has to exist.
  const g = globalThis as unknown as Record<string, unknown>;
  const hadWindow = "window" in g;
  if (!hadWindow) g.window = globalThis;
  const db = fakeDb();
  try {
    const record = bulkyRecord(Math.round(CHUNK_BYTES * 1.5));
    const job = await client.queueExport({
      code: "ABCD-EFGH",
      level: "foo",
      platform: "ps2",
      levelRecord: record,
    });
    const input = job.record as JobInput;
    assertEquals(input.path, `${EXPORT_PATHS.inputs}/${job.id}`);
    assertEquals(input.chunkBytes, CHUNK_BYTES);
    assert(input.chunks >= 2, `one chunk only (${input.size} bytes)`);
    assertEquals(input.chunks, Math.ceil(input.size / CHUNK_BYTES));
    // Every chunk lands before the job does, so a desktop watching the queue
    // can never claim a job whose game is still on the wire.
    const queued = db.calls.indexOf(
      `PUT ${EXPORT_PATHS.queue}/ABCDEFGH/${job.id}`,
    );
    assert(queued >= 0, "the job was never written");
    for (let i = 0; i < input.chunks; i++) {
      const at = db.calls.indexOf(`PUT ${input.path}/${i}`);
      assert(at >= 0 && at < queued, `chunk ${i} landed after the job`);
    }
    assertEquals(await readJobRecord(job as unknown as ExportJob), record);
    // A chunk that never landed is the job's fault, not the build's, and the
    // worker says which one rather than handing runExport a broken level.
    delete db.store[`${input.path}/${input.chunks - 1}`];
    await assertRejects(
      () => readJobRecord(job as unknown as ExportJob),
      Error,
      `chunk ${input.chunks - 1} of ${input.chunks} is missing`,
    );
    // And dismissing the job takes the game back off the database with it.
    await client.dismissJob("ABCDEFGH", job.id);
    assertEquals(db.store[`${input.path}/0`], undefined);
    assertEquals(
      db.store[`${EXPORT_PATHS.queue}/ABCDEFGH/${job.id}`],
      undefined,
    );
  } finally {
    db.restore();
    if (!hadWindow) delete g.window;
  }
});

Deno.test("a plain cloud job carries no game, and an unpacked one still reads", async () => {
  const g = globalThis as unknown as Record<string, unknown>;
  const hadWindow = "window" in g;
  if (!hadWindow) g.window = globalThis;
  const db = fakeDb();
  try {
    const job = await client.queueExport({
      code: "ABCD-EFGH",
      level: "foo",
      platform: "android",
    });
    assertEquals(job.record, undefined);
    assert(!db.calls.some((c) => c.includes(EXPORT_PATHS.inputs)));
  } finally {
    db.restore();
    if (!hadWindow) delete g.window;
  }
  // A browser with no CompressionStream sends the JSON as it stands, and the
  // worker has to read that too.
  const plain = { name: "foo", enemylist: [] };
  const bytes = new TextEncoder().encode(JSON.stringify(plain));
  assertEquals(await decodeJobRecord(bytes, "none"), plain);
  assertEquals(await decodeJobRecord(bytes, undefined), plain);
  // Garbage is a bad job, and says so rather than reaching the builder.
  await assertRejects(
    () => decodeJobRecord(new TextEncoder().encode("{nope"), "none"),
    Error,
    "not readable JSON",
  );
});
