// static/steam-nudge.js — should the launcher offer to install itself?
//
// A player who double-clicks the Linux AppImage gets a launcher that can never
// update itself: the mount is read-only, so lib/self-update.ts refuses to arm
// the updater and tells nobody. The repair is one press of ADD TO STEAM, which
// copies the mounted tree somewhere writable (lib/launcher-install.ts) and
// points Steam at the copy — but that press lives six rows down the Settings
// screen, two screens from the first thing the player sees. A launcher that
// will never update again looks exactly like one that is current.
//
// This module decides whether to put that press in front of them, out of the
// /api/steam GET body the dashboard already fetches at mount. It is pure, and
// it lives here rather than inline in Dashboard.svelte for the same reason
// two-player-presence.js does: the launcher has no DOM test harness, so the
// only shape that can be tested is a function that takes a body and answers.
//
// `why` is set on every outcome, including the silent ones — the same
// discipline as InstallPlan.reason. A nudge that does not appear is otherwise
// indistinguishable from one that was never wired up, which is the failure
// this whole surface exists to stop.

/** The offer, and the reason for it — `headline`/`detail` only when shown. */
export const NUDGE_HEADLINE = "TURN ON UPDATES?";

/**
 * @param {object|null|undefined} steam the /api/steam GET body, or nothing
 * @param {{seen?: boolean, dismissed?: boolean, done?: boolean}} opts
 *   `seen` is the remembered decision from an earlier run; `dismissed` and
 *   `done` are this session's. All three are inputs rather than things read
 *   in here, so this stays pure and the caller owns the store.
 * @returns {{show: boolean, why: string, restart: boolean,
 *            headline: string, detail: string}}
 */
export function steamNudge(steam, opts = {}) {
  const no = (why) => ({ show: false, why, restart: false, headline: "", detail: "" });

  // No route, no answer: the hosted origin refuses this endpoint outright
  // (403), and a failed fetch leaves the dashboard's `steam` null.
  if (!steam || steam.ok === false) return no("no-route");

  // This session already decided. `done` in particular must be checked here
  // rather than re-derived from the body: routes/api/steam.ts surveys BEFORE
  // it installs and then spreads that survey into the response, so install.can
  // is still true after a successful add — and re-fetching says the same
  // thing, because this process goes on being the AppImage until the player
  // launches the copy.
  if (opts.done) return no("done");
  if (opts.dismissed) return no("dismissed");
  if (opts.seen) return no("seen");

  // A source checkout has no launcher to install.
  if (!steam.binary) return no("no-binary");
  // Already installed: this IS the writable copy, and it updates itself.
  if (steam.binary.kind === "installed") return no("installed");

  // Everything else install.can refuses: a macOS .app and a Windows .exe are
  // added where they sit and are no more updatable from a copy, and a missing
  // $APPDIR/$HOME means there is nothing to copy or nowhere to put it.
  if (!steam.install || !steam.install.can) return no("runs-in-place");

  // No Steam, no offer. Not a style choice: routes/api/steam.ts answers 409
  // before installing anything when steamFound is false, so the button would
  // be a dead end. The launcher still says why in Settings.
  if (!steam.steamFound) return no("no-steam");

  return {
    show: true,
    why: "install",
    // Steam reads shortcuts.vdf at startup and writes its own copy back when
    // it quits, so an entry added under a running client is discarded on exit.
    // A display flag, never a gate: the install still happens and the updater
    // still arms — only the library entry is at risk.
    restart: !!steam.steamRunning,
    headline: NUDGE_HEADLINE,
    detail:
      "You are running shmupX straight from the AppImage, and it cannot " +
      "update itself there. Installing it copies it somewhere writable, adds " +
      "it to your Steam library, and turns updates on from then on.",
  };
}
