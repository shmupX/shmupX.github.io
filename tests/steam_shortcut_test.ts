// "Add to Steam" writes into a file this project did not design and cannot ask
// about: shortcuts.vdf is somebody's entire non-Steam library, in a binary
// format Valve has never documented. Every rule below therefore exists to keep
// one of two things from happening — losing a library that was already there,
// or growing a second shmupX every time the button is pressed.
//
// Steam is not installed on the machine that runs this, and must not need to
// be: the roots are built under a temp directory, and the only bytes parsed are
// ones this code wrote or a fixture hand-assembled from the grammar.

import { assert, assertEquals, assertThrows } from "@std/assert";
import { join } from "@std/path";
import {
  parseBinaryVdf,
  VdfError,
  type VdfMap,
  writeBinaryVdf,
} from "../lib/steam-vdf.ts";
import {
  addShortcut,
  makeShortcut,
  quotePath,
  removeShortcut,
  runGameId,
  shortcutAppId,
  signedAppId,
  unquotePath,
} from "../lib/steam-shortcut.ts";
import {
  candidateRoots,
  installShortcut,
  steamAccounts,
  steamRoots,
} from "../lib/steam-library.ts";

const APPIMAGE = "/home/deck/Applications/shmupX-linux-x86-64.AppImage";

/** Bytes for one node, assembled from the grammar rather than from our writer. */
function node(type: number, key: string, payload: number[]): number[] {
  return [type, ...new TextEncoder().encode(key), 0, ...payload];
}
const str = (s: string) => [...new TextEncoder().encode(s), 0];
const i32 = (n: number) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setInt32(0, n, true);
  return [...b];
};

Deno.test("the grammar reads the way Steam writes it", () => {
  // 0x00 "shortcuts" { 0x00 "0" { 0x02 appid, 0x01 AppName } } 0x08 0x08
  const bytes = Uint8Array.from([
    ...node(0x00, "shortcuts", [
      ...node(0x00, "0", [
        ...node(0x02, "appid", i32(-1802868245)),
        ...node(0x01, "AppName", str("Some Game")),
      ]),
      0x08,
    ]),
    0x08,
  ]);
  const tree = parseBinaryVdf(bytes) as { shortcuts: VdfMap };
  assertEquals(Object.keys(tree), ["shortcuts"]);
  const entry = tree.shortcuts["0"] as VdfMap;
  assertEquals(entry.appid, -1802868245, "int32 is little-endian and signed");
  assertEquals(entry.AppName, "Some Game");
});

Deno.test("anything written comes back identical", () => {
  const tree: VdfMap = {
    shortcuts: {
      "0": {
        appid: -2147483648,
        AppName: "A Game — with a dash and é",
        Exe: '"/opt/a game/run.sh"',
        IsHidden: 0,
        tags: { "0": "handheld", "1": "homebrew" },
      },
      "1": { appid: 5, AppName: "", Exe: '""', tags: {} },
    },
  };
  assertEquals(parseBinaryVdf(writeBinaryVdf(tree)), tree);
});

Deno.test("no file and an empty file are the same empty library", () => {
  assertEquals(parseBinaryVdf(new Uint8Array(0)), {});
  const added = addShortcut({}, { appName: "shmupX", exe: APPIMAGE });
  assertEquals(added.action, "added");
  assertEquals(Object.keys(added.root.shortcuts as VdfMap), ["0"]);
});

Deno.test("a file this code does not fully understand is refused, not rewritten", () => {
  // 0x07 is a uint64 — real in Steam's other KeyValues files, absent from this
  // one. Guessing its length would desynchronise every node after it.
  const bytes = Uint8Array.from([
    ...node(0x00, "shortcuts", [
      ...node(0x07, "mystery", [1, 2, 3, 4, 5, 6, 7, 8]),
      0x08,
    ]),
    0x08,
  ]);
  assertThrows(() => parseBinaryVdf(bytes), VdfError, "0x07");
  // And a file that simply stops mid-string.
  assertThrows(
    () => parseBinaryVdf(Uint8Array.from([0x01, 0x41, 0x42])),
    VdfError,
  );
});

Deno.test("Exe and StartDir are stored quoted, the way Steam stores them", () => {
  const entry = makeShortcut({ appName: "shmupX", exe: APPIMAGE });
  assertEquals(entry.Exe, `"${APPIMAGE}"`);
  assertEquals(entry.StartDir, '"/home/deck/Applications/"');
  assertEquals(quotePath('"/already/quoted"'), '"/already/quoted"');
  assertEquals(unquotePath('"/already/quoted"'), "/already/quoted");
});

Deno.test("the artwork id is stable, and the vdf stores it signed", () => {
  const exe = quotePath(APPIMAGE);
  const id = shortcutAppId(exe, "shmupX");
  assertEquals(id, shortcutAppId(exe, "shmupX"), "same input, same id");
  assert(id > 0x80000000, "the top bit is always set");
  assert(signedAppId(id) < 0, "which reads as negative in an int32 field");
  assertEquals(signedAppId(id) >>> 0, id, "and round-trips back");
  // A different binary or a different name is a different entry.
  assert(shortcutAppId(quotePath("/other/path"), "shmupX") !== id);
  assert(shortcutAppId(exe, "shmupY") !== id);
  assertEquals(runGameId(id), ((BigInt(id) << 32n) | 0x02000000n).toString());
});

Deno.test("every key a current client writes is present", () => {
  const entry = makeShortcut({
    appName: "shmupX",
    exe: APPIMAGE,
    tags: ["homebrew"],
  });
  for (
    const key of [
      "appid",
      "AppName",
      "Exe",
      "StartDir",
      "icon",
      "ShortcutPath",
      "LaunchOptions",
      "IsHidden",
      "AllowDesktopConfig",
      "AllowOverlay",
      "OpenVR",
      "Devkit",
      "DevkitGameID",
      "DevkitOverrideAppID",
      "LastPlayTime",
      "tags",
    ]
  ) {
    assert(key in entry, `missing ${key}`);
  }
  assertEquals(entry.LastPlayTime, 0, "never claim a game was played");
  assertEquals((entry.tags as VdfMap)["0"], "homebrew");
});

Deno.test("pressing the button twice does not grow a second shmupX", () => {
  const first = addShortcut({}, { appName: "shmupX", exe: APPIMAGE });
  const second = addShortcut(first.root, { appName: "shmupX", exe: APPIMAGE });
  assertEquals(second.action, "unchanged");
  assertEquals(Object.keys(second.root.shortcuts as VdfMap).length, 1);
  assertEquals(second.appId, first.appId);
});

Deno.test("an updated AppImage at a new path replaces the entry, keeping its artwork", () => {
  const first = addShortcut({}, { appName: "shmupX", exe: APPIMAGE });
  const moved = "/home/deck/Applications/shmupX-linux-x86-64-2.AppImage";
  const second = addShortcut(first.root, { appName: "shmupX", exe: moved });
  assertEquals(second.action, "updated");
  assertEquals(Object.keys(second.root.shortcuts as VdfMap).length, 1);
  const entry = (second.root.shortcuts as VdfMap)["0"] as VdfMap;
  assertEquals(entry.Exe, `"${moved}"`, "it points at the new binary");
  assertEquals(
    entry.appid,
    signedAppId(first.appId),
    "and keeps the id the player's artwork is filed under",
  );
});

Deno.test("a player who renamed the entry in Steam still gets one shmupX", () => {
  const first = addShortcut({}, { appName: "shmupX", exe: APPIMAGE });
  const renamed = { ...first.root } as VdfMap;
  ((renamed.shortcuts as VdfMap)["0"] as VdfMap).AppName = "shmupX (canary)";
  // Same binary, different name: matched on Exe.
  const again = addShortcut(renamed, { appName: "shmupX", exe: APPIMAGE });
  assertEquals(Object.keys(again.root.shortcuts as VdfMap).length, 1);
});

Deno.test("everybody else's shortcuts survive, and stay contiguous", () => {
  const library: VdfMap = {
    shortcuts: {
      "0": { appid: 11, AppName: "Emulator", Exe: '"/usr/bin/emu"', tags: {} },
      "1": { appid: 22, AppName: "Some Mod", Exe: '"/opt/mod"', tags: {} },
    },
  };
  const added = addShortcut(library, { appName: "shmupX", exe: APPIMAGE });
  const after = added.root.shortcuts as VdfMap;
  assertEquals(Object.keys(after), ["0", "1", "2"]);
  assertEquals((after["0"] as VdfMap).AppName, "Emulator");
  assertEquals((after["1"] as VdfMap).AppName, "Some Mod");
  assertEquals((after["2"] as VdfMap).AppName, "shmupX");

  const removed = removeShortcut(added.root, { appName: "shmupX" });
  assertEquals(removed.removed, 1);
  assertEquals(Object.keys(removed.root.shortcuts as VdfMap), ["0", "1"]);
  assertEquals(
    (removed.root.shortcuts as VdfMap)["1"],
    (library.shortcuts as VdfMap)["1"],
    "the survivors are byte-identical to what was parsed",
  );
});

Deno.test("a key a newer client wrote is carried through an update", () => {
  const library: VdfMap = {
    shortcuts: {
      "0": {
        appid: 99,
        AppName: "shmupX",
        Exe: `"${APPIMAGE}"`,
        SomethingValveAddedLater: "keep me",
        tags: {},
      },
    },
  };
  const added = addShortcut(library, { appName: "shmupX", exe: APPIMAGE });
  assertEquals(
    ((added.root.shortcuts as VdfMap)["0"] as VdfMap).SomethingValveAddedLater,
    "keep me",
  );
});

Deno.test("the search knows where Steam hides on each platform", () => {
  const linux = candidateRoots("linux", { HOME: "/home/deck" });
  assert(linux.some((p) => p.endsWith("/.local/share/Steam")));
  assert(
    linux.some((p) => p.includes("com.valvesoftware.Steam")),
    "the Flatpak install a Steam Deck actually uses",
  );
  assert(linux.some((p) => p.includes("/snap/steam/")));
  assertEquals(
    candidateRoots("darwin", { HOME: "/Users/me" }),
    ["/Users/me/Library/Application Support/Steam"],
  );
  // Windows keeps userdata under the INSTALL directory, not AppData.
  const windows = candidateRoots("windows", {
    "ProgramFiles(x86)": "C:\\Program Files (x86)",
  });
  assert(windows[0].endsWith("Steam"));
  assert(!windows.some((p) => p.includes("AppData")));
  // No home directory is no answer rather than a path relative to nowhere.
  assertEquals(candidateRoots("linux", {}), []);
});

Deno.test("two names for one install are written once, not twice", async () => {
  const home = await Deno.makeTempDir({ prefix: "shmupx-steam-" });
  try {
    const real = join(home, ".local", "share", "Steam");
    await Deno.mkdir(join(real, "userdata", "7777777", "config"), {
      recursive: true,
    });
    // What a real Linux install looks like: ~/.steam/steam is a symlink.
    await Deno.mkdir(join(home, ".steam"), { recursive: true });
    await Deno.symlink(real, join(home, ".steam", "steam"));

    const env = { HOME: home };
    assertEquals(
      (await steamRoots("linux", env)).length,
      1,
      "the symlink and its target are one install",
    );
    const accounts = await steamAccounts((await steamRoots("linux", env))[0]);
    assertEquals(accounts.length, 1);

    const report = await installShortcut(
      { appName: "shmupX", exe: APPIMAGE },
      { os: "linux", env },
    );
    assert(report.ok, report.reason ?? "");
    assertEquals(report.installed.length, 1, "one account, one write");
    assertEquals(report.installed[0].action, "added");
    assertEquals(report.problems, []);

    // And the file Steam will read back is a file this code can read back.
    const written = await Deno.readFile(
      join(accounts[0], "shortcuts.vdf"),
    );
    const tree = parseBinaryVdf(written) as { shortcuts: VdfMap };
    assertEquals(
      ((tree.shortcuts["0"]) as VdfMap).Exe,
      `"${APPIMAGE}"`,
    );

    // Pressing it again is a no-op rather than a duplicate.
    const again = await installShortcut(
      { appName: "shmupX", exe: APPIMAGE },
      { os: "linux", env },
    );
    assertEquals(again.installed[0].action, "unchanged");
    assertEquals(
      Object.keys(
        (parseBinaryVdf(
          await Deno.readFile(join(accounts[0], "shortcuts.vdf")),
        ) as {
          shortcuts: VdfMap;
        }).shortcuts,
      ).length,
      1,
    );
  } finally {
    await Deno.remove(home, { recursive: true });
  }
});

Deno.test("a library that cannot be parsed is reported, never overwritten", async () => {
  const home = await Deno.makeTempDir({ prefix: "shmupx-steam-" });
  try {
    const config = join(
      home,
      ".local",
      "share",
      "Steam",
      "userdata",
      "42",
      "config",
    );
    await Deno.mkdir(config, { recursive: true });
    const path = join(config, "shortcuts.vdf");
    const garbage = Uint8Array.from([
      0x00,
      0x73,
      0x00,
      0x07,
      0x78,
      0x00,
      1,
      2,
      3,
    ]);
    await Deno.writeFile(path, garbage);

    const report = await installShortcut(
      { appName: "shmupX", exe: APPIMAGE },
      { os: "linux", env: { HOME: home } },
    );
    assert(!report.ok);
    assertEquals(report.installed, []);
    assertEquals(report.problems.length, 1);
    assert(report.problems[0].includes("left untouched"));
    assertEquals(
      await Deno.readFile(path),
      garbage,
      "the player's file is byte-for-byte what it was",
    );
  } finally {
    await Deno.remove(home, { recursive: true });
  }
});

Deno.test("no Steam at all says so plainly", async () => {
  const home = await Deno.makeTempDir({ prefix: "shmupx-steam-" });
  try {
    const report = await installShortcut(
      { appName: "shmupX", exe: APPIMAGE },
      { os: "linux", env: { HOME: home } },
    );
    assert(!report.ok);
    assertEquals(report.reason, "no Steam installation found on this machine");
  } finally {
    await Deno.remove(home, { recursive: true });
  }
});
