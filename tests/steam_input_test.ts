// Steam Input is switched off for shmupX's entries on macOS by editing Steam's
// localconfig.vdf (lib/steam-input.ts). That file is the player's whole local
// Steam state, so the rules checked here are about what must NOT happen: a
// byte of it moved, a choice the player made overwritten, a file this cannot
// read written anyway.

import { assert, assertEquals, assertThrows } from "@std/assert";
import { join } from "@std/path";
import {
  findEntry,
  parseTextVdf,
  shmupxShortcutIds,
  type TextBlock,
  turnOffSteamInput,
  withSteamInputOff,
} from "../lib/steam-input.ts";
import { FAVORITES_TAG, makeShortcut } from "../lib/steam-shortcut.ts";
import { VdfError, type VdfMap, writeBinaryVdf } from "../lib/steam-vdf.ts";

// The shape Steam writes: tabs, a key and its value separated by two of them,
// braces on lines of their own. Trimmed from a real client's file.
const LOCALCONFIG = [
  `"UserLocalConfigStore"`,
  `{`,
  `\t"ControllerTypesUsed"\t\t"controller_switch_pro,"`,
  `\t"Software"`,
  `\t{`,
  `\t\t"Valve"`,
  `\t\t{`,
  `\t\t\t"Steam"`,
  `\t\t\t{`,
  `\t\t\t\t"apps"`,
  `\t\t\t\t{`,
  `\t\t\t\t\t"2540148821"`,
  `\t\t\t\t\t{`,
  `\t\t\t\t\t\t"BadgeData"\t\t"020000000809"`,
  `\t\t\t\t\t}`,
  `\t\t\t\t}`,
  `\t\t\t}`,
  `\t\t}`,
  `\t}`,
  `\t"apps"`,
  `\t{`,
  `\t\t"262830"`,
  `\t\t{`,
  `\t\t\t"UseSteamControllerConfig"\t\t"2"`,
  `\t\t\t"SteamControllerRumble"\t\t"-1"`,
  `\t\t\t"SteamControllerRumbleIntensity"\t\t"320"`,
  `\t\t}`,
  `\t}`,
  `\t"controller_config"`,
  `\t{`,
  `\t\t"shmupx"`,
  `\t\t{`,
  `\t\t\t"usetime"\t\t"56.7435302734375"`,
  `\t\t}`,
  `\t}`,
  `}`,
  ``,
].join("\n");

const ID = 2540148821;

/** The top-level apps block of a parsed file. */
function apps(text: string): TextBlock {
  const store = findEntry(parseTextVdf(text), "UserLocalConfigStore")!
    .value as TextBlock;
  return findEntry(store, "apps")!.value as TextBlock;
}

function steamInputOf(text: string, id: number): string | undefined {
  const app = findEntry(apps(text), String(id))?.value;
  return typeof app === "object"
    ? findEntry(app, "UseSteamControllerConfig")?.value as string
    : undefined;
}

/** `after` is `before` with text added and nothing taken away or moved. */
function onlyInserted(before: string, after: string): boolean {
  let i = 0;
  for (const c of after) if (i < before.length && c === before[i]) i++;
  return i === before.length;
}

Deno.test("the parser knows where every block closes", () => {
  const top = parseTextVdf(LOCALCONFIG);
  const store = findEntry(top, "UserLocalConfigStore")!.value as TextBlock;
  assertEquals(LOCALCONFIG[store.open], "{");
  assertEquals(LOCALCONFIG[store.close], "}");
  assertEquals(store.depth, 0);
  const a = apps(LOCALCONFIG);
  assertEquals(a.depth, 1);
  assertEquals(LOCALCONFIG.slice(a.close - 1, a.close + 1), "\t}");
  // Keys are matched the way Steam matches them.
  assert(findEntry(store, "APPS"));
});

Deno.test("a new entry is added to the top-level apps, and only that", () => {
  const { text, changed, kept } = withSteamInputOff(LOCALCONFIG, [ID]);
  assertEquals(changed, [ID]);
  assertEquals(kept, []);
  assertEquals(steamInputOf(text, ID), "0");
  // Not the like-named block deep under Software/Valve/Steam.
  assert(
    text.includes(`\t\t\t\t\t\t"BadgeData"\t\t"020000000809"\n\t\t\t\t\t}`),
  );
  assert(onlyInserted(LOCALCONFIG, text));
  // Written the way Steam writes it, so the client reads it back unchanged.
  assert(text.includes(
    `\t\t"2540148821"\n\t\t{\n\t\t\t"UseSteamControllerConfig"\t\t"0"\n` +
      `\t\t\t"SteamControllerRumble"\t\t"-1"\n` +
      `\t\t\t"SteamControllerRumbleIntensity"\t\t"320"\n\t\t}\n\t}\n`,
  ));
});

Deno.test("a choice the player already made is kept, whatever it is", () => {
  const { text, changed, kept } = withSteamInputOff(LOCALCONFIG, [262830]);
  assertEquals(changed, []);
  assertEquals(kept, [262830]);
  assertEquals(text, LOCALCONFIG);
});

Deno.test("an entry with other settings gets just the missing keys", () => {
  const withRumble = LOCALCONFIG.replace(
    `\t\t"262830"`,
    `\t\t"2540148821"\n\t\t{\n\t\t\t"SteamControllerRumble"\t\t"1"\n\t\t}\n\t\t"262830"`,
  );
  const { text, changed } = withSteamInputOff(withRumble, [ID]);
  assertEquals(changed, [ID]);
  assertEquals(steamInputOf(text, ID), "0");
  assert(onlyInserted(withRumble, text));
  // The player's rumble setting is theirs.
  assertEquals(text.match(/SteamControllerRumble"/g)?.length, 2);
  assert(text.includes(`"SteamControllerRumble"\t\t"1"`));
});

Deno.test("a file with no apps block gets one", () => {
  const bare = `"UserLocalConfigStore"\n{\n\t"friends"\n\t{\n\t}\n}\n`;
  const { text } = withSteamInputOff(bare, [ID]);
  assertEquals(steamInputOf(text, ID), "0");
  assert(onlyInserted(bare, text));
});

Deno.test("braces that share a line still get valid output", () => {
  const tight = `"UserLocalConfigStore" { "apps" { } }`;
  const { text } = withSteamInputOff(tight, [ID]);
  assertEquals(steamInputOf(text, ID), "0");
  assert(onlyInserted(tight, text));
});

Deno.test("CRLF files stay CRLF", () => {
  const crlf = LOCALCONFIG.replaceAll("\n", "\r\n");
  const { text } = withSteamInputOff(crlf, [ID]);
  assertEquals(steamInputOf(text, ID), "0");
  assertEquals(text.replaceAll("\r\n", "").includes("\n"), false);
});

Deno.test("several ids in one pass, each once", () => {
  const { text, changed } = withSteamInputOff(LOCALCONFIG, [
    ID,
    3000000001,
    ID,
  ]);
  assertEquals(changed, [ID, 3000000001]);
  assertEquals(steamInputOf(text, 3000000001), "0");
  // And a second pass has nothing left to do.
  assertEquals(withSteamInputOff(text, [ID, 3000000001]).changed, []);
});

Deno.test("signed ids are written the way Steam files them", () => {
  // shortcuts.vdf stores the id as a signed int32.
  const { text } = withSteamInputOff(LOCALCONFIG, [-1754818475]);
  assertEquals(steamInputOf(text, ID), "0");
});

Deno.test("a file this cannot read is refused rather than guessed at", () => {
  assertThrows(
    () => withSteamInputOff(`"UserLocalConfigStore"\n{\n`, [ID]),
    VdfError,
  );
  assertThrows(() => withSteamInputOff(`"Other"\n{\n}\n`, [ID]), VdfError);
  assertThrows(
    () =>
      withSteamInputOff(`"UserLocalConfigStore"\n{\n\t"apps"\t"x"\n}\n`, [ID]),
    VdfError,
  );
  assertThrows(
    () => parseTextVdf(`"a"\n{\n\t"b"\t\t"unterminated\n}\n`),
    VdfError,
  );
});

Deno.test("comments and conditionals do not confuse the parser", () => {
  const text = `// written by hand\n"UserLocalConfigStore"\n{\n` +
    `\t"x"\t\t"1"\t[$OSX]\n\t"apps"\n\t{\n\t}\n}\n`;
  assertEquals(steamInputOf(withSteamInputOff(text, [ID]).text, ID), "0");
});

Deno.test("shmupX's entries are found by tag or by what they run", () => {
  const exe = "/Applications/shmupX.app";
  const root: VdfMap = {
    shortcuts: {
      "0": makeShortcut({ appName: "shmupX", exe, tags: ["shmupX"] }),
      "1": makeShortcut({
        appName: "Some Favorite",
        exe: "/Applications/shmupX.app/Contents/MacOS/laufey",
        launchOptions: "--play some-game",
        tags: [FAVORITES_TAG],
      }),
      "2": makeShortcut({ appName: "Renamed", exe, tags: [] }),
      "3": makeShortcut({
        appName: "Other Game",
        exe: "/Applications/Other.app",
      }),
    },
  };
  const shortcuts = root.shortcuts as VdfMap;
  const idOf = (k: string) => ((shortcuts[k] as VdfMap).appid as number) >>> 0;
  assertEquals(shmupxShortcutIds(root, [exe]), [
    idOf("0"),
    idOf("1"),
    idOf("2"),
  ]);
  // Without the path, the tags still find the two that carry them.
  assertEquals(shmupxShortcutIds(root, []), [idOf("0"), idOf("1")]);
});

Deno.test("only macOS is touched, and only while Steam is closed", async () => {
  const home = await Deno.makeTempDir();
  try {
    const config = join(
      home,
      "Library",
      "Application Support",
      "Steam",
      "userdata",
      "251823600",
      "config",
    );
    await Deno.mkdir(config, { recursive: true });
    await Deno.writeFile(
      join(config, "shortcuts.vdf"),
      writeBinaryVdf({
        shortcuts: {
          "0": makeShortcut({
            appName: "shmupX",
            exe: "/Applications/shmupX.app",
            tags: ["shmupX"],
          }),
        },
      }),
    );
    await Deno.writeTextFile(join(config, "localconfig.vdf"), LOCALCONFIG);
    // Steam's own files are 0755; a rewrite must not quietly change that.
    await Deno.chmod(join(config, "localconfig.vdf"), 0o755);

    const linux = await turnOffSteamInput({
      os: "linux",
      env: { HOME: home },
      exes: [],
    });
    assertEquals(linux.state, "skipped");
    assertEquals(
      await Deno.readTextFile(join(config, "localconfig.vdf")),
      LOCALCONFIG,
    );

    // Whether this machine's Steam is running is not something a test can
    // arrange, so only the outcome that matches it is checked.
    const mac = await turnOffSteamInput({
      os: "darwin",
      env: { HOME: home },
      exes: ["/Applications/shmupX.app"],
    });
    const after = await Deno.readTextFile(join(config, "localconfig.vdf"));
    if (mac.state === "steam-open") {
      assertEquals(after, LOCALCONFIG);
    } else {
      assertEquals(mac.state, "done");
      assertEquals(mac.changed, 1);
      assertEquals(steamInputOf(after, ID), "0");
      assert(onlyInserted(LOCALCONFIG, after));
      assertEquals(
        (await Deno.stat(join(config, "localconfig.vdf"))).mode! & 0o777,
        0o755,
      );
      // No temp file left beside it.
      const names = [];
      for await (const e of Deno.readDir(config)) names.push(e.name);
      assertEquals(names.sort(), ["localconfig.vdf", "shortcuts.vdf"]);
    }
  } finally {
    await Deno.remove(home, { recursive: true });
  }
});
