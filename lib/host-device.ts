// lib/host-device.ts — which machine the launcher is running on, as far as
// the pad layer cares: is this a Lenovo Legion Go, and does its controller
// come apart?
//
// The Legion Go's TrueStrike controller detaches into two halves that keep
// reporting as ONE pad, and on Windows that pad rides XInput, where the
// Gamepad API's id is the fixed "Xbox 360 Controller (XInput STANDARD
// GAMEPAD)" literal and names no vendor at all. So the launcher's
// split-controller two-player default (svelte-src/Dashboard.svelte, Split
// Controller mode) cannot always tell from the pad that it is on a Legion —
// but the machine's own SMBIOS/DMI product strings say so on every OS: Linux
// exposes them under /sys/class/dmi/id, Windows through the
// Win32_ComputerSystemProduct and Win32_ComputerSystem CIM classes.
// routes/api/host.ts serves the answer to the launcher (local only).

export interface HostDmi {
  /** sys_vendor / Win32_ComputerSystemProduct.Vendor — "LENOVO". */
  vendor?: string;
  /** product_name / .Name — Lenovo's machine-type code, e.g. "83E1". */
  product?: string;
  /** product_family / Win32_ComputerSystem.SystemFamily — "Legion Go". */
  family?: string;
  /** product_version / .Version — "Legion Go 8APU1". */
  version?: string;
}

export interface HostClass {
  /** A Lenovo Legion Go family handheld. */
  legionGo: boolean;
  /**
   * The controller detaches into two halves (Legion Go, Legion Go 2). The
   * Legion Go S is a Legion Go whose controller does not come apart.
   */
  detachable: boolean;
  /** "Legion Go", "Legion Go S" or "Legion Go 2" when recognised. */
  model: string | null;
}

export interface HostDevice extends HostClass {
  available: true;
  os: string;
  dmi: HostDmi;
}

// Lenovo machine-type codes (the first four characters of product_name) for
// the Legion Go family. The family/version strings name the model in words
// and are the primary tell; this table is the fallback for firmware that
// leaves them blank, and the tie-breaker when they say no more than "Legion
// Go" while the code knows the S or the 2. It only speaks for a machine that
// is Lenovo's by vendor or by name — the codes themselves are not verifiable
// here, and another vendor's product_name could start the same way.
const LEGION_GO_MODELS: Record<string, string> = {
  "83E1": "Legion Go",
  "83L3": "Legion Go S",
  "83N6": "Legion Go S",
  "83Q2": "Legion Go S",
  "83Q3": "Legion Go S",
  "83N0": "Legion Go 2",
  "83N1": "Legion Go 2",
};

/** What the DMI strings say the machine is, for the pad layer. */
export function classifyHost(dmi: HostDmi): HostClass {
  const text = [dmi.family, dmi.version].filter(Boolean).join(" ");
  let words: string | null = null;
  if (/legion\s*go\s*2\b/i.test(text)) words = "Legion Go 2";
  else if (/legion\s*go\s*s\b/i.test(text)) words = "Legion Go S";
  else if (/legion\s*go\b/i.test(text)) words = "Legion Go";
  const lenovo = words !== null || /lenovo/i.test(dmi.vendor ?? "");
  const code = (dmi.product ?? "").trim().toUpperCase().slice(0, 4);
  const coded = lenovo ? LEGION_GO_MODELS[code] ?? null : null;
  const model = words === null
    ? coded
    : (words === "Legion Go" && coded ? coded : words);
  const legionGo = model !== null;
  return { legionGo, detachable: legionGo && model !== "Legion Go S", model };
}

/** The DMI strings as the Linux kernel exports them. */
export async function readLinuxDmi(
  root = "/sys/class/dmi/id",
): Promise<HostDmi> {
  const read = async (name: string): Promise<string | undefined> => {
    try {
      const v = (await Deno.readTextFile(`${root}/${name}`)).trim();
      return v || undefined;
    } catch {
      return undefined;
    }
  };
  return {
    vendor: await read("sys_vendor"),
    product: await read("product_name"),
    family: await read("product_family"),
    version: await read("product_version"),
  };
}

// One CIM query, JSON out. Win32_ComputerSystemProduct carries the vendor,
// machine-type code and version; SystemFamily lives on Win32_ComputerSystem.
const WINDOWS_DMI_SCRIPT = [
  "$p = Get-CimInstance Win32_ComputerSystemProduct;",
  "$c = Get-CimInstance Win32_ComputerSystem;",
  "@{ vendor = $p.Vendor; product = $p.Name; version = $p.Version;",
  "family = $c.SystemFamily } | ConvertTo-Json -Compress",
].join(" ");

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/** The same strings on Windows, through PowerShell; {} when it cannot say. */
export async function readWindowsDmi(): Promise<HostDmi> {
  try {
    const cmd = new Deno.Command("powershell", {
      args: ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_DMI_SCRIPT],
      stdout: "piped",
      stderr: "null",
      stdin: "null",
      // A PowerShell that stalls (a first-run Defender scan, a broken module
      // path) must not hold every /api/host — and the launcher's boot — with
      // it; past this the answer is simply "not a Legion".
      signal: AbortSignal.timeout(10_000),
    });
    const { code, stdout } = await cmd.output();
    if (code !== 0) return {};
    const j = JSON.parse(new TextDecoder().decode(stdout));
    return {
      vendor: str(j?.vendor),
      product: str(j?.product),
      family: str(j?.family),
      version: str(j?.version),
    };
  } catch {
    return {};
  }
}

/** The DMI strings for this OS; {} where there is no way to read them. */
export function readHostDmi(os: string = Deno.build.os): Promise<HostDmi> {
  if (os === "linux") return readLinuxDmi();
  if (os === "windows") return readWindowsDmi();
  return Promise.resolve({});
}

let cached: Promise<HostDevice> | null = null;

/**
 * This machine, classified. Read once per process — the strings never change
 * while the launcher runs, and the Windows reader spawns PowerShell — but a
 * read that came back empty (a PowerShell that timed out on a cold boot) is
 * not remembered, so the next request asks again rather than calling the
 * machine "not a Legion" for the rest of the evening.
 */
export function detectHostDevice(): Promise<HostDevice> {
  if (cached) return cached;
  const reading = (async (): Promise<HostDevice> => {
    const dmi = await readHostDmi();
    if (!Object.values(dmi).some(Boolean)) cached = null;
    return { available: true, os: Deno.build.os, ...classifyHost(dmi), dmi };
  })();
  cached = reading;
  return reading;
}
