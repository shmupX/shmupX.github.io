// Two players at the launcher — the rule the eShop's 2P filter and 2028.Ai's
// two-player gate both read. Pure: pad snapshots and clocks in, a verdict out,
// so it runs under Deno exactly as it does in the dashboard.
//
// Two ways to be two:
//
//   - TWO PADS. Two connected controllers that have each been USED — Chrome
//     lists a pad only once a button has been pressed on it, Firefox the
//     moment it is plugged in, so "connected" alone would count a dormant
//     second pad on Firefox. A pad counts from its first press or stick move
//     and keeps counting while it stays connected.
//
//   - A LEGION GO IN HALVES, while Split Controller mode is live. Its detached
//     controller is still ONE pad, so two players holding a half each look
//     like one. What says there are two is a gesture ONE PLAYER CANNOT MAKE
//     while working a menu:
//       · the split view's right half has been CLAIMED (the View tap — a
//         deliberate "we are two", see gamepad-compatibility-plugin.js), or
//       · both sticks are deflected in the SAME poll, which is a hand on each
//         half.
//     Buttons never say it. The launcher's own navigation is a left-half press
//     (D-pad) and then a right-half press (A to confirm), so counting each
//     half's last press would make every solo player a pair.
//     Once said, it stays said — a pair reading a list holds nothing — until
//     the pad goes away, split mode ends, the right half goes to FPS mode, or
//     the halves have been quiet for PAIR_QUIET_MS.
//
// The dashboard feeds `notePad` every poll with the raw controllers it sees
// (never the split halves — those exist only inside the game frame), and asks
// `verdict` for the answer.

export const PAIR_QUIET_MS = 10 * 60_000;
export const STICK_LIVE = 0.55;

// Which physical half a standard-mapping slot lives on, on the Legion Go:
// the left grip has LB/LT/View/L3, the D-pad and the left stick; the right
// grip ABXY/RB/RT/Menu/R3 and the right stick.
export const LEFT_HALF_BUTTONS = [4, 6, 8, 10, 12, 13, 14, 15];
export const RIGHT_HALF_BUTTONS = [0, 1, 2, 3, 5, 7, 9, 11];

function pressed(pad, i) {
  const b = pad && pad.buttons && pad.buttons[i];
  return !!(b && b.pressed);
}
function axisLive(pad, i) {
  const v = pad && pad.axes && pad.axes[i];
  return typeof v === 'number' && Math.abs(v) > STICK_LIVE && Math.abs(v) <= 1.05;
}

/** Which halves of one pad are being worked right now. */
export function halvesActive(pad) {
  return {
    left: LEFT_HALF_BUTTONS.some((i) => pressed(pad, i)) || axisLive(pad, 0) || axisLive(pad, 1),
    right: RIGHT_HALF_BUTTONS.some((i) => pressed(pad, i)) || axisLive(pad, 2) || axisLive(pad, 3),
  };
}

/**
 * A hand on each half, right now: both sticks deflected in the same poll.
 * One player at a menu moves one stick at a time; two players each have one.
 */
export function bothSticksLive(pad) {
  return (axisLive(pad, 0) || axisLive(pad, 1)) && (axisLive(pad, 2) || axisLive(pad, 3));
}

/** Any button or stick (axes 0-3) live on this pad. */
export function padActive(pad) {
  const h = halvesActive(pad);
  return h.left || h.right;
}

export function padKey(pad) {
  return String(pad && pad.index) + ':' + ((pad && pad.id) || '');
}

/** A fresh tracker. */
export function createPresence() {
  return {
    // "index:id" -> last time that pad was used, for the pads seen used.
    used: new Map(),
    // The Legion pad: when its two halves were last both in hand.
    pairAt: -Infinity,
    legionKey: null,
  };
}

/**
 * One poll's worth of pads. `pads` is navigator.getGamepads() as the launcher
 * sees it; `opts.split` says Split Controller mode is live right now (without
 * it the halves are one player's two hands and are never read), `opts.legion`
 * that the machine is a Legion Go with a detachable controller,
 * `opts.isLegionPad(pad)` names the pad that is its controller (any standard
 * pad when nothing says — the same rule the split view uses), `opts.claimed`
 * that the split view's right half has been claimed for player 2, and
 * `opts.fps` that the right half is a mouse right now.
 */
export function notePad(state, pads, now, opts = {}) {
  const list = pads ? Array.prototype.filter.call(pads, (p) => p && p.connected) : [];
  const live = new Set();
  let legion = null;
  for (const p of list) {
    const key = padKey(p);
    live.add(key);
    if (padActive(p)) state.used.set(key, now);
    if (opts.legion && !legion && (typeof opts.isLegionPad !== 'function' || opts.isLegionPad(p))) legion = p;
  }
  // A pad gone from the list is forgotten: a reconnect starts over.
  for (const key of [...state.used.keys()]) if (!live.has(key)) state.used.delete(key);

  const legionKey = legion ? padKey(legion) : null;
  if (legionKey !== state.legionKey) {
    state.legionKey = legionKey;
    state.pairAt = -Infinity;
  }
  // Only while the halves ARE two pads, and only on a gesture one player
  // cannot make (see the header).
  if (legion && opts.split && !opts.fps && (opts.claimed || bothSticksLive(legion))) {
    state.pairAt = now;
  }
  return state;
}

/**
 * The verdict: { two, pads, halves } — `two` when two players are at the
 * launcher, `pads` how many used controllers are connected, `halves` whether
 * a Legion's two halves are the reason.
 */
export function verdict(state, now, opts = {}) {
  const pads = state.used.size;
  const halves = !!state.legionKey && !!opts.split && !opts.fps &&
    now - state.pairAt <= PAIR_QUIET_MS;
  return { two: pads >= 2 || halves, pads, halves };
}

// ── The eShop's 2P filter, as a state machine ────────────────────────────────
// The list trims itself to two-player games when two players are at the
// launcher. The first time that ever happens the chips do it in front of the
// player — ALL lit, a beat, then 2P lit and the list shorter — and then tuck
// themselves away so the picking can go on; every later time the trim is
// silent and the chips stay tucked. A filter the player picks by hand wins,
// and brings the chips back so the choice can be seen; when the second
// player goes away an automatic 2P goes back to ALL.
//
// `step(state, input)` returns the next state plus the actions to take:
//   input: { two, has2P, onScreen, filter, seen, now }
//   actions: { setFilter?, hideChips?, showChips?, markSeen? }

export const REVEAL_FLIP_MS = 700;
export const REVEAL_HOLD_MS = 1800;

export function createFilterAuto() {
  return {
    // The 2P filter was applied by this machine (so it may be undone by it).
    auto: false,
    // A reveal is running: when it flips, when it tucks.
    flipAt: 0,
    tuckAt: 0,
    // The player picked a filter by hand this visit: hands off until the
    // second player leaves and comes back.
    manual: false,
  };
}

export function stepFilterAuto(state, input) {
  const s = { ...state };
  const out = {};
  const { two, has2P, onScreen, filter, seen, now } = input;
  if (!onScreen) {
    // Off the shop screen a running reveal is abandoned. One that had not
    // flipped yet applied NOTHING, so the trim is not owed to it either:
    // clear the latch, and the next visit starts the reveal over.
    if (s.flipAt) s.auto = false;
    s.flipAt = 0;
    s.tuckAt = 0;
    return { state: s, actions: out };
  }
  if (s.flipAt) {
    // The reason for the trim can go while the beat runs — the second player
    // puts their pad down, the player picks a filter. Never flip into a
    // trim nobody asked for, and never spend the one-time reveal on it.
    if (!two || !has2P || filter !== 'ALL') {
      s.flipAt = 0;
      s.auto = false;
      return { state: s, actions: out };
    }
    if (now >= s.flipAt) {
      s.flipAt = 0;
      s.tuckAt = now + REVEAL_HOLD_MS;
      out.setFilter = '2P';
      out.markSeen = true;
    }
    return { state: s, actions: out };
  }
  if (s.tuckAt) {
    if (now >= s.tuckAt) {
      s.tuckAt = 0;
      out.hideChips = true;
    }
    return { state: s, actions: out };
  }
  if (two && has2P) {
    if (!s.auto && !s.manual && filter === 'ALL') {
      s.auto = true;
      if (seen) {
        out.setFilter = '2P';
        out.hideChips = true;
      } else {
        out.showChips = true;
        s.flipAt = now + REVEAL_FLIP_MS;
      }
    }
    return { state: s, actions: out };
  }
  // One player again (or nothing to trim to).
  s.manual = false;
  if (s.auto) {
    s.auto = false;
    if (filter === '2P') out.setFilter = 'ALL';
    out.showChips = true;
  }
  return { state: s, actions: out };
}

/** The player picked a filter by hand. */
export function filterPickedByHand(state) {
  return { ...state, auto: false, manual: true, flipAt: 0, tuckAt: 0 };
}
