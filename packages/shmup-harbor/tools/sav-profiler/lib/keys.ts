// Keys into Mednafen — the Saturn pad and the emulator hotkeys, as macOS
// virtual keycodes for the CGEvent helper below, and as the SDL scancodes
// Mednafen's settings want so the two tables cannot drift apart.
//
// Mednafen only sees keyboard events through SDL, and SDL only takes them
// while its window has keyboard focus, so the helper first brings Mednafen to
// the front (System Events, which is why this needs the Accessibility grant)
// and then posts the key with CGEventPostToPid. Posting to the pid rather than
// to the HID tap keeps a stray keystroke from landing in whatever the user is
// typing into when the window loses focus between steps.

import { join } from "@std/path";
import { ensureDir } from "@std/fs";

/** macOS virtual keycodes (Carbon kVK_*). */
export const VK = {
  Return: 36,
  Escape: 53,
  A: 0,
  S: 1,
  D: 2,
  W: 13,
  K: 40,
  L: 37,
  P: 35,
  KP1: 83,
  KP2: 84,
  KP3: 85,
  KP4: 86,
  KP5: 87,
  KP6: 88,
} as const;

/** The same keys as SDL scancodes, for the override config. */
export const SDL = {
  Return: 40,
  Escape: 41,
  A: 4,
  S: 22,
  D: 7,
  W: 26,
  K: 14,
  L: 15,
  P: 19,
  KP1: 89,
  KP2: 90,
  KP3: 91,
  KP4: 92,
  KP5: 93,
  KP6: 94,
} as const;

/** Saturn pad → key, the layout Mednafen ships with (WASD + keypad). */
export const PAD = {
  up: "W",
  down: "S",
  left: "A",
  right: "D",
  start: "Return",
  a: "KP1",
  b: "KP2",
  c: "KP3",
  x: "KP4",
  y: "KP5",
  z: "KP6",
} as const;

/** Emulator commands remapped off the F-keys: macOS turns F7/F12 into media
 * keys at the HID layer, so the stock bindings never reach Mednafen. */
export const HOTKEY = {
  exit: "Escape",
  save_state: "K",
  load_state: "L",
  take_snapshot: "P",
} as const;

export type KeyName = keyof typeof VK;

/** The `ss.input.port1.*` and `command.*` lines that pin every key this tool
 * presses, whatever the user's own mednafen.cfg says. */
export function keyConfigLines(): string[] {
  const lines = ["ss.input.port1 gamepad"];
  for (const [button, key] of Object.entries(PAD)) {
    lines.push(`ss.input.port1.gamepad.${button} keyboard 0x0 ${SDL[key]}`);
  }
  for (const [command, key] of Object.entries(HOTKEY)) {
    lines.push(`command.${command} keyboard 0x0 ${SDL[key]}`);
  }
  return lines;
}

// The CGEvent helper. Swift because the sandboxed shell has no other way to
// synthesise a keystroke: osascript's `key code` needs the same Accessibility
// grant and is slower per press, which matters when a hold has to last an
// exact number of frames.
const POSTKEY_SWIFT = `
import Foundation
import CoreGraphics
// usage: postkey <pid> <vk[,vk...]> [holdMs]
let a = CommandLine.arguments
guard a.count >= 3, let pid = pid_t(a[1]) else { exit(2) }
let keys = a[2].split(separator: ",").compactMap { UInt16($0) }.map { CGKeyCode($0) }
let hold = a.count > 3 ? (UInt32(a[3]) ?? 80) : 80
let src = CGEventSource(stateID: .hidSystemState)
for k in keys {
  guard let d = CGEvent(keyboardEventSource: src, virtualKey: k, keyDown: true) else { exit(3) }
  d.postToPid(pid)
}
usleep(hold * 1000)
// One release only. A second one a few frames later looked like cheap
// insurance against a key-up lost in a focus change, but Dezaemon 2's
// value widgets stop toggling when a stray release follows the press.
for k in keys {
  guard let u = CGEvent(keyboardEventSource: src, virtualKey: k, keyDown: false) else { exit(3) }
  u.postToPid(pid)
}
`;

export class KeyError extends Error {
  override name = "KeyError";
}

/** Build the helper once into `binDir`, returning its path. */
export async function ensurePostKey(binDir: string): Promise<string> {
  await ensureDir(binDir);
  const src = join(binDir, "postkey.swift");
  const bin = join(binDir, "postkey");
  let fresh = false;
  try {
    const have = await Deno.readTextFile(src);
    fresh = have === POSTKEY_SWIFT && (await Deno.stat(bin)).isFile;
  } catch { /* build it */ }
  if (fresh) return bin;
  await Deno.writeTextFile(src, POSTKEY_SWIFT);
  const out = await new Deno.Command("swiftc", {
    args: ["-O", "-o", bin, src],
    stdout: "piped",
    stderr: "piped",
  }).output().catch((e) => {
    throw new KeyError(
      `swiftc is needed to build the key helper (Xcode command line tools): ${
        (e as Error).message
      }`,
    );
  });
  if (!out.success) {
    throw new KeyError(
      `building the key helper failed:\n${
        new TextDecoder().decode(out.stderr)
      }`,
    );
  }
  return bin;
}

/** The pid of the frontmost application, or null when it cannot be read. */
export async function frontmostPid(): Promise<number | null> {
  const out = await new Deno.Command("osascript", {
    args: [
      "-e",
      'tell application "System Events" to unix id of first application process whose frontmost is true',
    ],
    stdout: "piped",
    stderr: "null",
  }).output();
  const n = Number(new TextDecoder().decode(out.stdout).trim());
  return out.success && Number.isFinite(n) ? n : null;
}

/** Bring a process's window to the front so SDL takes keyboard input —
 * only when it is not there already: re-fronting an app that is frontmost
 * still sends it a focus flip, and Dezaemon 2's value widgets ignore a
 * button pressed within a few frames of one. */
export async function activate(pid: number): Promise<void> {
  if ((await frontmostPid()) === pid) return;
  const out = await new Deno.Command("osascript", {
    args: [
      "-e",
      `tell application "System Events" to set frontmost of (first process whose unix id is ${pid}) to true`,
    ],
    stdout: "null",
    stderr: "piped",
  }).output();
  if (!out.success) {
    throw new KeyError(
      "could not bring Mednafen to the front. Grant Accessibility access to " +
        "the terminal (System Settings → Privacy & Security → Accessibility): " +
        new TextDecoder().decode(out.stderr).trim(),
    );
  }
}

/** Move a process's first window (top-left corner, screen points). */
export async function placeWindow(
  pid: number,
  x: number,
  y: number,
): Promise<void> {
  await new Deno.Command("osascript", {
    args: [
      "-e",
      `tell application "System Events" to set position of window 1 of (first process whose unix id is ${pid}) to {${x}, ${y}}`,
    ],
    stdout: "null",
    stderr: "null",
  }).output();
}

export class Keyboard {
  constructor(readonly bin: string, readonly pid: number) {}

  /** Press (and release after `holdMs`) one or more keys together. */
  async press(keys: KeyName | KeyName[], holdMs = 80): Promise<void> {
    const list = Array.isArray(keys) ? keys : [keys];
    const out = await new Deno.Command(this.bin, {
      args: [
        String(this.pid),
        list.map((k) => VK[k]).join(","),
        String(holdMs),
      ],
      stdout: "null",
      stderr: "piped",
    }).output();
    if (!out.success) {
      throw new KeyError(
        `posting ${list.join("+")} to pid ${this.pid} failed: ${
          new TextDecoder().decode(out.stderr)
        }`,
      );
    }
  }

  pad(button: keyof typeof PAD, holdMs = 80): Promise<void> {
    return this.press(PAD[button], holdMs);
  }

  hotkey(command: keyof typeof HOTKEY): Promise<void> {
    return this.press(HOTKEY[command], 80);
  }
}
