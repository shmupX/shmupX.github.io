// The PSX library: the PlayStation Dezaemons this machine has on disk, and the
// core that runs them.
//
// Three discs answer to two games — Dezaemon Kids! (SLPS-01503), Dezaemon+
// (SLPS-00335) and Dezaemon Plus Select 100 (SLPS-01504, the 1998 re-release
// whose saves are still SLPS-00335's) — and /api/dezaemon-psx finds whichever
// of them are in dev-fixtures/, plus the memory cards beside them. This module
// is the browser half: it asks that route, makes sure the PlayStation core is
// installed, and hands one disc to the player as the single zip it boots.
//
// Shared on purpose, the way static/ps2-library.js and static/snes-library.js
// are: the dashboard bundles it to render the PLAYSTATION section's local
// rows, and nothing stops `import('/psx-library.js')` at runtime. So every
// network call takes an injectable fetchImpl, and the probe fails soft rather
// than throwing at a caller in the middle of a render.
//
// WHY THERE IS NO CATALOGUE
// Half of static/snes-library.js is a catalogue reader: /dezaemonSfc in the
// Realtime Database, written by `deno task sfc:upload`, normalised row by row,
// installed onto a shelf, with covers and a BroadcastChannel so the editor and
// the dashboard hear each other file a dump. None of that exists for the
// PlayStation. There is no psx:upload task in deno.json, no /dezaemonPsx node,
// and nothing has ever published a PSX Dezaemon anywhere. Roughly half of the
// SNES module therefore has nothing to mirror here and is deliberately absent:
// no PSX_RTDB, no PSX_LIBRARY_ROOT, no PSX_SLUG_RE, no
// normalize/load/install/uninstall/cover functions, and no PSX_LIBRARY_CHANNEL
// with its notify/subscribe pair.
//
// The channel is the omission worth spelling out, because it is the one a
// reader reaches for out of symmetry. A channel earns its keep when two
// surfaces can both WRITE the same store and one has to hear about the other.
// This section has a single source of truth — files on the operator's own disk,
// behind /api/dezaemon-psx — and nothing in any browser can change them. A
// channel nobody posts to is dead code, and dead code in a file like this is
// what the next console's library gets copied from. The refresh idiom that does
// apply is asking the route again.
//
// WHY THE PARSE HAPPENS ON THE SERVER
// The engine can read a PlayStation memory card — packages/shmup-engine/src/
// psx/ has locateSaves, identifyGame, parseSaveHeader and PSX_GAMES — but the
// BROWSER engine cannot. scripts/build-engine.ts bundles exactly one entry
// point, packages/shmup-engine/mod.js (build-engine.ts:10-18), and mod.js
// re-exports no psx names at all; `./psx` is a subpath in that package's
// deno.json (line 35) and nothing more. Grep static/engine/shmup-engine.js for
// parsePsxSav, locateSaves or PSX_GAMES and all three come back empty.
//
// So this module cannot identify a card or a disc, and does not try. The route
// hands down strings that are already decoded: a card's title frame arrives as
// "デザエモンKids!『A 』", narrowed by the parser, and a disc arrives with its
// product code, region and content name settled. Teaching mod.js a `./psx`
// re-export to change that would mean running `deno task engine:bundle` and
// committing a regenerated 8,951-line static/engine/shmup-engine.js, and the
// two flat surfaces already collide: src/psx/index.js exports 234 names, and
// one of them, byteSum, is a name mod.js:33 already re-exports from the Saturn
// side's src/payload-table.js. A large diff and a name fight, for text the
// server has produced already.
//
// WHY THERE IS NO STAGED FALLBACK
// findSnesRom in static/snes-library.js asks /api/dezaemon-sfc first and falls
// back to /snes/Dezaemon.sfc, a copy `deno task sfc:stage` puts under static/
// so a PACKAGED launcher — which embeds _fresh/client, i.e. static/, and no
// dev-fixtures/ — can still boot the cart. That works because an SFC cart is
// half a megabyte. A MODE2/2352 PlayStation rip is 300-700 MB, and staging one
// would put it in every build and every download. There is no findStagedDisc
// here: the route is the only source, and a machine it cannot answer for has no
// local PlayStation rows at all. The mirror shelf (/PlayStation/manifest.json)
// is untouched by that — these rows LEAD the shelf, they never replace it.
//
// WHERE THE PLAYER IS, AND WHOSE BIOS IT LOADS
// Not on this origin. /psx/play.html is cmg's, and static/emu-sw.js mirrors it
// here under the psx core's two prefixes ("/psx/", "/PlayStation/" —
// emu-sw.js:74). That has a consequence the SNES's own player does not: the
// page only resolves while the worker is in front of THIS page, so opening
// PSX_BYOD_PLAYER without a controlling worker loads a 404 into an iframe with
// no error path at all. The caller checks before it opens the frame.
//
// The page hardcodes EJS_biosUrl = '/bios/scph5501.bin' — the US BIOS — and
// both Dezaemons are Japanese SLPS discs. /bios/ is in the catalogue's `shared`
// list and in MIRRORABLE (emu-sw.js:81), so scph5500.bin *is* reachable on this
// origin once the core is installed; the page simply does not ask for it.
// Nothing in this repository can change that — the value lives in a file on
// cmg.easierbycode.deno.net, and the byod handshake carries { file, name } and
// nothing else. PSX_PLAYER_BIOS below is therefore restated, never read, and
// psxBiosCaveat turns the mismatch into one clause of a row's subtitle. Do not
// add &bios=... to PSX_BYOD_PLAYER: the single bios-passing convention in this
// codebase is on the ?rom= manifest path (svelte-src/Dashboard.svelte:3851),
// nothing shows the player reads one under ?byod=1, and a parameter that is
// ignored is worse than no parameter because it looks handled.

import { ensureEmuCore, readInstalledCores } from './ps2-library.js';

export const PSX_CORE_ID = 'psx';
export const PSX_CORE_LABEL = 'PlayStation';
/** Where the launcher asks what this machine has. */
export const PSX_DISC_URL = '/api/dezaemon-psx';
/** Bring-your-own-disc: the player is posted ONE file, a zip holding the cue
 * and its track files. Shaped like the Saturn's hand-off, not the SNES's — a
 * save is not a game over there, so two files go over. */
export const PSX_BYOD_PLAYER = '/psx/play.html?byod=1';
export const PSX_BYOD_READY = 'psx-byod-ready';
export const PSX_BYOD_FILE = 'psx-byod-file';
/** What the launcher calls the pair. Mirrors DEZAEMON_PSX_TITLE in
 * lib/dezaemon-psx.ts, which static/ cannot import (plain browser ESM). */
export const PSX_TITLE = 'Dezaemon (PlayStation)';
/** The display titles. Mirrors PSX_GAMES in
 * packages/shmup-engine/src/psx/index.js:30-33, which is not in the browser
 * engine bundle either (see WHY THE PARSE HAPPENS ON THE SERVER above). */
export const PSX_GAME_TITLES = Object.freeze({
  kids: 'Dezaemon Kids!', plus: 'Dezaemon+',
});
/** The cue's base name per game: the content name EmulatorJS hands the core,
 * and therefore what will name the core's memory-card file the day something
 * can write one. The display titles' "!" and "+" are dropped on purpose — a
 * "+" decodes as a space under form decoding and this name reaches a
 * content-disposition header and, sooner or later, a URL. Mirrors
 * PSX_CONTENT_NAMES in lib/dezaemon-psx.ts; tests/dezaemon_psx_test.ts holds
 * the two equal. */
export const PSX_CONTENT_NAMES = Object.freeze({
  kids: 'Dezaemon Kids', plus: 'Dezaemon Plus',
});
/** What the mirrored player hardcodes as EJS_biosUrl. Restated, never read:
 * the page is cmg's and this origin only mirrors it. */
export const PSX_PLAYER_BIOS = '/bios/scph5501.bin';

const noop = () => {};
const defaultFetch = (url, init) => fetch(url, init);
const msg = (e) => (e && e.message) || String(e || 'unknown error');

// ── The discs ────────────────────────────────────────────────────────────────

/**
 * What /api/dezaemon-psx says about this machine, or why it said nothing.
 *
 * Fail-soft, exactly as askRomRoute is in static/snes-library.js: a route that
 * is not there — a Deploy build, a launcher served off static files, a checkout
 * from before this route existed — is a machine with no discs, not an exception
 * the launcher has to catch on every render. `discs` and `cards` are arrays in
 * every answer this returns, including the three failure ones, so the caller's
 * `.map` and `.filter` never guard; the route promises the same shape on
 * Deploy, where it answers { available: false, reason: "local only" }.
 *
 * There is no second source to try. See WHY THERE IS NO STAGED FALLBACK above.
 */
export async function findPsxDiscs({ fetchImpl = defaultFetch } = {}) {
  try {
    const res = await fetchImpl(PSX_DISC_URL, { cache: 'no-store' });
    if (!res.ok) {
      return {
        available: false,
        reason: PSX_DISC_URL + ' answered HTTP ' + res.status,
        discs: [],
        cards: [],
      };
    }
    const body = await res.json();
    return body && typeof body === 'object'
      ? body
      : { available: false, reason: 'unreadable answer', discs: [], cards: [] };
  } catch (e) {
    return { available: false, reason: msg(e), discs: [], cards: [] };
  }
}

/**
 * The zip as a File in THIS realm, for posting into the player frame.
 *
 * `.blob()` on a body that can run to 700 MB looks like the mistake this
 * project already carries a scar from: Chrome fails Response.blob() on a ~40 MB
 * WORKER-MEDIATED body with a bare TypeError (measured 2026-08-31 against the
 * 41,146,368-byte PS2 disc — .arrayBuffer() and a body reader returned every
 * byte in the same tab in the same second, so it is the hand-off to blob
 * storage, not the transfer, and not quota). It is the right call here anyway,
 * twice over. /api/ is outside emu-sw.js's MIRRORABLE set and the fetch handler
 * returns before respondWith for anything outside it (emu-sw.js:302), so this
 * response never passes through the worker and is not the shape that fails; and
 * a Blob is what has to come out the far end regardless, because the player
 * wants a File, and Chrome's blob storage spills a large one to disk instead of
 * pinning it in the tab. The side that must not hold a disc in memory is the
 * SERVER, and psxDiscZipStream in lib/dezaemon-psx.ts is why it does not.
 */
export async function fetchPsxDiscFile(disc, { fetchImpl = defaultFetch } = {}) {
  // A sentence rather than a code: this is what a toast shows the player.
  if (!disc || !disc.zip) throw new Error('that disc record carries no zip url');
  const res = await fetchImpl(disc.zip, { cache: 'no-store' });
  if (!res.ok) throw new Error(disc.zip + ' answered HTTP ' + res.status);
  const name = disc.zipName || (disc.content || 'Dezaemon') + '.zip';
  return new File([await res.blob()], name, { type: 'application/zip' });
}

/**
 * What the player needs: { file, name }.
 *
 * `name` is the content name, which is what EmulatorJS turns into the core's
 * content name and therefore what names its save in /data/saves. The route has
 * already settled it — it is the base name of the cue inside the zip — so the
 * two fallbacks behind it only exist so a record typed by hand in a test or a
 * console still boots something rather than a file called "undefined".
 */
export async function psxBootFile(disc, { fetchImpl = defaultFetch } = {}) {
  const file = await fetchPsxDiscFile(disc, { fetchImpl });
  return {
    file,
    name: disc.content || PSX_CONTENT_NAMES[disc.game] || 'Dezaemon',
  };
}

// ── The core ─────────────────────────────────────────────────────────────────

/**
 * Install the PlayStation core.
 *
 * Unlike ensureSnesCore next door, this takes the FULL path through
 * ensureEmuCore (static/ps2-library.js): the psx entry in static/emulators.json
 * carries no `local` flag, so the service worker is registered, emu-state is
 * pushed, control of the page is waited for, and ~12 MB of core is warmed. That
 * is the standing price of this section — a service-worker registration in
 * front of every same-origin request for the life of this browser — which is
 * why the caller only pays it when the machine turns out to have a disc, and
 * why a user who uninstalls the core has to be able to keep it uninstalled.
 *
 * It can still throw, and the caller should treat that as a note on the rows
 * rather than a failure of them: a page that is not a secure context, or a
 * browser that will not register a worker, cannot mirror anything, and
 * ensureEmuCore says which of those it was.
 */
export function ensurePsxCore(onStep = noop) {
  return ensureEmuCore(PSX_CORE_ID, PSX_CORE_LABEL, onStep);
}

export function isPsxCoreInstalled() {
  try { return readInstalledCores().includes(PSX_CORE_ID); } catch (_) { return false; }
}

// ── What a row says ──────────────────────────────────────────────────────────

/**
 * The one-line BIOS caveat for a disc, or null when there is none.
 *
 * Both Dezaemons are SLPS discs and want /bios/scph5500.bin; the mirrored
 * player loads /bios/scph5501.bin whatever is in the drive. mednafen_psx does
 * run the BIOS's region and licence check, so a Japanese disc booted on the US
 * BIOS can land on a region screen instead of a title screen — a boot outcome,
 * not a wiring failure, and one a row that said nothing would leave looking
 * like a bad rip. This states the mismatch and stops: it builds no URL and
 * passes nothing, because there is nothing here to pass it to.
 */
export function psxBiosCaveat(disc) {
  if (!disc || !disc.bios || disc.bios === PSX_PLAYER_BIOS) return null;
  return (disc.region || 'JP') + ' disc, US BIOS';
}

/**
 * The memory cards grouped for the shelf: [{ game, title, count }].
 *
 * One row per game, never one per card. The community collection this was
 * traced against is 165 saves, and 165 rows nothing can boot would bury the two
 * disc rows above them; they become worth listing individually the day
 * something can write one into the emulator's memory card, which nothing in
 * this launcher does. A fixed kids-then-plus order rather than the route's, so
 * two renders of one answer produce the same rows, and a game with no cards
 * gets no row at all rather than an empty one.
 */
export function psxCardsByGame(answer) {
  const cards = (answer && answer.cards) || [];
  return ['kids', 'plus']
    .map((game) => ({
      game,
      title: PSX_GAME_TITLES[game],
      count: cards.filter((c) => c && c.game === game).length,
    }))
    .filter((g) => g.count > 0);
}
