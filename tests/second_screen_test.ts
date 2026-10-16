// lib/second-screen.ts — the whole open/close round trip, against a stand-in
// `kscreen-doctor` on PATH and a stand-in Deno.BrowserWindow: the panel comes
// on, the controller window lands on it, and both go away again.

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";

const KSCREEN = (panelOn: boolean) =>
  JSON.stringify({
    outputs: [
      {
        name: "eDP-1",
        type: 7,
        connected: true,
        enabled: panelOn,
        pos: { x: 2560, y: 0 },
        rotation: 8,
        scale: 1.5,
        currentModeId: panelOn ? "1" : "",
        preferredModes: ["1"],
        modes: [{ id: "1", size: { width: 1600, height: 2560 } }],
      },
      {
        name: "DP-1",
        connected: true,
        enabled: true,
        priority: 1,
        pos: { x: 0, y: 0 },
        rotation: 1,
        scale: 1,
        currentModeId: "7",
        modes: [{ id: "7", size: { width: 2560, height: 1440 } }],
      },
    ],
  });

Deno.test({
  name:
    "open turns the panel on and puts the controller there; close undoes both",
  ignore: Deno.build.os !== "linux",
  async fn() {
    const dir = await Deno.makeTempDir();
    const state = join(dir, "panel-on");
    const calls = join(dir, "calls");
    await Deno.writeTextFile(join(dir, "off.json"), KSCREEN(false));
    await Deno.writeTextFile(join(dir, "on.json"), KSCREEN(true));
    // `-j` answers from the state file; anything else is a change, recorded,
    // and enable/disable flip the state the next `-j` reports.
    await Deno.writeTextFile(
      join(dir, "kscreen-doctor"),
      `#!/bin/sh
if [ "$1" = "-j" ]; then
  if [ -f "${state}" ]; then cat "${dir}/on.json"; else cat "${dir}/off.json"; fi
  exit 0
fi
echo "$*" >> "${calls}"
case "$*" in
  *eDP-1.enable*) touch "${state}" ;;
  *eDP-1.disable*) rm -f "${state}" ;;
esac
`,
    );
    await Deno.chmod(join(dir, "kscreen-doctor"), 0o755);

    const opened: Array<Record<string, unknown>> = [];
    class FakeWindow extends EventTarget {
      closed = false;
      pos: number[] = [];
      size: number[] = [];
      url = "";
      constructor(opts: Record<string, unknown>) {
        super();
        opened.push(opts);
      }
      navigate(url: string) {
        this.url = url;
      }
      show() {}
      close() {
        this.closed = true;
        this.dispatchEvent(new Event("close"));
      }
      isClosed() {
        return this.closed;
      }
      setPosition(x: number, y: number) {
        this.pos = [x, y];
      }
      setSize(w: number, h: number) {
        this.size = [w, h];
      }
    }

    const env = Deno.env.toObject();
    const denoAny = Deno as unknown as Record<string, unknown>;
    Deno.env.set("PATH", `${dir}:${env.PATH ?? ""}`);
    Deno.env.set("XDG_CURRENT_DESKTOP", "KDE");
    Deno.env.delete("GAMESCOPE_WAYLAND_DISPLAY");
    denoAny.BrowserWindow = FakeWindow;
    try {
      const mod = await import("../lib/second-screen.ts");
      const status = await mod.secondScreenStatus();
      assertEquals(status.available, true);
      assertEquals(status.external, true);
      assertEquals(status.internalEnabled, false);

      const r = await mod.openSecondScreen({
        origin: "http://127.0.0.1:8787",
        layout: "twin",
        title: "Sh'M↑ Party",
      });
      assertEquals(r, { ok: true });
      assertEquals(opened.length, 1);
      // On the panel, right of the 2560-wide monitor: 2560×1600 turned and
      // at 150% is 1707×1067.
      assertEquals(
        [opened[0].x, opened[0].y, opened[0].width, opened[0].height],
        [2560, 0, 1707, 1067],
      );
      assertEquals(opened[0].frameless, true);
      const log1 = await Deno.readTextFile(calls);
      assert(
        log1.includes(
          "output.eDP-1.enable output.eDP-1.position.2560,0 output.DP-1.primary",
        ),
      );
      assertEquals((await mod.secondScreenStatus()).open, true);

      assertEquals(await mod.closeSecondScreen(), { ok: true });
      const log2 = await Deno.readTextFile(calls);
      assert(log2.trim().endsWith("output.eDP-1.disable"));
      const after = await mod.secondScreenStatus();
      assertEquals([after.open, after.internalEnabled], [false, false]);
      // Nothing left to undo.
      assertEquals(await mod.restoreDisplays(), null);
    } finally {
      delete denoAny.BrowserWindow;
      Deno.env.set("PATH", env.PATH ?? "");
      if (env.XDG_CURRENT_DESKTOP === undefined) {
        Deno.env.delete("XDG_CURRENT_DESKTOP");
      } else Deno.env.set("XDG_CURRENT_DESKTOP", env.XDG_CURRENT_DESKTOP);
      await Deno.remove(dir, { recursive: true });
    }
  },
});
