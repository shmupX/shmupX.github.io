// lib/engine-compare.ts — the parts that need no emulator: what a job looks
// like to a browser, which files a result exposes, and how a level name
// becomes the slug its artifacts are filed under.

import { assert, assertEquals } from "@std/assert";
import {
  compareJobFile,
  compareSlug,
  publicCompareJob,
  resultFiles,
} from "../lib/engine-compare.ts";

Deno.test("a comparison's files are listed in viewing order, absent ones skipped", () => {
  const r = {
    name: "Ramsie",
    runDir: "/tmp/run",
    video: "/tmp/run/compare.mp4",
    sheet: null,
    moment: "/tmp/run/moment.png",
    reportMd: "/tmp/run/report.md",
    reportJson: "/tmp/run/report.json",
    from: 44,
    len: 5,
    gameStartedAfterMs: 1170,
    saturnLagSec: 0,
  };
  assertEquals(resultFiles(r), [
    "/tmp/run/compare.mp4",
    "/tmp/run/moment.png",
    "/tmp/run/report.md",
  ]);
});

Deno.test("the public job carries base names only, never paths", () => {
  const job = {
    id: "j1",
    source: "ramsie",
    from: 44,
    len: 5,
    status: "done" as const,
    progress: "ready",
    log: Array.from({ length: 60 }, (_, i) => `line ${i}`),
    startedAt: 1,
    finishedAt: 2,
    error: null,
    result: {
      name: "Ramsie",
      runDir: "/secret/run",
      video: "/secret/run/compare.mp4",
      sheet: "/secret/run/sheet.png",
      moment: "/secret/run/moment.png",
      reportMd: "/secret/run/report.md",
      reportJson: "/secret/run/report.json",
      from: 44,
      len: 5,
      gameStartedAfterMs: null,
      saturnLagSec: 2.6,
    },
  };
  const pub = publicCompareJob(job);
  assertEquals(JSON.stringify(pub).includes("/secret"), false);
  const result = pub.result as { files: string[] };
  assertEquals(result.files, [
    "compare.mp4",
    "sheet.png",
    "moment.png",
    "report.md",
  ]);
  assertEquals((pub.log as string[]).length, 40, "the log is bounded");
  // File lookup is by base name and refuses anything else.
  assertEquals(compareJobFile(job, "moment.png"), "/secret/run/moment.png");
  assertEquals(compareJobFile(job, "report.json"), "/secret/run/report.json");
  assertEquals(compareJobFile(job, "../etc/passwd"), null);
  assertEquals(compareJobFile(job, "saturn.mov"), null);
});

Deno.test("a job without a result exposes no files", () => {
  const job = {
    id: "j2",
    source: "x",
    from: 0,
    len: 1,
    status: "running" as const,
    progress: "booting",
    log: [],
    startedAt: 1,
    finishedAt: null,
    error: null,
    result: null,
  };
  assertEquals(publicCompareJob(job).result, null);
  assertEquals(compareJobFile(job, "compare.mp4"), null);
});

Deno.test("the artifact slug comes from the level name, sav: scheme stripped", () => {
  assertEquals(compareSlug("Dez 2 - Ramsie"), "dez-2-ramsie");
  assert(compareSlug("sav:/tmp/Dez 2 - X.sav").length > 0);
  assertEquals(compareSlug(""), "compare");
});
