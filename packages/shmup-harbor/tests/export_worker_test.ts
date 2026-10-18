// What keeps a pre-split desktop off the jobs it would build wrong.
//
// A version-1 worker (every packaged desktop installed before the shmupX/
// split) claims any job whose status is "queued" and reads a level name from
// cmg's root-level copy; the apps it builds carry its own pre-split runtime.
// So a job that needs version 2 is written as "waiting" with `minWorker`, and
// the version-2 worker's claims and re-queues are shaped so the old one never
// gets near it either — not when it shares the BUILD CODE, not when it opens
// mid-build, not when it prunes. The version-1 half of each test is the old
// worker's own code out of git (support/export_worker_rig.ts).

import { assert, assertEquals } from "@std/assert";
import {
  claimedHere,
  claimMark,
  EXPORT_PATHS,
  type ExportJob,
  ExportWorker,
  jobClaimable,
  jobMinWorker,
  jobsToPrune,
  jobUnclaimed,
  pickNextJob,
  requeueStatus,
  versionSeenKey,
  WAITING_STATUS,
  WORKER_VERSION,
} from "../lib/export-worker.ts";
import {
  driveWorker,
  fakeRtdb,
  loadV1Worker,
} from "./support/export_worker_rig.ts";

const V1 = await loadV1Worker();
const CODE = "ABCDEFGH";
const HOUR = 3600_000;

function job(
  id: string,
  status: ExportJob["status"],
  extra: Partial<ExportJob> = {},
): ExportJob {
  return {
    id,
    level: "foo",
    platform: "android",
    rtdbRoot: "shmupX",
    requestedAt: 0,
    status,
    progress: "waiting for the desktop",
    attempts: 0,
    ...extra,
  };
}
/** A job as static/export-queue.js writes one that needs a current worker. */
const held = (id: string, extra: Partial<ExportJob> = {}) =>
  job(id, "waiting", { minWorker: 2, ...extra });
const jobPath = (id: string) => `${EXPORT_PATHS.queue}/${CODE}/${id}`;

Deno.test("a held job asks for version 2, and only a worker that new claims it", () => {
  assertEquals(WAITING_STATUS, "waiting");
  assertEquals(jobMinWorker(job("a", "queued")), 1);
  assertEquals(jobMinWorker(held("b")), 2);
  // "waiting" was never written without minWorker, but if it were it would
  // still be a job no version-1 worker may touch.
  assertEquals(jobMinWorker(job("c", "waiting")), 2);
  assertEquals(jobMinWorker(job("d", "building", { minWorker: 2 })), 2);
  assert(jobUnclaimed("queued") && jobUnclaimed("waiting"));
  assert(!jobUnclaimed("building") && !jobUnclaimed(undefined));
  assert(jobClaimable(job("a", "queued")));
  assert(jobClaimable(held("b")));
  assert(!jobClaimable(held("c", { minWorker: WORKER_VERSION + 1 })));
  assert(!jobClaimable(job("d", "building")));
  assert(!jobClaimable(null));

  // Oldest first across both statuses; one for a newer worker is passed over.
  assertEquals(
    pickNextJob({
      "0000c-x": job("0000c-x", "queued"),
      "0000a-x": held("0000a-x", { minWorker: WORKER_VERSION + 1 }),
      "0000b-x": held("0000b-x"),
    })?.id,
    "0000b-x",
  );
});

Deno.test("a claim is tagged so version 1 cannot recover it, and goes back as it came", () => {
  assertEquals(claimMark(CODE, held("a")), `${CODE}:v2`);
  assertEquals(claimMark(CODE, job("b", "queued")), `${CODE}:v1`);
  assert(
    claimMark(CODE, held("a")) !== CODE,
    "version 1 matches the bare code",
  );
  // This worker recovers its own marks for what it can build, and a bare
  // code — a build that died with the old app on this code.
  assert(claimedHere(`${CODE}:v1`, CODE));
  assert(claimedHere(`${CODE}:v2`, CODE));
  assert(claimedHere(CODE, CODE));
  assert(!claimedHere(`${CODE}:v${WORKER_VERSION + 1}`, CODE));
  assert(!claimedHere("ZZZZZZZZ:v2", CODE));
  assert(!claimedHere(undefined, CODE));
  assertEquals(requeueStatus(held("a")), "waiting");
  assertEquals(
    requeueStatus(job("b", "building", { minWorker: 2 })),
    "waiting",
  );
  assertEquals(requeueStatus(job("c", "queued")), "queued");
  assertEquals(versionSeenKey(WORKER_VERSION), `seenAtV${WORKER_VERSION}`);
});

Deno.test("a held job is not pruned while it waits", () => {
  const now = 100 * 24 * HOUR;
  assertEquals(
    jobsToPrune({
      held: held("held", { requestedAt: now - 9 * 24 * HOUR }),
      done: job("done", "done", { finishedAt: now - 8 * 24 * HOUR }),
    }, now),
    { freeBlobs: [], remove: ["done"] },
  );
});

Deno.test("the worker claims a held job, keeps its version, and refuses a newer one's", async () => {
  const db = fakeRtdb();
  try {
    db.set(jobPath("0000a-x"), job("0000a-x", "waiting")); // no minWorker
    db.set(jobPath("0000b-x"), held("0000b-x", { minWorker: 3 }));
    const w = driveWorker({ ExportWorker }, CODE, "New Mac");
    assert(await w.claim(job("0000a-x", "waiting")));
    const claimed = db.get(jobPath("0000a-x")) as ExportJob;
    assertEquals(claimed.status, "building");
    assertEquals(claimed.worker, `${CODE}:v2`);
    assertEquals(claimed.minWorker, 2, "the claim writes down what it needs");
    assertEquals(claimed.workerName, "New Mac");
    // The claim reads the job again rather than trusting the stream.
    assert(!await w.claim(held("0000b-x")));
    assertEquals((db.get(jobPath("0000b-x")) as ExportJob).status, "waiting");
  } finally {
    db.restore();
  }
});

Deno.test("a restarted worker puts each build back with the status it was queued with", async () => {
  const db = fakeRtdb();
  try {
    db.set(
      jobPath("held"),
      held("held", { status: "building", worker: `${CODE}:v2` }),
    );
    db.set(jobPath("legacy"), job("legacy", "building", { worker: CODE }));
    db.set(
      jobPath("newer"),
      held("newer", { status: "building", minWorker: 3, worker: `${CODE}:v3` }),
    );
    db.set(
      jobPath("twice"),
      held("twice", { status: "building", worker: `${CODE}:v2`, attempts: 1 }),
    );
    const w = driveWorker({ ExportWorker }, CODE);
    await w.recoverStale();
    const at = (id: string) => db.get(jobPath(id)) as ExportJob;
    assertEquals(at("held").status, "waiting");
    assertEquals(at("held").attempts, 1);
    assertEquals(at("legacy").status, "queued");
    assertEquals(
      at("newer").status,
      "building",
      "a newer desktop's build is its own",
    );
    assertEquals(at("twice").status, "failed");
  } finally {
    db.restore();
  }
});

Deno.test("a build stopped mid-way goes back as waiting, not queued", async () => {
  const db = fakeRtdb();
  try {
    const j = held("stopped", { platform: "no-such-target" });
    db.set(jobPath("stopped"), {
      ...j,
      status: "building",
      worker: `${CODE}:v2`,
    });
    const w = driveWorker({ ExportWorker }, CODE);
    const internals = w as unknown as Record<string, unknown>;
    const abort = new AbortController();
    abort.abort();
    internals.abort = abort;
    await w.run(j);
    const after = db.get(jobPath("stopped")) as ExportJob;
    assertEquals(after.status, "waiting");
    assertEquals(after.attempts, 1);
  } finally {
    db.restore();
  }
});

Deno.test({
  name: "the version-1 worker never claims, recovers or re-queues a held job",
  ignore: !V1,
  fn: async () => {
    const v1 = V1!;
    assertEquals(v1.WORKER_VERSION, 1);
    const now = 100 * 24 * HOUR;
    const jobs = {
      "0000a-x": held("0000a-x", { requestedAt: now - HOUR }),
      "0000b-x": job("0000b-x", "queued", { platform: "ps2" }),
    };
    // It still takes a plain queued job — the fixture is live — but not this.
    assertEquals(v1.pickNextJob(jobs)?.id, "0000b-x");
    assertEquals(v1.pickNextJob({ "0000a-x": jobs["0000a-x"] }), null);
    // Its prune leaves a held job alone for the week it gives any job, and
    // only then forgets it, as it would a finished one.
    assertEquals(v1.jobsToPrune(jobs, now), { freeBlobs: [], remove: [] });
    assertEquals(
      v1.jobsToPrune(
        { old: held("old", { requestedAt: now - 8 * 24 * HOUR }) },
        now,
      ),
      { freeBlobs: [], remove: ["old"] },
    );

    const db = fakeRtdb();
    try {
      db.set(jobPath("0000a-x"), jobs["0000a-x"]);
      const old = driveWorker(v1, CODE, "Old Mac");
      const current = driveWorker({ ExportWorker }, CODE, "New Mac");
      // Sharing the code: the old one cannot claim it even when asked directly.
      assert(!await old.claim(jobs["0000a-x"]));
      assertEquals(db.get(jobPath("0000a-x")), jobs["0000a-x"]);
      assert(await current.claim(jobs["0000a-x"]));
      // The installed app opens mid-build: its start-up recovery passes over
      // a build it did not claim.
      const building = db.get(jobPath("0000a-x"));
      await old.recoverStale();
      assertEquals(db.get(jobPath("0000a-x")), building);
      // And when the new one restarts, the job comes back held, out of the
      // old one's reach again.
      await current.recoverStale();
      assertEquals((db.get(jobPath("0000a-x")) as ExportJob).status, "waiting");
      assert(!await old.claim(jobs["0000a-x"]));

      // The old worker's own claims stay recoverable by the new one, which is
      // what finishes a build that died with the old app.
      db.set(jobPath("0000b-x"), jobs["0000b-x"]);
      assert(await old.claim(jobs["0000b-x"]));
      assertEquals((db.get(jobPath("0000b-x")) as ExportJob).worker, CODE);
      await current.recoverStale();
      assertEquals((db.get(jobPath("0000b-x")) as ExportJob).status, "queued");
    } finally {
      db.restore();
    }
  },
});
