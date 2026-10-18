// Favorites as games of their own in Steam, the way RetroDECK's Steam Sync
// does it (lib/steam-favorites.ts, static/steam-favorites.js).
//
// A starred dashboard row or shelf game becomes a non-Steam entry that starts
// the launcher with --game or --play; unstarring it takes the entry out. These
// pin what is read as a favorite, the launch options both ways, that a sync
// touches only its own entries — keeping each one's appid and the name the
// player gave it — that the launcher's own ADD TO STEAM never mistakes one for
// itself, and the whole sync against a Steam install laid out on disk.

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  favoriteExe,
  favoriteKeyOf,
  favoritesFrom,
  GAME_FAVS_KEY,
  gridFiles,
  launchArgs,
  launchOptionsFor,
  launchTarget,
  readGameFavs,
  readShelfFavs,
  reconcileFavorites,
  SHELF_FAVS_KEY,
  splitArgs,
  syncFavoritesToSteam,
  titleFromSlug,
} from "../lib/steam-favorites.ts";
import {
  addShortcut,
  FAVORITES_TAG,
  isFavoriteShortcut,
  makeShortcut,
} from "../lib/steam-shortcut.ts";
import {
  parseBinaryVdf,
  type VdfMap,
  writeBinaryVdf,
} from "../lib/steam-vdf.ts";
import * as page from "../static/steam-favorites.js";

const EXE = "/home/p/.local/share/shmupX/app/AppRun";

const values = (games: unknown[], shelf: unknown[]) => ({
  [GAME_FAVS_KEY]: JSON.stringify(games),
  [SHELF_FAVS_KEY]: JSON.stringify(shelf),
});

Deno.test("favorites are read from the page's keys, and anything Steam could not open is left out", () => {
  assertEquals(
    readGameFavs(JSON.stringify([
      { id: "games:shmupx", title: "shmupX", icon: "/icons/2028-icon.png" },
      { id: "games:shmupx", title: "dup" },
      { id: "no-colon" },
      { id: "emu-arcade:metamoqester", title: " " },
      "junk",
    ])),
    [
      { id: "games:shmupx", title: "shmupX", icon: "/icons/2028-icon.png" },
      { id: "emu-arcade:metamoqester", title: "metamoqester" },
    ],
  );
  assertEquals(readGameFavs("{"), []);
  // A shelf id names an export kept in this browser's IndexedDB: not a slug.
  assertEquals(
    readShelfFavs(
      JSON.stringify(["g-fencer-755", "local:abc", "g-fencer-755", 3]),
    ),
    ["g-fencer-755"],
  );
  assertEquals(titleFromSlug("g-fencer-755"), "G Fencer 755");
  assertEquals(
    favoritesFrom(
      values([{ id: "games:shmupx", title: "shmupX" }], [
        "g-fencer-755",
        "zero",
      ]),
      { zero: "ZERO WING" },
    ),
    [
      { key: "game:games:shmupx", game: "games:shmupx", title: "shmupX" },
      {
        key: "shelf:g-fencer-755",
        play: "g-fencer-755",
        title: "G Fencer 755",
      },
      { key: "shelf:zero", play: "zero", title: "ZERO WING" },
    ],
  );
});

Deno.test("launch options go out as Steam stores them and come back as they went", () => {
  assertEquals(
    launchOptionsFor({ play: "g-fencer-755" }),
    "--play g-fencer-755",
  );
  assertEquals(
    launchOptionsFor({ game: "games:shmupx" }),
    "--game games:shmupx",
  );
  assertEquals(launchOptionsFor({ game: "emu-x:a b" }), '--game "emu-x:a b"');
  assertEquals(splitArgs('--game "emu-x:a b" --x'), [
    "--game",
    "emu-x:a b",
    "--x",
  ]);
  assertEquals(splitArgs(`--a "" 'q "x"'`), ["--a", "", 'q "x"']);
  assertEquals(launchTarget(["--play=slug"]), { play: "slug" });
  assertEquals(launchTarget(["--game", "games:shmupx", "--windowed"]), {
    game: "games:shmupx",
  });
  for (const f of [{ play: "z" }, { game: "emu-x:a b" }]) {
    assertEquals(launchTarget(splitArgs(launchOptionsFor(f))), f);
    assertEquals(launchTarget(launchArgs(f)), f);
  }
});

/** A shortcuts.vdf with the launcher's own entry and somebody else's game. */
function library(): VdfMap {
  return {
    shortcuts: {
      "0": makeShortcut({
        appName: "Doom",
        exe: "/usr/bin/doom",
        tags: ["FPS"],
      }),
      "1": makeShortcut({ appName: "shmupX", exe: EXE, tags: ["shmupX"] }),
    },
  };
}

const entries = (root: VdfMap) =>
  Object.values(root.shortcuts as VdfMap) as VdfMap[];

Deno.test("a sync adds, updates and removes only its own entries, and keeps their appid and name", () => {
  const wanted = favoritesFrom(
    values([{ id: "games:shmupx", title: "shmupX" }], ["g-fencer-755"]),
  );
  const first = reconcileFavorites(library(), wanted, { exe: EXE });
  assertEquals(first.added, ["game:games:shmupx", "shelf:g-fencer-755"]);
  const list = entries(first.root);
  assertEquals(list.map((e) => e.AppName), [
    "Doom",
    "shmupX",
    // The launcher already answers to "shmupX": the same binary and name
    // would be the same appid, and share its artwork.
    "shmupX ★",
    "G Fencer 755",
  ]);
  const fav = list[3];
  assertEquals(fav.LaunchOptions, "--play g-fencer-755");
  assert(isFavoriteShortcut(fav));
  assertEquals(favoriteKeyOf(fav), "shelf:g-fencer-755");
  assertEquals(favoriteKeyOf(list[1]), null);
  assert(list[2].appid !== list[1].appid);
  assertEquals(
    first.appIds.get("shelf:g-fencer-755"),
    (fav.appid as number) >>> 0,
  );

  // Again: nothing to do.
  const second = reconcileFavorites(first.root, wanted, { exe: EXE });
  assertEquals([second.added, second.updated, second.removed], [[], [], []]);

  // The player renames one and files it in a collection; the launcher moves.
  fav.AppName = "Fencer!";
  (fav.tags as VdfMap)["1"] = "Shmups";
  const moved = "/opt/shmupX/AppRun";
  const third = reconcileFavorites(first.root, wanted, { exe: moved });
  assertEquals(third.updated.sort(), [
    "game:games:shmupx",
    "shelf:g-fencer-755",
  ]);
  const kept = entries(third.root).find((e) =>
    favoriteKeyOf(e) === "shelf:g-fencer-755"
  )!;
  assertEquals(kept.AppName, "Fencer!");
  assertEquals(kept.appid, fav.appid);
  assertEquals(kept.Exe, `"${moved}"`);
  assertEquals(Object.values(kept.tags as VdfMap), [FAVORITES_TAG, "Shmups"]);

  // Unstarred: its entry goes, and everything else stays where it was.
  const fourth = reconcileFavorites(third.root, wanted.slice(0, 1), {
    exe: moved,
  });
  assertEquals(fourth.removed, ["shelf:g-fencer-755"]);
  assertEquals(fourth.removedAppIds, [(fav.appid as number) >>> 0]);
  assertEquals(entries(fourth.root).map((e) => e.AppName), [
    "Doom",
    "shmupX",
    "shmupX ★",
  ]);
});

Deno.test("ADD TO STEAM never takes a favorite's entry for the launcher's own", () => {
  // Only favorites in the file: same binary, so the old Exe match would have
  // turned the first of them back into the launcher.
  const root: VdfMap = {
    shortcuts: {
      "0": makeShortcut({
        appName: "G Fencer 755",
        exe: EXE,
        launchOptions: "--play g-fencer-755",
        tags: [FAVORITES_TAG],
      }),
    },
  };
  const added = addShortcut(root, {
    appName: "shmupX",
    exe: EXE,
    tags: ["shmupX"],
  });
  assertEquals(added.action, "added");
  const list = entries(added.root);
  assertEquals(list.map((e) => e.AppName), ["G Fencer 755", "shmupX"]);
  assertEquals(list[0].LaunchOptions, "--play g-fencer-755");
});

Deno.test("the sync writes every account's file and the art, and takes both back", async () => {
  const home = await Deno.makeTempDir();
  try {
    const config = join(
      home,
      ".local",
      "share",
      "Steam",
      "userdata",
      "1234",
      "config",
    );
    await Deno.mkdir(config, { recursive: true });
    await Deno.writeFile(
      join(config, "shortcuts.vdf"),
      writeBinaryVdf(library()),
    );
    const env = { HOME: home };
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const asked: string[] = [];
    const wanted = favoritesFrom(values([], ["g-fencer-755"]));
    const report = await syncFavoritesToSteam(wanted, {
      os: "linux",
      env,
      exe: EXE,
      art: (f) => {
        asked.push(f.key);
        return Promise.resolve(png);
      },
    });
    assert(report.ok, report.reason);
    assertEquals([report.accounts, report.added], [1, ["shelf:g-fencer-755"]]);
    const root = parseBinaryVdf(
      await Deno.readFile(join(config, "shortcuts.vdf")),
    );
    const fav = entries(root).find((e) => favoriteKeyOf(e))!;
    const appId = (fav.appid as number) >>> 0;
    for (const file of gridFiles(join(config, "grid"), appId)) {
      assertEquals(await Deno.readFile(file), png);
    }
    // The player's own art is never replaced, and art is not fetched again.
    const mine = gridFiles(join(config, "grid"), appId)[1];
    await Deno.writeFile(mine, new Uint8Array([1]));
    await syncFavoritesToSteam(wanted, {
      os: "linux",
      env,
      exe: EXE,
      art: () => Promise.resolve(png),
    });
    assertEquals(await Deno.readFile(mine), new Uint8Array([1]));
    assertEquals(asked, ["shelf:g-fencer-755"]);

    const off = await syncFavoritesToSteam([], {
      os: "linux",
      env,
      exe: EXE,
      enabled: false,
    });
    assertEquals(off.removed, ["shelf:g-fencer-755"]);
    const after = parseBinaryVdf(
      await Deno.readFile(join(config, "shortcuts.vdf")),
    );
    assertEquals(entries(after).map((e) => e.AppName), ["Doom", "shmupX"]);
    for (const file of gridFiles(join(config, "grid"), appId)) {
      assertEquals(await Deno.stat(file).then(() => true, () => false), false);
    }
    // No Steam at all is a reason, not a throw.
    const none = await syncFavoritesToSteam(wanted, {
      os: "linux",
      env: { HOME: join(home, "nobody") },
      exe: EXE,
    });
    assertEquals(none.ok, false);
    assertEquals(none.steamFound, false);
  } finally {
    await Deno.remove(home, { recursive: true });
  }
});

Deno.test("a favorite runs a file its arguments reach", async () => {
  const dir = await Deno.makeTempDir();
  try {
    assertEquals(
      await favoriteExe({ binary: null, os: "linux", execPath: "" }),
      null,
    );
    // An AppImage that was installed points at the copy that updates itself.
    const installed = join(dir, "app", "AppRun");
    await Deno.mkdir(join(dir, "app"));
    await Deno.writeTextFile(installed, "");
    assertEquals(
      await favoriteExe({
        binary: { path: "/home/p/shmupX.AppImage", kind: "appimage" },
        os: "linux",
        execPath: "/tmp/.mount_x/usr/bin/shmupX",
        installed,
      }),
      installed,
    );
    // The Steam depot's app directory is entered through its AppRun.
    const depot = join(dir, "linux-x86_64");
    await Deno.mkdir(join(depot, "usr", "bin"), { recursive: true });
    await Deno.writeTextFile(join(depot, "AppRun"), "");
    assertEquals(
      await favoriteExe({
        binary: {
          path: join(depot, "usr", "bin", "shmupX"),
          kind: "executable",
        },
        os: "linux",
        execPath: join(depot, "usr", "bin", "shmupX"),
      }),
      join(depot, "AppRun"),
    );
    // A .app is opened, not run: its own binary takes the arguments.
    assertEquals(
      await favoriteExe({
        binary: { path: "/Applications/shmupX.app", kind: "macos-app" },
        os: "darwin",
        execPath: "/Applications/shmupX.app/Contents/MacOS/shmupX",
      }),
      "/Applications/shmupX.app/Contents/MacOS/shmupX",
    );
    assertEquals(
      await favoriteExe({
        binary: {
          path: "C:\\Steam\\steamapps\\common\\shmupX\\shmupX.exe",
          kind: "executable",
        },
        os: "windows",
        execPath: "C:\\Steam\\steamapps\\common\\shmupX\\shmupX.exe",
      }),
      "C:\\Steam\\steamapps\\common\\shmupX\\shmupX.exe",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("the dashboard stars rows by section and finds them again for --game", () => {
  const shmupx = {
    key: "shmupx",
    name: "shmupX",
    icon: "/icons/2028-icon.png",
  };
  const board = {
    key: "metamoqester",
    name: "Metamoqester",
    icon: "https://x/y.png",
  };
  assertEquals(page.favRowId("games", shmupx), "games:shmupx");
  assertEquals(
    page.favRowId("games", { key: "eshop-menu", submenu: true }),
    "",
  );
  assertEquals(page.favRowId("emu-snes", { key: "byo", pinned: true }), "");
  let list = page.toggleGameFav([], "games", shmupx);
  list = page.toggleGameFav(list, "emu-arcade", board);
  assertEquals(list, [
    { id: "games:shmupx", title: "shmupX", icon: "/icons/2028-icon.png" },
    // Only art this server can read is carried.
    { id: "emu-arcade:metamoqester", title: "Metamoqester" },
  ]);
  assert(page.isGameFav(list, "games", shmupx));
  assertEquals(page.toggleGameFav(list, "games", shmupx), [list[1]]);
  assertEquals(
    page.toggleGameFav(list, "games", { submenu: true, key: "x" }),
    null,
  );
  // What the dashboard writes is what the server reads.
  assertEquals(
    readGameFavs(JSON.stringify(list)).map((r) => r.id),
    ["games:shmupx", "emu-arcade:metamoqester"],
  );

  const sections = [
    { id: "games", rows: [shmupx, { key: "eshop-menu", submenu: true }] },
    { id: "emu-arcade", rows: [{ key: "other" }, board] },
  ];
  assertEquals(page.launchTarget(sections, "emu-arcade:metamoqester"), {
    section: 1,
    row: 1,
    key: "metamoqester",
  });
  assertEquals(page.launchTarget(sections, "emu-snes:x"), null);
  assertEquals(page.launchTarget(sections, "nonsense"), null);
  assertEquals(
    page.shelfPlayUrl(
      "/editor/?game=2028-ai",
      "g-fencer-755",
      "http://127.0.0.1:8787",
    ),
    "/editor/?game=2028-ai&play=g-fencer-755",
  );
  assertEquals(page.shelfPlayUrl("/editor/", "local:abc", "http://x"), "");
  assertEquals(page.GAME_FAVS_KEY, GAME_FAVS_KEY);
});
