// static/steam-nudge.js — the first-run offer to install the Linux AppImage.
// Pure: a /api/steam body in, a verdict out.
//
// The live path cannot be reached on a developer's machine — install.can needs
// $APPDIR, which only a running AppImage runtime sets — so this truth table is
// the regression net for the whole feature. Every `why` the reducer can answer
// has a case here, because a silent nudge and a broken nudge look identical
// from the outside.

import { assert, assertEquals } from "@std/assert";
import { NUDGE_HEADLINE, steamNudge } from "../static/steam-nudge.js";

/** A GET body for the case the nudge exists for: a raw, uninstalled AppImage. */
function body(over: Record<string, unknown> = {}) {
  return {
    ok: true,
    os: "linux",
    binary: { path: "/home/p/Downloads/shmupX.AppImage", kind: "appimage" },
    install: {
      can: true,
      dir: "/home/p/.local/share/shmupX/app",
      exe: "/home/p/.local/share/shmupX/app/AppRun",
      source: "/tmp/.mount_shmupXAbc123",
      reason: null,
    },
    steamFound: true,
    steamRunning: false,
    reason: null,
    ...over,
  };
}

Deno.test("a raw AppImage with Steam present is the one case that offers", () => {
  const v = steamNudge(body());
  assert(v.show);
  assertEquals(v.why, "install");
  assertEquals(v.headline, NUDGE_HEADLINE);
  assertEquals(v.restart, false);
  assert(v.detail.length > 0, "an offer with no explanation is a bare button");
});

Deno.test("Steam running still offers, and asks for the restart", () => {
  // The install happens and the updater arms either way; only the library
  // entry is at risk, so this is a line of copy and never a gate.
  const v = steamNudge(body({ steamRunning: true }));
  assert(v.show);
  assertEquals(v.restart, true);
});

Deno.test("no route, no offer", () => {
  assertEquals(steamNudge(null).why, "no-route");
  assertEquals(steamNudge(undefined).why, "no-route");
  // The hosted origin answers 403 with ok:false rather than nothing at all.
  assertEquals(steamNudge({ ok: false, error: "…" }).why, "no-route");
  assertEquals(steamNudge(null).show, false);
});

Deno.test("a decision already taken keeps it quiet", () => {
  // done outranks everything: it is the ONLY thing that can suppress the offer
  // after a successful add, because the route's own install.can is surveyed
  // before the copy and this process stays an AppImage until it is relaunched.
  assertEquals(steamNudge(body(), { done: true }).why, "done");
  assertEquals(steamNudge(body(), { dismissed: true }).why, "dismissed");
  assertEquals(steamNudge(body(), { seen: true }).why, "seen");
  for (const opts of [{ done: true }, { dismissed: true }, { seen: true }]) {
    assertEquals(steamNudge(body(), opts).show, false);
  }
});

Deno.test("the installed copy never offers — it is what the offer produces", () => {
  const v = steamNudge(body({
    binary: {
      path: "/home/p/.local/share/shmupX/app/AppRun",
      kind: "installed",
    },
    install: {
      can: false,
      reason: "this launcher is already installed, and updates itself",
    },
  }));
  assertEquals(v.why, "installed");
  assertEquals(v.show, false);
});

Deno.test("a source checkout has no launcher to install", () => {
  const v = steamNudge(
    body({ binary: null, install: { can: false, reason: "…" } }),
  );
  assertEquals(v.why, "no-binary");
  assertEquals(v.show, false);
});

Deno.test("builds that run in place stay silent", () => {
  // macOS .app and Windows .exe are added where they sit, and a missing
  // $APPDIR/$HOME means there is nothing to copy or nowhere to put it. All of
  // them arrive here as the same thing: install.can false.
  const cases = [
    body({
      os: "darwin",
      binary: { path: "/Applications/shmupX.app", kind: "macos-app" },
      install: { can: false, reason: "runs in place" },
    }),
    body({
      os: "windows",
      binary: { path: "C:\\shmupX.exe", kind: "executable" },
      install: { can: false, reason: "runs in place" },
    }),
    body({ install: { can: false, reason: "no $APPDIR" } }),
    body({ install: undefined }),
  ];
  for (const c of cases) assertEquals(steamNudge(c).why, "runs-in-place");
});

Deno.test("no Steam, no offer — the button would answer 409", () => {
  const v = steamNudge(body({ steamFound: false }));
  assertEquals(v.why, "no-steam");
  assertEquals(v.show, false);
});

Deno.test("the order of the gates is the order of the reasons", () => {
  // An installed copy on a machine with no Steam reports `installed`, not
  // `no-steam`: the fact that ends the matter wins, so the reason a player is
  // told is the one that is actually true of them.
  assertEquals(
    steamNudge(body({
      steamFound: false,
      binary: { path: "/x/AppRun", kind: "installed" },
      install: { can: false, reason: "…" },
    })).why,
    "installed",
  );
  // ...and a decision already taken outranks every fact about the machine.
  assertEquals(steamNudge(body({ binary: null }), { seen: true }).why, "seen");
});

Deno.test("a silent verdict carries no copy to render", () => {
  for (const v of [steamNudge(null), steamNudge(body(), { seen: true })]) {
    assertEquals(v.headline, "");
    assertEquals(v.detail, "");
    assertEquals(v.restart, false);
  }
});

Deno.test("the committed dashboard bundle carries the nudge", async () => {
  // svelte-src/Dashboard.svelte is only ever served through
  // static/dashboard.bundle.js, so an unbuilt edit ships nothing — the same
  // trap tests/version_row_test.ts exists to catch.
  const bundle = await Deno.readTextFile(
    new URL("../static/dashboard.bundle.js", import.meta.url),
  );
  assert(
    bundle.includes(NUDGE_HEADLINE),
    "stale bundle: run `deno task dashboard:build`",
  );
  assert(
    bundle.includes("cmg-steam-nudge-seen"),
    "stale bundle: the nudge's seen-flag is missing — run `deno task dashboard:build`",
  );
});
