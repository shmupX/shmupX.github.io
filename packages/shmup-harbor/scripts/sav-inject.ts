// `deno task sav:inject [level]` for whichever machine it is run on. One task,
// one meaning — put a level in a Dezaemon 2 save slot so the game's LOAD screen
// shows it — reached three ways, because the cartridge lives somewhere different
// on each:
//
//   macOS        OpenEmu's Mednafen core, ~/Library/.../Battery Saves
//   Linux / WSL  Mednafen, ~/.mednafen/sav          (the user's dezaemon2.sh)
//   Windows      Mednafen, <base>\mednafen\sav      (the user's "Dezaemon 2.bat")
//
// This file is only the router. The merge is one file, lib/cart-inject.ts,
// which all three legs share (through scripts/inject-cart.ts, their command
// line) and which `deno task sav:run` and the editor's route use too: the
// level goes into one DEZA2____NN slot and every other save on the cart stays
// byte-identical, only the .bcr is written, and the .bkr and .smpc are never
// touched. Every leg takes the same flags, so `--help` is worth reading from
// any of them. What differs is only where the
// cart is, how to tell the emulator is running, and what to start afterwards.
//
// Why a .ts and not `sh scripts/inject-*.sh` in deno.json: `deno task` runs its
// own cross-platform shell whose built-in commands are exactly
// `cp mv rm mkdir pwd sleep echo cat exit head export unset xargs :` — `sh` is
// not one of them, and native Windows has no sh on PATH to fall back to. `deno`
// it always has, since deno_task_shell resolves that to the running executable.
import { dirname, fromFileUrl, join } from "@std/path";

/** The legs live beside this file. Resolved from the module URL, never from the
 * cwd: `deno task` runs from the repo root, but nothing else has to. */
const SCRIPTS = dirname(fromFileUrl(import.meta.url));

export interface Leg {
  /** The program to run. */
  cmd: string;
  /** Its arguments, before the caller's. */
  args: string[];
  /** The leg's script, for the "it is missing" message. */
  script: string;
}

/** The leg for an operating system, or null when there is not one.
 *
 * Exported so the routing can be checked without spawning anything; `os` is a
 * parameter for the same reason. */
export function legFor(
  os: string = Deno.build.os,
  scripts: string = SCRIPTS,
  deno: string = Deno.execPath(),
): Leg | null {
  const at = (name: string) => join(scripts, name);
  switch (os) {
    case "darwin": {
      const script = at("inject-openemu.sh");
      return { cmd: "sh", args: [script], script };
    }
    case "linux": {
      const script = at("inject-mednafen.sh");
      return { cmd: "sh", args: [script], script };
    }
    case "windows": {
      const script = at("inject-mednafen-win.ts");
      // Not "deno": on Windows the whole point is to depend on nothing that has
      // to be found on PATH. Deno.execPath() is the binary already running.
      return { cmd: deno, args: ["run", "-A", script], script };
    }
    default:
      return null;
  }
}

/** What to say on an OS with no leg. Exported so it can be read without one. */
export const unsupportedMessage = (os: string): string =>
  `deno task sav:inject has no leg for ${os}.

  macOS        injects into OpenEmu's cartridge
  Linux / WSL  injects into Mednafen's, under ~/.mednafen/sav
  Windows      injects into Mednafen's, beside "Dezaemon 2.bat"

Nothing about the merge is macOS-only, though. If you use Mednafen, the Linux
leg has no uname check and nothing Linux-specific in it — the ~/.mednafen/sav
glob, the pgrep guard and the launcher search all work on any Unix with sh:

  sh scripts/inject-mednafen.sh foo

Or point the injector at your own .bcr and skip discovery altogether:

  deno task build:sav --out /tmp/level.sav foo
  sh scripts/inject-openemu.sh --sav /tmp/level.sav --cart ~/.mednafen/sav/'Dezaemon 2 (Japan).bcr'

--cart skips every OpenEmu-specific step; only the .bcr is written.`;

if (import.meta.main) {
  const leg = legFor();
  if (!leg) {
    console.error(`error: ${unsupportedMessage(Deno.build.os)}`);
    Deno.exit(2);
  }
  try {
    await Deno.stat(leg.script);
  } catch {
    console.error(
      `error: this is ${Deno.build.os}, so sav:inject runs ${leg.script}, and that file is not there. ` +
        `Is the checkout complete?`,
    );
    Deno.exit(2);
  }

  // Deno.args is already the caller's argv, word for word: `deno task` appends
  // the trailing arguments as parsed words rather than re-lexing a string, so
  // spaces, $, (), quotes, newlines and an empty "" all survive. Hand them on
  // unchanged — the legs, not this file, decide what they mean.
  let child;
  try {
    child = new Deno.Command(leg.cmd, {
      args: [...leg.args, ...Deno.args],
      // Inherited, not piped: the legs stream progress (building an atlas takes
      // a while) and must be able to say "a game is running" as it happens.
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    }).spawn();
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) {
      console.error(
        `error: cannot run ${leg.cmd} — sav:inject needs it to start ${leg.script}.`,
      );
      Deno.exit(2);
    }
    throw e;
  }
  // .code is the child's exit status, or 128 + the signal that killed it.
  const { code } = await child.status;
  Deno.exit(code);
}
