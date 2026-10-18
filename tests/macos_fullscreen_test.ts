// The macOS launcher's window goes fullscreen by itself (lib/macos-fullscreen.ts).
// The FFI half needs a Mac with a window on it; which window gets asked does
// not, and asking the wrong one — one of CEF's own invisible helpers — is the
// failure that would look like "nothing happened".

import { assertEquals } from "@std/assert";
import {
  BEHAVIOR_FULLSCREEN_AUXILIARY,
  BEHAVIOR_FULLSCREEN_NONE,
  canGoFullscreen,
  pickLauncherWindow,
  STYLE_FULLSCREEN,
  STYLE_TITLED,
  type WindowFacts,
} from "../lib/macos-fullscreen.ts";

const launcher: WindowFacts = {
  visible: true,
  styleMask: STYLE_TITLED | 0b1110, // closable, miniaturizable, resizable
  level: 0,
  collectionBehavior: 0,
};

Deno.test("the launcher's window is the titled one at the normal level", () => {
  const cefHelpers: WindowFacts[] = [
    // A borderless panel CEF floats above everything (level 999 on screen).
    { visible: true, styleMask: 0, level: 999, collectionBehavior: 0 },
    // Borderless strips across the top of the screen.
    { visible: true, styleMask: 0, level: 0, collectionBehavior: 0 },
  ];
  assertEquals(pickLauncherWindow([...cefHelpers, launcher]), 2);
  assertEquals(pickLauncherWindow(cefHelpers), -1);
});

Deno.test("a window that is not on screen yet is waited for", () => {
  assertEquals(pickLauncherWindow([{ ...launcher, visible: false }]), -1);
});

Deno.test("a floating titled window is not the launcher", () => {
  assertEquals(pickLauncherWindow([{ ...launcher, level: 3 }]), -1);
});

Deno.test("the first titled window wins over ones the page opened later", () => {
  assertEquals(pickLauncherWindow([launcher, { ...launcher }]), 0);
});

Deno.test("a window that is already fullscreen is still found", () => {
  const full = {
    ...launcher,
    styleMask: launcher.styleMask | STYLE_FULLSCREEN,
  };
  assertEquals(pickLauncherWindow([full]), 0);
});

Deno.test("a window that opted out of fullscreen is left as it is", () => {
  assertEquals(canGoFullscreen(launcher), true);
  assertEquals(
    canGoFullscreen({
      ...launcher,
      collectionBehavior: BEHAVIOR_FULLSCREEN_NONE,
    }),
    false,
  );
  assertEquals(
    canGoFullscreen({
      ...launcher,
      collectionBehavior: BEHAVIOR_FULLSCREEN_AUXILIARY,
    }),
    false,
  );
});
