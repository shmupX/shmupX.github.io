// lib/desktop-browser.ts decides how the packaged launcher opens its window.
// The choices here are the ones a wrong guess would cost a player on a
// handheld: which browser, with which flags, on which profile, and with what
// left of Steam's environment. None of them can be checked on the machine they
// matter on, so they are pinned down here as plans — no browser is spawned.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  type BrowserLaunch,
  cleanBrowserEnv,
  engineOf,
  FIREFOX_USER_JS,
  launcherDataDir,
  planBrowserLaunches,
  type PlanOptions,
} from "../lib/desktop-browser.ts";

const URL = "http://127.0.0.1:8787/";

function machine(
  over: Partial<PlanOptions> & { path?: string[]; files?: string[] },
): PlanOptions {
  const path = new Set(over.path ?? []);
  const files = new Set(over.files ?? []);
  return {
    os: "linux",
    env: { HOME: "/home/deck", PATH: "/usr/bin" },
    dataDir: "/home/deck/.local/share/shmupX",
    windowed: false,
    onPath: (cmd) => path.has(cmd),
    exists: (p) => files.has(p),
    ...over,
  };
}

Deno.test("Bazzite: only Flatpak Firefox → kiosk on its own profile, xdg-open last", () => {
  const plan = planBrowserLaunches(
    URL,
    machine({
      path: ["flatpak", "xdg-open"],
      files: ["/var/lib/flatpak/exports/bin/org.mozilla.firefox"],
    }),
  );
  assertEquals(plan.map((l) => l.label), [
    "Firefox (Flatpak)",
    "the default browser (xdg-open)",
  ]);
  const [firefox, fallback] = plan;
  const profile = "/home/deck/.local/share/shmupX/browser/org.mozilla.firefox";
  assertEquals(firefox.cmd, "flatpak");
  assertEquals(firefox.args, [
    "run",
    `--filesystem=${profile}`,
    "org.mozilla.firefox",
    "--profile",
    profile,
    "--no-remote",
    "--kiosk",
    URL,
  ]);
  assert(firefox.managed);
  assertEquals(firefox.profileDir, profile);
  assertEquals(firefox.profileFiles, { "user.js": FIREFOX_USER_JS });
  assertStringIncludes(
    FIREFOX_USER_JS,
    'user_pref("network.manage-offline-status", false);',
  );
  assertEquals(fallback, {
    label: "the default browser (xdg-open)",
    cmd: "xdg-open",
    args: [URL],
    managed: false,
  });
});

Deno.test("a user-installed Flatpak is found under XDG_DATA_HOME too", () => {
  const plan = planBrowserLaunches(
    URL,
    machine({
      env: { HOME: "/home/deck", XDG_DATA_HOME: "/data/xdg" },
      path: ["flatpak"],
      files: ["/data/xdg/flatpak/exports/bin/org.chromium.Chromium"],
    }),
  );
  assertEquals(plan[0].label, "Chromium (Flatpak)");
  assertEquals(plan[0].args.slice(0, 3), [
    "run",
    "--filesystem=/home/deck/.local/share/shmupX/browser/org.chromium.Chromium",
    "org.chromium.Chromium",
  ]);
});

Deno.test("no flatpak binary means no Flatpak candidates", () => {
  const plan = planBrowserLaunches(
    URL,
    machine({
      path: [],
      files: ["/var/lib/flatpak/exports/bin/org.mozilla.firefox"],
    }),
  );
  assertEquals(plan.map((l) => l.label), ["the default browser (xdg-open)"]);
});

Deno.test("Chromium on PATH comes before Firefox, kiosk + --app on a dedicated profile", () => {
  const plan = planBrowserLaunches(
    URL,
    machine({ path: ["firefox", "google-chrome", "chromium"] }),
  );
  assertEquals(plan.map((l) => l.label), [
    "google-chrome",
    "chromium",
    "firefox",
    "the default browser (xdg-open)",
  ]);
  const chrome = plan[0];
  assertEquals(chrome.cmd, "google-chrome");
  assertEquals(chrome.args, [
    "--user-data-dir=/home/deck/.local/share/shmupX/browser/google-chrome",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-session-crashed-bubble",
    "--hide-crash-restore-bubble",
    "--password-store=basic",
    "--kiosk",
    `--app=${URL}`,
  ]);
  assertEquals(chrome.profileFiles, undefined);
  const firefox = plan[2];
  assertEquals(firefox.args, [
    "--profile",
    "/home/deck/.local/share/shmupX/browser/firefox",
    "--no-remote",
    "--kiosk",
    URL,
  ]);
});

Deno.test("--windowed drops the kiosk flags but keeps the app window and profile", () => {
  const plan = planBrowserLaunches(
    URL,
    machine({ path: ["chromium", "firefox"], windowed: true }),
  );
  const chromium = plan[0];
  assert(!chromium.args.includes("--kiosk"));
  assert(chromium.args.includes(`--app=${URL}`));
  assert(chromium.args.some((a) => a.startsWith("--user-data-dir=")));
  const firefox = plan[1];
  assertEquals(firefox.args.slice(-2), ["--new-window", URL]);
  assert(!firefox.args.includes("--kiosk"));
});

Deno.test("SHMUPX_BROWSER=default is the system opener alone", () => {
  for (const value of ["default", "xdg-open", "SYSTEM"]) {
    const plan = planBrowserLaunches(
      URL,
      machine({
        env: { HOME: "/home/deck", SHMUPX_BROWSER: value },
        path: ["google-chrome", "firefox"],
      }),
    );
    assertEquals(plan.map((l) => l.label), ["the default browser (xdg-open)"]);
  }
});

Deno.test("SHMUPX_BROWSER names a browser: by path, by name, by Flatpak id", () => {
  const byPath = planBrowserLaunches(
    URL,
    machine({
      env: { HOME: "/home/deck", SHMUPX_BROWSER: "/opt/brave/brave" },
    }),
  );
  assertEquals(byPath.length, 2, "the override, then the system opener");
  assertEquals(byPath[0].cmd, "/opt/brave/brave");
  assert(byPath[0].args.includes("--kiosk"));
  assertEquals(
    byPath[0].profileDir,
    "/home/deck/.local/share/shmupX/browser/brave",
  );

  const byName = planBrowserLaunches(
    URL,
    machine({ env: { HOME: "/home/deck", SHMUPX_BROWSER: "firefox-esr" } }),
  )[0];
  assertEquals(byName.cmd, "firefox-esr");
  assertEquals(byName.args[0], "--profile");
  assertEquals(byName.profileFiles, { "user.js": FIREFOX_USER_JS });

  const byId = planBrowserLaunches(
    URL,
    machine({
      env: { HOME: "/home/deck", SHMUPX_BROWSER: "com.brave.Browser" },
    }),
  )[0];
  assertEquals(byId.label, "Brave (Flatpak)");
  assertEquals(byId.cmd, "flatpak");
  assertEquals(byId.args.slice(0, 3), [
    "run",
    "--filesystem=/home/deck/.local/share/shmupX/browser/com.brave.Browser",
    "com.brave.Browser",
  ]);

  // Something unrecognised is run as `<cmd> <url>`, managed, with no profile
  // to pass — the early-exit rule in the launcher covers a wrong guess.
  const unknown = planBrowserLaunches(
    URL,
    machine({
      env: { HOME: "/home/deck", SHMUPX_BROWSER: "/usr/bin/epiphany" },
    }),
  )[0];
  assertEquals(unknown.args, [URL]);
  assert(unknown.managed);
  assertEquals(unknown.profileDir, undefined);
});

Deno.test("Windows: Chrome and Edge from their install paths, `start` last", () => {
  const env = {
    ProgramFiles: "C:\\Program Files",
    "ProgramFiles(x86)": "C:\\Program Files (x86)",
    LOCALAPPDATA: "C:\\Users\\dan\\AppData\\Local",
  };
  const edge =
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
  const plan = planBrowserLaunches(
    URL,
    machine({
      os: "windows",
      env,
      dataDir: launcherDataDir("windows", env),
      files: [edge],
    }),
  );
  assertEquals(plan.map((l) => l.label), [
    "Microsoft Edge",
    "the default browser (start)",
  ]);
  assertEquals(plan[0].cmd, edge);
  assertEquals(
    plan[0].args[0],
    "--user-data-dir=C:\\Users\\dan\\AppData\\Local\\shmupX\\browser\\msedge",
  );
  assert(!plan[0].args.includes("--password-store=basic"));
  assertEquals(plan[1].args, ["/c", "start", "", URL]);
});

Deno.test("macOS: just `open`, until SHMUPX_BROWSER says otherwise", () => {
  const plan = planBrowserLaunches(
    URL,
    machine({ os: "darwin", env: { HOME: "/Users/dan" } }),
  );
  assertEquals(plan.map((l: BrowserLaunch) => l.cmd), ["open"]);
});

Deno.test("launcherDataDir per platform", () => {
  assertEquals(
    launcherDataDir("linux", { HOME: "/home/deck" }),
    "/home/deck/.local/share/shmupX",
  );
  assertEquals(
    launcherDataDir("linux", { HOME: "/home/deck", XDG_DATA_HOME: "/data" }),
    "/data/shmupX",
  );
  assertEquals(
    launcherDataDir("windows", {
      LOCALAPPDATA: "C:\\Users\\dan\\AppData\\Local",
    }),
    "C:\\Users\\dan\\AppData\\Local\\shmupX",
  );
  assertEquals(
    launcherDataDir("darwin", { HOME: "/Users/dan" }),
    "/Users/dan/Library/Application Support/shmupX",
  );
});

Deno.test("engineOf reads the family off the file name", () => {
  assertEquals(engineOf("/usr/bin/google-chrome-stable"), "chromium");
  assertEquals(
    engineOf("C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"),
    "chromium",
  );
  assertEquals(engineOf("org.mozilla.firefox"), "firefox");
  assertEquals(engineOf("librewolf"), "firefox");
  assertEquals(engineOf("/usr/bin/epiphany"), "unknown");
});

Deno.test("cleanBrowserEnv drops Steam's variables and restores the pre-Steam PATHs", () => {
  const env = {
    HOME: "/home/deck",
    DISPLAY: ":1",
    PATH: "/steam/runtime/bin:/usr/bin",
    SYSTEM_PATH: "/usr/local/bin:/usr/bin",
    LD_LIBRARY_PATH: "/steam/runtime/lib",
    SYSTEM_LD_LIBRARY_PATH: "/opt/lib",
    LD_PRELOAD: "/steam/gameoverlayrenderer.so",
    STEAM_RUNTIME: "/steam/runtime",
    STEAM_COMPAT_CLIENT_INSTALL_PATH: "/steam",
    SteamAppId: "0",
    SteamGameId: "12345",
    SteamOverlayGameId: "12345",
    PRESSURE_VESSEL_RUNTIME: "sniper",
    ENABLE_VK_LAYER_VALVE_steam_overlay_1: "1",
    SDL_GAMECONTROLLERCONFIG: "keep-me",
  };
  assertEquals(cleanBrowserEnv(env), {
    HOME: "/home/deck",
    DISPLAY: ":1",
    PATH: "/usr/local/bin:/usr/bin",
    SYSTEM_PATH: "/usr/local/bin:/usr/bin",
    LD_LIBRARY_PATH: "/opt/lib",
    SYSTEM_LD_LIBRARY_PATH: "/opt/lib",
    SDL_GAMECONTROLLERCONFIG: "keep-me",
  });
});

Deno.test("cleanBrowserEnv: an empty SYSTEM_LD_LIBRARY_PATH unsets LD_LIBRARY_PATH; no Steam, no change", () => {
  assertEquals(
    cleanBrowserEnv({
      LD_LIBRARY_PATH: "/steam/runtime/lib",
      SYSTEM_LD_LIBRARY_PATH: "",
    }),
    { SYSTEM_LD_LIBRARY_PATH: "" },
  );
  const plain = {
    HOME: "/home/dan",
    PATH: "/usr/bin",
    LD_LIBRARY_PATH: "/opt/lib",
  };
  assertEquals(cleanBrowserEnv(plain), plain);
});
