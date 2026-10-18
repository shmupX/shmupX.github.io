// The result files `deno task refresh:compare` saves, and the comparison it
// makes of them.
//
// A result is one machine on one display — a desktop's 500 Hz monitor, a
// handheld's own screen — saved as a plain JSON file so it can be carried to
// another machine and compared there. These pin the timing summary each file
// carries, that a file comes back exactly as it went out and anything else is
// refused with a reason, and that the comparison puts each result in its own
// column, in every format it writes.

import {
  assert,
  assertAlmostEquals,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { join } from "@std/path";
import {
  type RawRun,
  spread,
  timing,
  viewCadence,
} from "../scripts/lib/refresh-metrics.ts";
import {
  comparisonRows,
  keepRaw,
  loadResults,
  parseResult,
  type RefreshResult,
  renderHtml,
  renderMarkdown,
  renderText,
  RESULT_FORMAT,
  RESULT_VERSION,
  resultFileName,
  runResult,
  saveResult,
} from "../scripts/lib/refresh-results.ts";

Deno.test("a spread is nearest-rank percentiles, mean and deviation", () => {
  const xs = Array.from({ length: 100 }, (_, i) => i + 1);
  const s = spread(xs.toReversed());
  assertEquals([s.n, s.p50, s.p95, s.p99, s.max], [100, 50, 95, 99, 100]);
  assertEquals(s.mean, 50.5);
  assertAlmostEquals(s.stdev, 28.866, 1e-3);
  assertEquals(spread([]).n, 0);
});

/** `n` frames at `hz`, every `missEvery`th one a frame late. */
function raw(hz: number, n: number, work: number, missEvery = 0): RawRun {
  const iv = 1000 / hz;
  const r: RawRun = {
    interval: [],
    work: [],
    update: [],
    draw: [],
    steps: [],
    on: [],
  };
  for (let i = 0; i < n; i++) {
    r.interval.push(missEvery && i % missEvery === missEvery - 1 ? iv * 2 : iv);
    r.update.push(work / 4);
    r.draw.push(work * 3 / 4);
    r.work.push(work);
    r.steps.push(i % 2);
    r.on.push(1);
  }
  return r;
}

Deno.test("timing reads the display rate off the frames, and the frames it missed", () => {
  const t = timing(raw(500, 1000, 1.5, 50));
  assertAlmostEquals(t.hz, 500, 1e-9);
  assertEquals(t.frames, 1000);
  assertEquals(t.missed, 0.02);
  // p95 work against the median frame: 1.5 ms of a 2 ms frame.
  assertAlmostEquals(t.budget, 0.75, 1e-9);
  assertEquals(t.steps, [0.5, 0.5, 0, 0]);
  assertEquals(t.blended, 1);
  assertAlmostEquals(t.updateMs.mean + t.drawMs.mean, t.workMs.mean, 1e-9);
  // A slice's first frame has no interval of its own and is not counted.
  const first = raw(240, 10, 1);
  first.interval[0] = 0;
  assertEquals(timing(first).intervalMs.n, 9);
});

const cad = (moved: number, hz: number) =>
  viewCadence({ samples: 1000, moved, evenness: moved > 0.9 ? 0.98 : 0.1 }, hz);

/** A result as a run would build it, for `label` at `hz`. */
function result(
  label: string,
  hz: number,
  over: Partial<RefreshResult> = {},
): RefreshResult {
  const stockRaw = raw(hz, 50, 1.2), maxRaw = raw(hz, 50, 1.4);
  return {
    format: RESULT_FORMAT,
    version: RESULT_VERSION,
    label,
    createdAt: "2026-10-18T03:00:00.000Z",
    source: "live",
    level: "static/games/2028-ai/foo.json",
    machine: {
      os: "Windows 11 Pro (10.0.26100)",
      arch: "x86_64",
      hostname: "desk",
      cpu: "AMD Ryzen 7 7800X3D 8-Core Processor",
      threads: 16,
      memoryGb: 8,
      gpu: "ANGLE (NVIDIA, NVIDIA GeForce RTX 4080 SUPER Direct3D11)",
      browser: "Google Chrome 141.0.7390.55",
      renderer: "webgl",
      userAgent: "Mozilla/5.0",
    },
    display: {
      hz,
      source: "measured",
      nominalHz: hz,
      width: 2560,
      height: 1440,
      dpr: 1,
    },
    settings: { mode: "auto", seconds: 10 },
    runs: {
      stock: runResult("stock", stockRaw, {
        drawn: cad(120 / hz, hz),
        logic: cad(120 / hz, hz),
        pixels: { drawn: cad(0.2, hz), logic: cad(0.2, hz) },
      }),
      refresh: runResult("auto", maxRaw, {
        drawn: cad(1, hz),
        logic: cad(120 / hz, hz),
        pixels: { drawn: cad(0.4, hz), logic: cad(0.2, hz) },
      }),
    },
    logicMatchesStock: null,
    problems: [],
    raw: { stock: keepRaw(stockRaw), refresh: keepRaw(maxRaw) },
    ...over,
  };
}

Deno.test("a result file comes back as it went, and sorts by time", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const desk = result("4080 Super 500 Hz", 500);
    const legion = result("Legion Go", 144, {
      createdAt: "2026-10-17T20:00:00.000Z",
    });
    assertEquals(
      resultFileName(desk),
      "4080-super-500-hz-live-500hz-20261018T030000Z.json",
    );
    for (const r of [desk, legion]) {
      await saveResult(r, join(dir, resultFileName(r)));
    }
    // Something else in the folder is passed over, not a failure.
    await Deno.writeTextFile(join(dir, "notes.json"), '{"hello": 1}');
    await Deno.writeTextFile(join(dir, "readme.txt"), "hi");
    const back = await loadResults([dir]);
    assertEquals(back.map((r) => r.label), ["Legion Go", "4080 Super 500 Hz"]);
    assertEquals(back[1], desk);
    // A file named outright that is not a result is an error, by name.
    await assertRejects(
      () => loadResults([join(dir, "notes.json")]),
      Error,
      "notes.json: not a refresh:compare result",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a result from another version or a broken file is refused with the reason", () => {
  const good = JSON.stringify(result("a", 240));
  assertEquals(parseResult(good).label, "a");
  assertThrows(() => parseResult("{"), Error, "not JSON");
  assertThrows(
    () => parseResult(JSON.stringify({ ...JSON.parse(good), version: 99 })),
    Error,
    `result version 99; this reads version ${RESULT_VERSION}`,
  );
  const { runs: _, ...noRuns } = JSON.parse(good);
  assertThrows(
    () => parseResult(JSON.stringify(noRuns)),
    Error,
    "incomplete",
  );
});

Deno.test("the comparison gives every result a column, in every format", () => {
  const desk = result("4080 | Super 500 Hz", 500);
  const legion = result("Legion <Go>", 144);
  const emulated = result("container", 240, {
    source: "emulated",
    logicMatchesStock: true,
    problems: ["only 3 moving-object samples; nothing to judge"],
  });
  // An emulated run that skipped the stock replay has no stock timing.
  emulated.runs.stock.timing = null;
  const all = [desk, legion, emulated];

  const rows = comparisonRows(all);
  for (const row of rows) assertEquals(row.cells.length, 3, row.name);
  const cell = (name: string) => rows.find((r) => r.name === name)!.cells;
  assertEquals(cell("result"), [desk.label, legion.label, emulated.label]);
  assertEquals(
    cell("display")[0],
    "500 Hz measured (nominal 500) · 2560×1440 @1x",
  );
  assertEquals(cell("logic matches stock"), ["—", "—", "yes"]);
  assertEquals(cell("check")[2], emulated.problems[0]);
  assertStringIncludes(cell("work it adds")[0], "+0.20 ms mean");
  assertEquals(cell("work it adds")[2], "—");
  // Motion on screen as well as by position.
  assert(cell("on screen (whole px)").every((c) => c.includes("% of frames")));

  const text = renderText(all);
  for (const r of all) assertStringIncludes(text, r.label);
  assertStringIncludes(text, "── Max refresh");

  const md = renderMarkdown(all);
  assertStringIncludes(
    md,
    "| | 4080 \\| Super 500 Hz | Legion <Go> | container |",
  );
  assertEquals(
    new Set(md.trim().split("\n").map((l) => l.split(/(?<!\\)\|/).length)).size,
    1,
    "every Markdown row has as many cells as the header",
  );

  const html = renderHtml(all);
  assertStringIncludes(html, "Legion &lt;Go&gt;");
  assert(!html.includes("Legion <Go>"));
  assertEquals(html.match(/<svg /g)?.length, 3);
});
