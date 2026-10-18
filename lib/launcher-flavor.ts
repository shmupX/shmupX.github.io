// Which product a packaged launcher is: the free download, or the Steam build.
//
// They are the same binary but for what `deno task build:steam` leaves out of
// it (lib/member-content.ts) and one embedded file saying so. desktop.ts reads
// that file at startup and sets SHMUPX_FLAVOR, which is how everything else —
// the built server is a separate module graph — learns which one it is:
//
//   * steam — the member content comes from member packs only, never from the
//     deploy (main.ts); the updater stays off, because Steam ships the
//     updates; and "Add to Steam" has nothing to add, since Steam installed it.
//
// The file is only read inside a packaged app. A checkout that once ran a
// Steam build still has build/flavor/flavor.json lying about, and must not
// start behaving like a store copy because of it.

/** Where the Steam build writes the marker, relative to the repository root. */
export const FLAVOR_FILE = "build/flavor/flavor.json";

export interface FlavorFile {
  flavor: "steam";
  /** When the binary was built, ISO 8601. */
  built: string;
}

/** The flavor this process is, from SHMUPX_FLAVOR. */
export function launcherFlavor(
  env: Record<string, string | undefined>,
): "steam" | null {
  return env.SHMUPX_FLAVOR === "steam" ? "steam" : null;
}

/** True in the Steam build. */
export function isSteamFlavor(): boolean {
  try {
    return launcherFlavor({ SHMUPX_FLAVOR: Deno.env.get("SHMUPX_FLAVOR") }) ===
      "steam";
  } catch {
    return false;
  }
}

/** The marker as `deno task build:steam` writes it. */
export function flavorFileText(built: Date): string {
  const file: FlavorFile = { flavor: "steam", built: built.toISOString() };
  return JSON.stringify(file, null, 2) + "\n";
}

/** The embedded marker, or null when there is none or it says nothing this knows. */
export function readFlavorFile(url: URL): FlavorFile | null {
  try {
    const parsed = JSON.parse(Deno.readTextFileSync(url));
    return parsed?.flavor === "steam" ? parsed as FlavorFile : null;
  } catch {
    return null;
  }
}
