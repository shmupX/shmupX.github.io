// Put a level in one of Dezaemon 2's five save slots on Mednafen's cartridge —
// the Windows leg of `deno task sav:inject`, reached from scripts/sav-inject.ts.
//
// It is TypeScript rather than a shell script for one reason: native Windows
// has no `sh`, so it cannot run scripts/inject-openemu.sh the way the Linux leg
// does. It therefore imports the very same merge those two use —
// lib/cart-inject.ts, through scripts/inject-cart.ts — and adds only what
// differs per platform: finding the cart, refusing while Mednafen is running,
// and starting the game.
//
// The cart is the one the user's own "Dezaemon 2.bat" launcher points Mednafen
// at. That .bat is:
//
//   powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-cart.ps1"
//   start "" "%~dp0mednafen\mednafen.exe" "%~dp0Dezaemon 2 (Japan)\Dezaemon 2 (Japan).cue"
//
// so <base> is the folder holding the .bat, and <base>\mednafen\sav is where
// the cart usually is — but see the base-directory note below, because it is
// not the only place Mednafen looks. Set DEZAEMON_BAT to that .bat (or
// MEDNAFEN_SAV to the sav folder) when it is not somewhere obvious.
//
// This does NOT inject by handing a .sav to install-cart.ps1. That script
// REPLACES the cart with the newest one waiting in incoming\ or
// Downloads\Dez 2 - *.sav, which would flatten the other four slots; sav:inject
// exists precisely to merge instead. That is also why the game is started with
// the .bat's OWN second line — mednafen.exe on the .cue, same folder, same
// mednafen.cfg, same pad mapping — rather than by running the .bat: the .bat
// runs install-cart.ps1 first, and this file cannot see that script's source,
// so the list of places it takes carts from is a reconstruction and any place
// missing from it would silently flatten the injection. The .bat is still the
// fallback when mednafen.exe or the disc cannot be found, and a warning names
// anything waiting either way.
//
// Where the cart is: Mednafen's documented base directory is %MEDNAFEN_HOME%,
// else %HOME%\.mednafen, and only when NEITHER is set — the usual state of a
// Windows session, but not of one started from Git Bash or MSYS2 — the folder
// mednafen.exe is in. All three are looked in, and the emulator this file
// starts is pinned to the one that was written.
import { basename, dirname, join, resolve } from "@std/path";
import {
  buildSav,
  injectCart,
  InjectError,
  parseInjectArgs,
  ROOT,
  tilde,
  USAGE,
} from "@/scripts/inject-cart.ts";

const IS_WINDOWS = Deno.build.os === "windows";
const env = (k: string) => Deno.env.get(k) || "";

async function isFile(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isFile;
  } catch {
    return false;
  }
}
async function isDir(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isDirectory;
  } catch {
    return false;
  }
}
/** Every file directly in `dir`, or [] when there is no such directory. */
async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  try {
    for await (const e of Deno.readDir(dir)) if (e.isFile) out.push(e.name);
  } catch { /* no such directory */ }
  return out.sort();
}

/** The launcher's own name, and the folder layout it implies. */
const BAT_NAMES = ["Dezaemon 2.bat", "Dezaemon 2.cmd"];

/** Where to look for the launcher, in order. %OneDrive% matters: a Surface
 * signed in to a Microsoft account has its Desktop and Documents moved there,
 * so %USERPROFILE%\Desktop may not exist at all. */
export function probeBases(
  get: (k: string) => string = env,
  root: string = ROOT,
): string[] {
  const home = get("USERPROFILE") || get("HOME");
  const one = get("OneDrive") || get("OneDriveConsumer");
  const dirs = [
    home && join(home, "Desktop"),
    one && join(one, "Desktop"),
    home && join(home, "saturn"),
    home && join(home, "Dezaemon2"),
    home && join(home, "Downloads"),
    home && join(home, "Documents"),
    one && join(one, "Documents"),
    home,
    dirname(root),
    root,
  ].filter((d): d is string => !!d);
  return [...new Set(dirs)];
}

/** The folder holding "Dezaemon 2.bat" (or a mednafen\ folder), and the .bat
 * itself when there is one. */
export async function findBase(): Promise<
  { base: string; bat: string | null }
> {
  const explicit = env("DEZAEMON_BAT");
  if (explicit) {
    if (await isDir(explicit)) {
      for (const n of BAT_NAMES) {
        if (await isFile(join(explicit, n))) {
          return { base: explicit, bat: join(explicit, n) };
        }
      }
      return { base: explicit, bat: null };
    }
    if (await isFile(explicit)) {
      return { base: dirname(explicit), bat: explicit };
    }
    throw new InjectError(
      `DEZAEMON_BAT is "${explicit}", and there is no such file or folder. Point it at your "Dezaemon 2.bat", or set MEDNAFEN_SAV to the mednafen\\sav folder.`,
    );
  }
  for (const dir of probeBases()) {
    for (const n of BAT_NAMES) {
      if (await isFile(join(dir, n))) return { base: dir, bat: join(dir, n) };
    }
    if (await isFile(join(dir, "mednafen", "mednafen.exe"))) {
      return { base: dir, bat: null };
    }
  }
  throw new InjectError(
    `cannot find "Dezaemon 2.bat". Set DEZAEMON_BAT to its full path, e.g.\n` +
      `         set DEZAEMON_BAT=C:\\Users\\you\\Desktop\\Dezaemon 2.bat\n` +
      `       (or set MEDNAFEN_SAV to the mednafen\\sav folder, or pass --cart <file>.bcr). Looked in:\n` +
      probeBases().map((d) => `         ${d}`).join("\n"),
  );
}

/**
 * Mednafen's own base directory, from its documentation:
 *
 *   > If the "HOME" environment variable is set, it will be suffixed with
 *   > "/.mednafen" and used as the base directory. If the "MEDNAFEN_HOME"
 *   > environment variable is set, it will be used as the base directory. […]
 *   > On Microsoft Windows, these conditions are typically not met, in which
 *   > case the directory the Mednafen executable is in will be used.
 *
 * "Typically" is why this exists: a session started from Git Bash, MSYS2 or
 * Cygwin sets HOME, and then Mednafen reads %HOME%\.mednafen\sav and not the
 * folder beside mednafen.exe. Writing the wrong one of those puts the level on
 * a cart the LOAD screen never shows. MEDNAFEN_HOME is checked last because the
 * documentation applies it last.
 */
export function mednafenBase(
  get: (k: string) => string = env,
  exeDir = "",
): string {
  const home = get("HOME");
  const explicit = get("MEDNAFEN_HOME");
  return explicit || (home ? join(home, ".mednafen") : exeDir);
}

/** A stem is "hashed" when its last dot-separated part is Mednafen's 32-hex
 * game md5 — <disc>.<md5> rather than plain <disc>. */
export const isHashed = (stem: string): boolean =>
  /\.[0-9a-f]{32}$/i.test(stem);

/**
 * Which save set in `names` is the cart, by the same rule as the Linux leg.
 * Mednafen's stock filesys.fname_sav is "%f.%M%x", and %M is empty on the
 * first evaluation and "<md5>." on the second — so it opens "<disc>.bcr" when
 * that exists and "<disc>.<md5>.bcr" only when it does not. Two names for one
 * disc is therefore normal, and the un-hashed one is the live cart.
 */
export function chooseCart(
  names: string[],
  savDir: string,
): { stem: string; note: string | null } {
  // One extension at a time, .bcr first — the same order, and the same stop at
  // the first extension that matches anything, as the Linux leg's glob loop.
  // It matters: with only "<disc>.bkr" and "<disc>.<md5>.bcr" on disk, looking
  // at every extension at once finds both stems, prefers the un-hashed one and
  // creates "<disc>.bcr" from a blank partition — which Mednafen then reads in
  // place of the real cart, orphaning every save on it. Only stems that carry
  // the cart itself may win while any of them does.
  for (const ext of ["bcr", "bkr", "smpc"]) {
    const re = new RegExp(`^(dezaemon.*)\\.${ext}$`, "i");
    const stems = new Set<string>();
    for (const n of names) {
      const m = re.exec(n);
      if (m) stems.add(m[1]);
    }
    if (stems.size === 0) continue;
    const plain = [...stems].filter((s) => !isHashed(s)).sort();
    const hashed = [...stems].filter(isHashed).sort();
    if (
      plain.length === 1 && hashed.length === 1 &&
      hashed[0].startsWith(plain[0] + ".")
    ) {
      return {
        stem: plain[0],
        note: `note     : ${
          hashed[0]
        }.${ext} is here too; Mednafen reads the un-hashed name when it exists, so that is the one written. Pass --cart to choose the other.`,
      };
    }
    if (plain.length === 1 && hashed.length === 0) {
      return { stem: plain[0], note: null };
    }
    if (plain.length === 0 && hashed.length === 1) {
      return { stem: hashed[0], note: null };
    }
    throw new InjectError(
      `${
        plain.length + hashed.length
      } Dezaemon 2 saves in "${savDir}" — cannot tell which disc you mean:\n` +
        [...plain, ...hashed].map((st) => `  ${st}.${ext}`).join("\n") +
        `\n  pass --cart with one of those.`,
    );
  }
  throw new InjectError(
    `no Dezaemon 2 save in "${savDir}". Mednafen writes the cart the first time the game saves — start Dezaemon 2 with your own launcher once and quit it, then run this again. Or pass --cart PATH.`,
  );
}

/** Does this directory hold a Dezaemon 2 save set? */
async function hasCart(dir: string): Promise<boolean> {
  return (await listFiles(dir)).some((n) =>
    /^dezaemon.*\.(bcr|bkr|smpc)$/i.test(n)
  );
}

/** The disc image the launcher would boot: <base>\Dezaemon 2 (Japan)\*.cue,
 * else DEZAEMON_DISC. Null when there is none to be found. */
async function findDiscUnder(base: string): Promise<string | null> {
  const folder = join(base, "Dezaemon 2 (Japan)");
  const named = join(folder, "Dezaemon 2 (Japan).cue");
  if (await isFile(named)) return named;
  for (const n of await listFiles(folder)) {
    if (n.toLowerCase().endsWith(".cue")) return join(folder, n);
  }
  const explicit = env("DEZAEMON_DISC");
  if (explicit && await isFile(explicit)) return explicit;
  return null;
}

/** Carts waiting for install-cart.ps1, which would replace the whole cart. */
async function waitingCarts(base: string): Promise<string[]> {
  const out: string[] = [];
  const incoming = join(base, "incoming");
  for (const n of await listFiles(incoming)) {
    if (/\.(sav|bcr)$/i.test(n)) out.push(join(incoming, n));
  }
  const home = env("USERPROFILE") || env("HOME");
  if (home) {
    const downloads = join(home, "Downloads");
    for (const n of await listFiles(downloads)) {
      if (/^Dez 2 - .*\.sav$/i.test(n)) out.push(join(downloads, n));
    }
  }
  return out;
}

/** Is Mednafen running? It rewrites its battery saves when it exits, over
 * whatever is on disk. tasklist is in System32 on every Windows; the image
 * name is not localised even though its "no tasks" line is. */
async function mednafenRunning(): Promise<boolean> {
  if (!IS_WINDOWS) return false;
  try {
    const { stdout } = await new Deno.Command(
      join(env("SystemRoot") || "C:\\Windows", "System32", "tasklist.exe"),
      {
        args: ["/FO", "CSV", "/NH", "/FI", "IMAGENAME eq mednafen.exe"],
        stdout: "piped",
        stderr: "null",
      },
    ).output();
    return new TextDecoder().decode(stdout).toLowerCase().includes(
      "mednafen.exe",
    );
  } catch {
    // No tasklist, or it would not run: no check is better than a false one.
    return false;
  }
}

/**
 * Start the game, and never let that undo the run.
 *
 * By the time this is called the level is on the cart and has been read back
 * and verified. A launcher that will not start — AppLocker or an EDR policy
 * refusing cmd.exe on a managed device, the .bat deleted between the stat and
 * the spawn, %SystemRoot%\System32 missing from PATH — is a nuisance, not a
 * failure of the injection, so it is reported as a note and the task still
 * succeeds. `extra` is merged into the inherited environment, not replacing it.
 */
async function launch(
  what: string,
  cmd: string,
  args: string[],
  cwd: string,
  extra: Record<string, string> = {},
): Promise<void> {
  try {
    const { code } = await new Deno.Command(cmd, {
      args,
      cwd,
      env: extra,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    }).output();
    if (code !== 0) {
      console.error(
        `note     : ${what} exited ${code}. The level is on the cart either way.`,
      );
    }
  } catch (e) {
    console.error(
      `note     : could not start ${what}: ${
        (e as Error).message
      }. The level is on the cart; start Dezaemon 2 yourself, then LOAD.`,
    );
  }
}

async function main(): Promise<number> {
  const args = parseInjectArgs(Deno.args);
  if (args.help) {
    console.log(USAGE);
    return 0;
  }

  // --- the launcher's folder ------------------------------------------------
  // Wanted even when the cart is named directly: it is what the install-cart.ps1
  // warning and the launch below are built out of. Not finding it is only fatal
  // when it is also the only way to find the cart, so the throw is deferred.
  let base: string | null = null;
  let bat: string | null = null;
  let baseError: InjectError | null = null;
  try {
    ({ base, bat } = await findBase());
  } catch (e) {
    if (!(e instanceof InjectError)) throw e;
    // A DEZAEMON_BAT that names nothing is a typo the person can fix, and
    // saying so beats quietly carrying on with some other folder's cart.
    if (env("DEZAEMON_BAT")) throw e;
    baseError = e;
  }
  const exeDir = base ? join(base, "mednafen") : "";

  // --- the cart ------------------------------------------------------------
  let bcr: string;
  let savDir = "";
  let note: string | null = null;
  if (args.cart) {
    bcr = resolve(args.cart);
    savDir = dirname(bcr);
    // A save set whose cart has never been written is fine — the .bcr only
    // appears once the game saves — but a typo is not.
    const stem = bcr.replace(/\.bcr$/i, "");
    if (
      !await isFile(bcr) && !await isFile(`${stem}.bkr`) &&
      !await isFile(`${stem}.smpc`)
    ) {
      throw new InjectError(`no such cart save: ${bcr}`);
    }
  } else {
    // Every directory this machine's Mednafen might keep its saves in, in the
    // order that answers "which of these is the cart the game actually reads?".
    // The first two are this repo's own overrides and stand alone; the rest are
    // Mednafen's documented rule, which does not stop at the first that exists
    // — a %HOME% set by Git Bash makes %HOME%\.mednafen\sav the base directory
    // even when the folder beside mednafen.exe is the one with the cart in it.
    // So the first candidate that HAS a Dezaemon save wins, and the others are
    // named when more than one does.
    const sav = env("MEDNAFEN_SAV");
    const bin = env("MEDNAFEN_BIN");
    const candidates: string[] = sav
      ? [sav]
      : /\.exe$/i.test(bin)
      ? [join(dirname(bin), "sav")]
      : [
        env("MEDNAFEN_HOME") && join(env("MEDNAFEN_HOME"), "sav"),
        env("HOME") && join(env("HOME"), ".mednafen", "sav"),
        exeDir && join(exeDir, "sav"),
      ].filter((d): d is string => !!d);
    // Nothing to look in at all: no override, no %MEDNAFEN_HOME%, no %HOME%,
    // and no launcher folder either. That last one is the failure worth
    // reporting, and findBase() has already written it.
    if (candidates.length === 0) {
      throw baseError ?? new InjectError(
        `no Mednafen save directory could be worked out. Set MEDNAFEN_SAV to it, or pass --cart PATH.`,
      );
    }
    const withCart: string[] = [];
    for (const d of candidates) if (await hasCart(d)) withCart.push(resolve(d));
    if (withCart.length === 0) {
      throw new InjectError(
        `no Dezaemon 2 save in ${candidates.length === 1 ? "" : "any of "}${
          candidates.map((d) => `"${tilde(resolve(d))}"`).join(", ")
        }. Mednafen writes the cart the first time the game saves — start Dezaemon 2 with your own launcher once and quit it, then run this again. Or point MEDNAFEN_SAV at the save folder, or pass --cart PATH.` +
          // The launcher folder is one of the places looked in, so when it was
          // not found either, that is half the answer to "why is it empty?".
          (baseError ? `\n       ...and ${baseError.message}` : ""),
      );
    }
    savDir = withCart[0];
    if (withCart.length > 1) {
      note = `note     : a Dezaemon 2 save is in ${
        withCart.slice(1).map((d) => `"${tilde(d)}"`).join(" and ")
      } too. Mednafen reads ${
        JSON.stringify(tilde(savDir))
      } with the environment this ran in, so that is the one written. Set MEDNAFEN_SAV to choose the other.`;
    }
    const chosen = chooseCart(await listFiles(savDir), savDir);
    note = [note, chosen.note].filter(Boolean).join("\n") || null;
    bcr = join(savDir, `${chosen.stem}.bcr`);
  }

  // --- is Mednafen about to undo this? -------------------------------------
  // One tasklist, whichever branch is taken. --cart is not exempt: unlike the
  // macOS leg, where --cart means "some cart that is not OpenEmu's", here it is
  // how this very script's note tells you to reach Mednafen's OTHER save name,
  // in Mednafen's own save directory. --force is the way past it.
  const running = await mednafenRunning();
  if (running && !args.force) {
    if (args.dryRun) {
      console.log(
        "note     : Mednafen is running, so a real run would refuse (see --force).",
      );
    } else {
      throw new InjectError(
        "Mednafen is running. It rewrites its battery saves when it exits, so an injection made now would be thrown away. Quit it and run this again, or pass --force.",
      );
    }
  } else if (running) {
    console.log(
      "note     : --force: Mednafen is running. If it has this disc, quitting it will overwrite this cart.",
    );
  }

  // What would undo the injection later. Computed before the dry-run return,
  // because "tell me what will happen" has to include the one thing that
  // silently unhappens it.
  const waiting = base ? await waitingCarts(base) : [];
  const warnAboutWaiting = () => {
    if (!waiting.length) return;
    console.error(
      `warning  : install-cart.ps1 will replace this cart the next time you run "${
        bat ? basename(bat) : "Dezaemon 2.bat"
      }"`,
    );
    for (const w of waiting) console.error(`           ${tilde(w)}`);
    console.error(
      "           It installs the newest waiting cart over mednafen\\sav\\, which would",
    );
    console.error(
      "           flatten every slot including the one just written. Move or delete",
    );
    console.error(
      "           those files first, or start the game from mednafen.exe rather than",
    );
    console.error("           from the .bat.");
  };

  // --- build ---------------------------------------------------------------
  let sav = args.sav ? resolve(args.sav) : "";
  let temporary = false;
  if (sav) {
    if (!await isFile(sav)) throw new InjectError(`no such .sav: ${sav}`);
  } else {
    sav = join(ROOT, "build", "sav", ".inject.sav");
    const code = await buildSav(args.rest, sav);
    if (code !== 0) return code;
    temporary = true;
  }

  // --- merge, back up, write, verify ---------------------------------------
  try {
    await injectCart({
      sav,
      cart: bcr,
      slot: args.slot,
      dryRun: args.dryRun,
      emulator: "Mednafen",
      log: (line) => console.log(line),
    });
  } finally {
    if (temporary) await Deno.remove(sav).catch(() => {});
  }
  if (note) console.log(note);
  warnAboutWaiting();
  if (args.dryRun) return 0;
  if (args.launch === false) return 0;

  // --- start the game ------------------------------------------------------
  if (!base) {
    console.log(
      `note     : no "Dezaemon 2.bat" folder was found, so the game was not started. ` +
        `Start Dezaemon 2 yourself, then LOAD. (Set DEZAEMON_BAT to point at it.)`,
    );
    return 0;
  }
  const exe = join(exeDir, "mednafen.exe");
  const disc = await findDiscUnder(base);

  // Which cart would the emulator we are about to start actually open? Its base
  // directory is %MEDNAFEN_HOME%, else %HOME%\.mednafen, else its own folder —
  // so a shell that sets HOME (Git Bash, MSYS2) sends it somewhere other than
  // mednafen\sav. When that is not where the level went, MEDNAFEN_HOME is
  // pinned to the folder that IS the base directory of the cart just written,
  // which is also where that Mednafen's mednafen.cfg and firmware\ live. When
  // even pinning cannot make the two agree — a --cart or a MEDNAFEN_SAV outside
  // any base directory — nothing is started, because a LOAD screen without the
  // level is a worse outcome than no LOAD screen at all.
  const pin: Record<string, string> = {};
  const wouldRead = join(mednafenBase(env, exeDir), "sav");
  if (wouldRead !== savDir) {
    if (dirname(savDir) === exeDir) {
      pin.MEDNAFEN_HOME = exeDir;
    } else {
      console.log(
        `note     : ${
          tilde(savDir)
        } is not the folder that Mednafen would read (${
          tilde(wouldRead)
        }), so the game was not started. Start Dezaemon 2 yourself, then LOAD.`,
      );
      return 0;
    }
  }

  // The .bat's own second line, rather than the .bat: same folder, same
  // mednafen.cfg, same pad mapping, but without the install-cart.ps1 line at
  // the top of it, whose sources this file can only guess at and whose job is
  // to REPLACE the cart that was just merged.
  if (await isFile(exe) && disc) {
    console.log(`launching: ${tilde(exe)}`);
    if (bat) {
      console.log(
        `           (mednafen.exe on the disc — the second line of ${
          basename(bat)
        } — so install-cart.ps1 cannot replace the cart)`,
      );
    }
    // No -filesys.fname_sav: forcing a save name could point this at a file
    // other than the one just written. The base directory is pinned instead.
    await launch("Mednafen", exe, [disc], exeDir, pin);
    return 0;
  }

  // Only when mednafen.exe or the disc cannot be found is the .bat used, and
  // then only when install-cart.ps1 has nothing to install.
  if (bat && waiting.length === 0) {
    if (/["%]/.test(bat)) {
      console.log(
        `note     : ${
          tilde(bat)
        } cannot be handed to cmd.exe safely (a " or % in the path) and there is no mednafen.exe beside it, so the game was not started.`,
      );
      return 0;
    }
    console.log(`launching: ${tilde(bat)}`);
    console.log(
      "           (no mednafen.exe or disc under that folder, so the .bat itself)",
    );
    // Deno.Command spawns a .bat through cmd.exe itself (Rust's std supplies
    // %SystemRoot%\System32\cmd.exe and does the quoting); no arguments are
    // passed, so nothing of ours reaches cmd. The .bat ends in `start`, so it
    // returns before the game does — unlike the mednafen.exe path above, which
    // holds the terminal until the emulator quits.
    await launch(basename(bat), bat, [], dirname(bat), pin);
    return 0;
  }
  console.log(
    `note     : ${
      waiting.length
        ? "a cart is waiting for install-cart.ps1 and there is no mednafen.exe to start instead"
        : disc
        ? "no mednafen.exe"
        : "no disc"
    } under ${
      tilde(base)
    }, so the game was not started. Start Dezaemon 2 yourself, then LOAD.`,
  );
  return 0;
}

if (import.meta.main) {
  try {
    Deno.exit(await main());
  } catch (e) {
    if (e instanceof InjectError) {
      console.error(`error: ${e.message}`);
      Deno.exit(2);
    }
    throw e;
  }
}
