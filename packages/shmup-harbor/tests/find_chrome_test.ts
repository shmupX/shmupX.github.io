// Finding the browser a tool drives, from what a person typed.
//
// `--chrome` and $CHROME_BIN are taken at their word, but a word typed on
// Windows often is not the path it looks like: Explorer's "Copy as path"
// quotes it, `setx` from PowerShell can keep %LOCALAPPDATA% unexpanded, and
// Chrome's Application folder is an easy slip for chrome.exe itself. A
// terminal opened before `setx` never sees the variable at all, so findChrome
// reads what Windows saved; that half needs Windows and is only reachable
// there, but the parsing it rests on is pinned here.

import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import {
  browserAt,
  findChrome,
  normalizeBrowserPath,
  parseRegQuery,
} from "../tools/sav-profiler/lib/web.ts";

const env = (vars: Record<string, string>) => (name: string) => vars[name];

Deno.test("a typed browser path loses its quotes and gains its variables", () => {
  const e = env({
    LOCALAPPDATA: "C:\\Users\\dan\\AppData\\Local",
    HOME: "/home/dan",
  });
  const chrome = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
  // Explorer's "Copy as path", pasted into the Environment Variables dialog.
  assertEquals(normalizeBrowserPath(`"${chrome}"`, e), chrome);
  assertEquals(normalizeBrowserPath(`  '${chrome}' `, e), chrome);
  // `setx` from PowerShell keeps %VAR% as typed.
  assertEquals(
    normalizeBrowserPath(
      "%LOCALAPPDATA%\\Google\\Chrome\\Application\\chrome.exe",
      e,
    ),
    "C:\\Users\\dan\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe",
  );
  // A variable that is not set stays as it was, to be shown in the error.
  assertEquals(
    normalizeBrowserPath("%NOPE%\\chrome.exe", e),
    "%NOPE%\\chrome.exe",
  );
  assertEquals(
    normalizeBrowserPath("~/bin/chromium", e),
    "/home/dan/bin/chromium",
  );
  // A quote at one end only is part of the path, not a wrapper.
  assertEquals(normalizeBrowserPath('"C:\\x', e), '"C:\\x');
  assertEquals(normalizeBrowserPath(chrome, e), chrome);
});

Deno.test("reg query output gives up its value", () => {
  assertEquals(
    parseRegQuery(
      "\r\nHKEY_CURRENT_USER\\Environment\r\n    CHROME_BIN    REG_SZ    " +
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe\r\n\r\n",
    ),
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  );
  assertEquals(
    parseRegQuery(
      "HKEY_CURRENT_USER\\Environment\n    CHROME_BIN    REG_EXPAND_SZ    " +
        "%LOCALAPPDATA%\\Chromium\\chrome.exe  \n",
    ),
    "%LOCALAPPDATA%\\Chromium\\chrome.exe",
  );
  // App Paths keep the path as the key's default value.
  assertEquals(
    parseRegQuery(
      "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\" +
        "App Paths\\chrome.exe\r\n    (Default)    REG_SZ    " +
        "D:\\Apps\\Chrome\\chrome.exe\r\n    Path    REG_SZ    D:\\Apps\\Chrome\r\n",
    ),
    "D:\\Apps\\Chrome\\chrome.exe",
  );
  assertEquals(parseRegQuery("ERROR: The system was unable to find"), null);
});

Deno.test("a browser is found at its path, in its folder, or in its .app", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const app = join(dir, "Application");
    await Deno.mkdir(app);
    const exe = join(app, "chrome.exe");
    await Deno.writeTextFile(exe, "");
    assertEquals(await browserAt(exe), exe);
    assertEquals(await browserAt(app), exe);
    const bundle = join(dir, "Google Chrome.app");
    await Deno.mkdir(join(bundle, "Contents", "MacOS"), { recursive: true });
    await Deno.writeTextFile(
      join(bundle, "Contents", "MacOS", "Google Chrome"),
      "",
    );
    assertEquals(
      await browserAt(bundle),
      join(bundle, "Contents", "MacOS", "Google Chrome"),
    );
    assertEquals(await browserAt(join(dir, "missing.exe")), null);
    // A folder with no browser in it is no browser.
    assertEquals(await browserAt(dir), null);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("findChrome takes the named browser however it was typed, and says what it read when it is not there", async () => {
  const dir = await Deno.makeTempDir();
  const before = Deno.env.get("CHROME_BIN");
  try {
    const exe = join(dir, "chrome.exe");
    await Deno.writeTextFile(exe, "");
    assertEquals(await findChrome(`"${exe}"`), exe);
    assertEquals(await findChrome(dir), exe);

    Deno.env.set("RF_TEST_BROWSER_DIR", dir);
    Deno.env.set("CHROME_BIN", `"%RF_TEST_BROWSER_DIR%"`);
    assertEquals(await findChrome(), exe);

    // Named and not there is an error, never a quiet fall-through to some
    // other browser — and the value is quoted so its quotes show.
    Deno.env.set("CHROME_BIN", `"%RF_TEST_BROWSER_DIR%/nope.exe"`);
    await assertRejects(
      () => findChrome(),
      Error,
      `$CHROME_BIN is "\\"%RF_TEST_BROWSER_DIR%/nope.exe\\"", read as ` +
        JSON.stringify(`${dir}/nope.exe`),
    );
    await assertRejects(
      () => findChrome(join(dir, "missing")),
      Error,
      "--chrome is",
    );
  } finally {
    if (before === undefined) Deno.env.delete("CHROME_BIN");
    else Deno.env.set("CHROME_BIN", before);
    Deno.env.delete("RF_TEST_BROWSER_DIR");
    await Deno.remove(dir, { recursive: true });
  }
});
