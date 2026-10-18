/**
 * The result files `deno task refresh:compare` saves, and the comparison it
 * makes of any number of them (`--compare`). A result is one machine on one
 * display: what it is, how its frames came, and how the stock game and max
 * refresh drew motion there. The files are plain JSON on purpose — carry them
 * between machines however is handy and compare them anywhere.
 */

import { basename, join } from "@std/path";
import {
  pct,
  type RawRun,
  type Timing,
  timing,
  type ViewCadence,
} from "./refresh-metrics.ts";

export const RESULT_FORMAT = "shmupx.refresh-result";
export const RESULT_VERSION = 1;

export interface Machine {
  os: string;
  arch: string;
  hostname: string | null;
  cpu: string | null;
  threads: number | null;
  memoryGb: number | null;
  gpu: string | null;
  browser: string | null;
  /** How Phaser drew: "webgl" or "canvas". */
  renderer: string | null;
  userAgent: string | null;
}

export interface Display {
  hz: number;
  /** "measured" off a real display's frame times, or "emulated". */
  source: "measured" | "emulated";
  /** What the display says it runs at, when the person running it said. */
  nominalHz: number | null;
  width: number | null;
  height: number | null;
  dpr: number | null;
}

export interface RunResult {
  /** The refresh mode these frames were drawn in. */
  mode: "stock" | "auto" | "max";
  /** Null when the run had no frames of its own (an emulated --no-stock-run). */
  timing: Timing | null;
  /**
   * Motion as drawn, and by the logic's own positions — which is the stock
   * picture at these same frame times — and both again on the game's pixel
   * grid, which is what reaches the screen.
   */
  cadence: {
    drawn: ViewCadence;
    logic: ViewCadence;
    pixels: { drawn: ViewCadence; logic: ViewCadence } | null;
  };
}

export interface RefreshResult {
  format: typeof RESULT_FORMAT;
  version: number;
  label: string;
  createdAt: string;
  source: "live" | "emulated";
  /** The level file played. */
  level: string;
  machine: Machine;
  display: Display;
  /** What was asked for: mode, seconds, warmup, slice, seed. */
  settings: Record<string, string | number | boolean | null>;
  runs: { stock: RunResult; refresh: RunResult };
  /** Emulated runs only: whether a stock replay matched every logic position. */
  logicMatchesStock: boolean | null;
  problems: string[];
  /** Every frame's interval and work (ms), for whatever the summary leaves out. */
  raw: { stock: KeptRaw | null; refresh: KeptRaw | null };
}

export type KeptRaw = Pick<
  RawRun,
  "interval" | "work" | "update" | "draw" | "steps"
>;

/** A run's raw timings, trimmed to what a result file keeps. */
export function keepRaw(raw: RawRun | null): KeptRaw | null {
  if (!raw) return null;
  const round = (xs: number[]) => xs.map((x) => Math.round(x * 1000) / 1000);
  return {
    interval: round(raw.interval),
    work: round(raw.work),
    update: round(raw.update),
    draw: round(raw.draw),
    steps: raw.steps,
  };
}

export function runResult(
  mode: RunResult["mode"],
  raw: RawRun | null,
  cadence: RunResult["cadence"],
): RunResult {
  return { mode, timing: raw && raw.work.length ? timing(raw) : null, cadence };
}

const decode = (b: Uint8Array) => new TextDecoder().decode(b).trim();

async function run(cmd: string, args: string[]): Promise<string | null> {
  try {
    const out = await new Deno.Command(cmd, {
      args,
      stdout: "piped",
      stderr: "null",
    }).output();
    return out.success ? decode(out.stdout) || null : null;
  } catch {
    return null;
  }
}

/** This machine, as Deno sees it: the half of Machine a page cannot see. */
export async function hostMachine(): Promise<
  Pick<Machine, "os" | "arch" | "hostname" | "cpu">
> {
  const os = Deno.build.os;
  let name: string = os;
  let cpu: string | null = null;
  if (os === "linux") {
    try {
      const rel = await Deno.readTextFile("/etc/os-release");
      name = rel.match(/^PRETTY_NAME="?([^"\n]+)"?$/m)?.[1] ?? "Linux";
    } catch { /* not there */ }
    try {
      const info = await Deno.readTextFile("/proc/cpuinfo");
      cpu = info.match(/^model name\s*:\s*(.+)$/m)?.[1].trim() ?? null;
    } catch { /* not there */ }
  } else if (os === "darwin") {
    name = `macOS ${await run("sw_vers", ["-productVersion"]) ?? ""}`.trim();
    cpu = await run("sysctl", ["-n", "machdep.cpu.brand_string"]);
  } else if (os === "windows") {
    const ps = (q: string) =>
      run("powershell", ["-NoProfile", "-NonInteractive", "-Command", q]);
    name = await ps("(Get-CimInstance Win32_OperatingSystem).Caption") ??
      "Windows";
    cpu = (await ps("(Get-CimInstance Win32_Processor).Name"))?.split(
      /\r?\n/,
    )[0].trim() ?? Deno.env.get("PROCESSOR_IDENTIFIER") ?? null;
  }
  let hostname: string | null = null;
  try {
    hostname = Deno.hostname();
  } catch { /* not allowed */ }
  return {
    os: `${name} (${Deno.osRelease()})`,
    arch: Deno.build.arch,
    hostname,
    cpu,
  };
}

/** A file name that sorts by machine, then display, then time. */
export function resultFileName(r: RefreshResult): string {
  const slug = r.label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(
    /^-+|-+$/g,
    "",
  ) || "result";
  const stamp = r.createdAt.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return `${slug}-${r.source}-${Math.round(r.display.hz)}hz-${stamp}.json`;
}

export async function saveResult(r: RefreshResult, path: string) {
  await Deno.writeTextFile(path, JSON.stringify(r, null, 2) + "\n");
}

/** A result file, refused with the reason when it is not one this reads. */
export function parseResult(text: string, from = "result"): RefreshResult {
  let r: Partial<RefreshResult>;
  try {
    r = JSON.parse(text);
  } catch (e) {
    throw new Error(`${from}: not JSON (${(e as Error).message})`);
  }
  if (!r || r.format !== RESULT_FORMAT) {
    throw new Error(`${from}: not a refresh:compare result`);
  }
  if (r.version !== RESULT_VERSION) {
    throw new Error(
      `${from}: result version ${r.version}; this reads version ` +
        `${RESULT_VERSION}`,
    );
  }
  if (!r.runs?.stock || !r.runs?.refresh || !r.display || !r.machine) {
    throw new Error(`${from}: incomplete result`);
  }
  return r as RefreshResult;
}

/**
 * Every result named: files as they are, directories for the .json result
 * files in them (anything else there is skipped), oldest first.
 */
export async function loadResults(paths: string[]): Promise<RefreshResult[]> {
  const out: RefreshResult[] = [];
  for (const p of paths) {
    if ((await Deno.stat(p)).isDirectory) {
      const names: string[] = [];
      for await (const e of Deno.readDir(p)) {
        if (e.isFile && e.name.endsWith(".json")) names.push(e.name);
      }
      for (const n of names.sort()) {
        try {
          out.push(
            parseResult(await Deno.readTextFile(join(p, n)), join(p, n)),
          );
        } catch { /* not a result */ }
      }
    } else {
      out.push(parseResult(await Deno.readTextFile(p), basename(p)));
    }
  }
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

// ---- The comparison ---------------------------------------------------------

export interface Row {
  /** A section heading row when `name` is empty. */
  section?: string;
  name: string;
  cells: string[];
}

const ms = (x: number) => x.toFixed(2);
const dash = "—";

function timingRows(
  results: RefreshResult[],
  pick: (r: RefreshResult) => RunResult,
): Row[] {
  const t = (f: (t: Timing) => string) =>
    results.map((r) => {
      const tm = pick(r).timing;
      return tm ? f(tm) : dash;
    });
  return [
    {
      name: "motion drawn on",
      cells: results.map((r) => {
        const c = pick(r).cadence.drawn;
        return `${pct(c.moved)} of frames (${c.drawnHz.toFixed(0)}/s)`;
      }),
    },
    {
      name: "evenness",
      cells: results.map((r) => pick(r).cadence.drawn.evenness.toFixed(2)),
    },
    {
      name: "on screen (whole px)",
      cells: results.map((r) => {
        const p = pick(r).cadence.pixels?.drawn;
        return p
          ? `${pct(p.moved)} of frames (${p.drawnHz.toFixed(0)}/s) · evenness ${
            p.evenness.toFixed(2)
          }`
          : dash;
      }),
    },
    {
      name: "frame interval",
      cells: t((tm) =>
        `p50 ${ms(tm.intervalMs.p50)} · p95 ${ms(tm.intervalMs.p95)} · ` +
        `p99 ${ms(tm.intervalMs.p99)} ms`
      ),
    },
    { name: "missed frames", cells: t((tm) => pct(tm.missed)) },
    {
      name: "main-thread work",
      cells: t((tm) =>
        `mean ${ms(tm.workMs.mean)} · p95 ${ms(tm.workMs.p95)} ms ` +
        `(p95 is ${(tm.budget * 100).toFixed(0)}% of a frame)`
      ),
    },
    {
      name: "update · draw",
      cells: t((tm) =>
        `mean ${ms(tm.updateMs.mean)} · ${ms(tm.drawMs.mean)} ms`
      ),
    },
    {
      name: "steps per frame",
      cells: t((tm) =>
        tm.steps.map((s, i) => `${i === 3 ? "3+" : i}: ${pct(s)}`).join(" · ")
      ),
    },
    { name: "drawn blended", cells: t((tm) => pct(tm.blended)) },
  ];
}

/** The comparison as rows: one column per result, in the order given. */
export function comparisonRows(results: RefreshResult[]): Row[] {
  const each = (f: (r: RefreshResult) => string) => results.map(f);
  const section = (name: string): Row => ({
    section: name,
    name: "",
    cells: results.map(() => ""),
  });
  const cost = (r: RefreshResult) => {
    const a = r.runs.stock.timing, b = r.runs.refresh.timing;
    if (!a || !b) return dash;
    const d = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(2)}`;
    return `${d(b.workMs.mean - a.workMs.mean)} ms mean (update ` +
      `${d(b.updateMs.mean - a.updateMs.mean)}, draw ` +
      `${d(b.drawMs.mean - a.drawMs.mean)}), ` +
      `${d(b.workMs.p95 - a.workMs.p95)} ms p95`;
  };
  return [
    { name: "result", cells: each((r) => r.label) },
    {
      name: "source",
      cells: each((r) =>
        r.source === "live"
          ? "live display"
          : "emulated display (synthetic frame clock)"
      ),
    },
    {
      name: "recorded",
      cells: each((r) => r.createdAt.slice(0, 16).replace("T", " ")),
    },
    section("Machine"),
    { name: "os", cells: each((r) => `${r.machine.os} ${r.machine.arch}`) },
    {
      name: "cpu",
      cells: each((r) =>
        `${r.machine.cpu ?? "?"}` +
        (r.machine.threads ? ` (${r.machine.threads} threads)` : "")
      ),
    },
    { name: "gpu", cells: each((r) => r.machine.gpu ?? dash) },
    {
      name: "browser",
      cells: each((r) =>
        `${r.machine.browser ?? "?"} · ${r.machine.renderer ?? "?"}`
      ),
    },
    {
      name: "display",
      cells: each((r) =>
        `${r.display.hz.toFixed(0)} Hz ${r.display.source}` +
        (r.display.nominalHz ? ` (nominal ${r.display.nominalHz})` : "") +
        (r.display.width
          ? ` · ${r.display.width}×${r.display.height} @${r.display.dpr}x`
          : "")
      ),
    },
    section("Stock"),
    ...timingRows(results, (r) => r.runs.stock),
    section("Max refresh"),
    { name: "mode", cells: each((r) => `?refresh=${r.runs.refresh.mode}`) },
    ...timingRows(results, (r) => r.runs.refresh),
    section("Verdict"),
    { name: "work it adds", cells: each(cost) },
    {
      name: "logic matches stock",
      cells: each((r) =>
        r.logicMatchesStock === null ? dash : r.logicMatchesStock ? "yes" : "NO"
      ),
    },
    {
      name: "check",
      cells: each((r) => r.problems.length ? r.problems.join("; ") : "pass"),
    },
  ];
}

/** For a terminal: one column per result, padded. */
export function renderText(results: RefreshResult[]): string {
  const rows = comparisonRows(results);
  const nameW = Math.max(...rows.map((r) => r.name.length));
  const colW = results.map((_, i) =>
    Math.max(...rows.map((r) => r.cells[i].length))
  );
  return rows.map((r) =>
    r.section
      ? `\n── ${r.section} ${"─".repeat(Math.max(0, nameW - r.section.length))}`
      : `${r.name.padEnd(nameW)}  ${
        r.cells.map((c, i) => c.padEnd(colW[i])).join("  │  ")
      }`.trimEnd()
  ).join("\n");
}

const mdCell = (s: string) => s.replaceAll("|", "\\|");

/** For an issue, a PR or a chat: a Markdown table. */
export function renderMarkdown(results: RefreshResult[]): string {
  const rows = comparisonRows(results);
  const [head, ...body] = rows;
  const lines = [
    `| | ${head.cells.map(mdCell).join(" | ")} |`,
    `| --- | ${head.cells.map(() => "---").join(" | ")} |`,
  ];
  for (const r of body) {
    lines.push(
      r.section
        ? `| **${r.section}** | ${r.cells.map(() => "").join(" | ")} |`
        : `| ${r.name} | ${r.cells.map(mdCell).join(" | ")} |`,
    );
  }
  return lines.join("\n") + "\n";
}

const esc = (s: string) =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/**
 * One result's frame intervals as a histogram, stock and max refresh laid
 * over each other, from 0 to three of its own median frames.
 */
function histogram(r: RefreshResult): string {
  const a = r.raw.stock?.interval.filter((x) => x > 0) ?? [];
  const b = r.raw.refresh?.interval.filter((x) => x > 0) ?? [];
  if (!a.length && !b.length) return "<p class=note>No per-frame timings.</p>";
  const all = [...a, ...b].sort((x, y) => x - y);
  const median = all[Math.floor(all.length / 2)];
  const top = median * 3, bins = 60, W = 360, H = 120;
  const count = (xs: number[]) => {
    const c = new Array(bins).fill(0);
    for (const x of xs) c[Math.min(bins - 1, Math.floor((x / top) * bins))]++;
    return c.map((n) => (xs.length ? n / xs.length : 0));
  };
  const ca = count(a), cb = count(b);
  const peak = Math.max(...ca, ...cb, 1e-9);
  const bars = (c: number[], cls: string) =>
    c.map((v, i) =>
      v
        ? `<rect class=${cls} x=${(i * W / bins).toFixed(1)} y=${
          (H - v / peak * H).toFixed(1)
        } width=${(W / bins - 1).toFixed(1)} height=${
          (v / peak * H).toFixed(1)
        }></rect>`
        : ""
    ).join("");
  const tick = (f: number) =>
    `<text x=${(f / 3 * W).toFixed(0)} y=${H + 14} text-anchor=middle>${
      (median * f).toFixed(1)
    }</text>`;
  // Room either side for the end ticks' labels.
  const box = `-14 -4 ${W + 28} ${H + 20}`;
  return `<svg viewBox="${box}" role=img aria-label="frame intervals">` +
    bars(ca, "stock") + bars(cb, "refresh") +
    [0, 1, 2, 3].map(tick).join("") + `</svg>`;
}

/** A page to open in a browser: the table, and each result's frame times. */
export function renderHtml(results: RefreshResult[]): string {
  const rows = comparisonRows(results);
  const [head, ...body] = rows;
  const table = `<table><thead><tr><th></th>${
    head.cells.map((c) => `<th>${esc(c)}</th>`).join("")
  }</tr></thead><tbody>${
    body.map((r) =>
      r.section
        ? `<tr class=section><th colspan=${results.length + 1}>${
          esc(r.section)
        }</th></tr>`
        : `<tr><th>${esc(r.name)}</th>${
          r.cells.map((c) => `<td>${esc(c)}</td>`).join("")
        }</tr>`
    ).join("")
  }</tbody></table>`;
  const charts = results.map((r) =>
    `<figure><figcaption>${esc(r.label)} — ${
      r.display.hz.toFixed(0)
    } Hz ${r.display.source}</figcaption>${histogram(r)}</figure>`
  ).join("");
  return `<!doctype html>
<html lang=en><head><meta charset=utf-8>
<meta name=viewport content="width=device-width, initial-scale=1">
<title>Refresh comparison</title>
<style>
:root { --bg: #fafafa; --fg: #1b1b22; --muted: #6a6a80; --line: #ddd;
  --stock: #e09000; --refresh: #1fa356; }
@media (prefers-color-scheme: dark) { :root { --bg: #121218; --fg: #e4e4ee;
  --muted: #9a9ab0; --line: #2c2c38; } }
body { background: var(--bg); color: var(--fg); margin: 0;
  font: 14px/1.45 system-ui, sans-serif; padding: 24px 16px; }
h1 { font-size: 20px; margin: 0 0 4px; }
p.note { color: var(--muted); margin: 0 0 16px; }
.wrap { overflow-x: auto; }
table { border-collapse: collapse; min-width: 100%; }
th, td { text-align: left; vertical-align: top; padding: 5px 10px;
  border-bottom: 1px solid var(--line); }
tbody th { color: var(--muted); font-weight: 500; white-space: nowrap; }
thead th { font-size: 15px; }
tr.section th { color: var(--fg); padding-top: 18px; font-weight: 600; }
.figs { display: flex; flex-wrap: wrap; gap: 24px; margin-top: 24px; }
figure { margin: 0; width: min(380px, 100%); }
figcaption { font-weight: 600; margin-bottom: 6px; }
svg { width: 100%; height: auto; }
svg text { fill: var(--muted); font-size: 10px; }
rect.stock { fill: var(--stock); opacity: .75; }
rect.refresh { fill: var(--refresh); opacity: .75; }
.key span { display: inline-block; width: 10px; height: 10px; margin: 0 4px 0 12px; }
</style></head><body>
<h1>Refresh comparison</h1>
<p class=note>deno task refresh:compare · ${results.length} result${
    results.length === 1 ? "" : "s"
  }</p>
<div class=wrap>${table}</div>
<h2>Frame intervals (ms)</h2>
<p class="note key"><span style="background:var(--stock)"></span>stock<span style="background:var(--refresh)"></span>max refresh — share of frames by time since the last, up to three median frames</p>
<div class=figs>${charts}</div>
</body></html>
`;
}
