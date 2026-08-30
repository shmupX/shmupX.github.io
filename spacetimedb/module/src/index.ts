// Online two-player for shmupX.
//
// The shape of the thing: one browser HOSTS a run and simulates it — the
// Phaser sim in static/games/2028-ai/game.bundle.js, unchanged and
// authoritative — while anyone else in the world can see that run is live,
// watch it, and take the second seat. A guest does not simulate: it streams
// the host's snapshots and streams its own buttons back. That keeps one copy
// of the truth and needs no determinism from a runtime that has none.
//
// So this module is a relay and a directory, not a game server:
//
//   session   who is playing what, right now. The lobby reads this.
//   snapshot  the host's latest frame, overwritten in place. Watchers and the
//             guest render it; it is also the join preview.
//   input     the guest's buttons, overwritten in place. Only the host reads.
//
// Every table is keyed by the HOST's identity, so a session is exactly "a
// host", and a client owns precisely the rows it writes. Nothing here trusts
// an identity passed as an argument — `ctx.sender` decides everything.
//
// Rows are overwritten rather than appended: a 20Hz snapshot stream would
// otherwise be 20 inserts a second per session, and clients only ever want the
// newest one.

import { ScheduleAt, schema, SenderError, t, table } from "spacetimedb/server";

// A session with no update for this long is assumed dead — the tab was closed,
// the laptop slept, the network went away. clientDisconnected covers the clean
// cases; this covers the rest.
const STALE_MICROS = 15_000_000n;
const REAP_INTERVAL_MICROS = 5_000_000n;

// Sanity ceilings. These are not anti-cheat — the host is authoritative over
// its own run and can claim any score it likes — they just stop a malformed or
// hostile client from filling the table with junk the lobby has to render.
//
// KNOWN GAP: there is no rate limit. One identity can only ever own one
// session, one snapshot and one input row (every table is keyed by identity and
// every write is an overwrite), so the database cannot be grown without bound.
// What a hostile client CAN do is call publishSnapshot in a tight loop and make
// every subscriber pay for the updates. Fixing that properly means either a
// per-identity minimum interval checked against the row's own `at`, or moving
// snapshots off the subscription path entirely; neither is worth doing before
// this is public enough to be worth attacking.
const MAX_GAME_ID = 96;
const MAX_TITLE = 64;
const MAX_BLOB = 8192;

const session = table(
  {
    name: "session",
    public: true,
    indexes: [{ accessor: "by_game", algorithm: "btree", columns: ["gameId"] }],
  },
  {
    // The host IS the session; there is at most one per identity.
    host: t.identity().primaryKey(),
    // Which game this run is of, so the lobby can say "someone is playing THIS
    // one". shmupX's own resolveGameId() — a level slug, or a digest for an
    // imported save.
    gameId: t.string(),
    // Human-facing name of the level, for the lobby list.
    title: t.string(),
    stage: t.u32(),
    score: t.u64(),
    // How many ships are in the air, 1 or 2.
    players: t.u32(),
    // The host says whether the second seat is open. It closes when a guest
    // takes it, when the host's own player 2 is local, and when the run ends.
    joinable: t.bool(),
    // Who holds the second seat. Absent = free.
    guest: t.option(t.identity()),
    startedAt: t.timestamp(),
    // Heartbeat. The reaper below reads this and nothing else.
    updatedAt: t.timestamp(),
  },
);

const snapshot = table(
  { name: "snapshot", public: true },
  {
    host: t.identity().primaryKey(),
    seq: t.u32(),
    at: t.timestamp(),
    // Opaque to this module by design: the encoding is the client's business
    // (see static/netplay/snapshot.js), and keeping it opaque means the wire
    // format can change without a republish.
    blob: t.string(),
  },
);

const input = table(
  {
    name: "input",
    public: true,
    indexes: [{ accessor: "by_host", algorithm: "btree", columns: ["host"] }],
  },
  {
    guest: t.identity().primaryKey(),
    host: t.identity(),
    // Monotonic per guest. The host drops anything older than what it has, so
    // a reordered delivery cannot rewind the ship.
    seq: t.u32(),
    // Button bitfield + the analog stick, packed by the client.
    bits: t.u32(),
    at: t.timestamp(),
  },
);

// Scheduled reaper. A reducer cannot look at a clock of its own, so the
// sweep has to be driven by the scheduler rather than by, say, checking
// staleness inside every other reducer.
const reapTimer = table(
  { name: "reap_timer", scheduled: (): any => reap },
  {
    scheduled_id: t.u64().primaryKey().autoInc(),
    scheduled_at: t.scheduleAt(),
  },
);

const spacetimedb = schema({ session, snapshot, input, reapTimer });
export default spacetimedb;

export const init = spacetimedb.init((ctx) => {
  ctx.db.reapTimer.insert({
    scheduled_id: 0n,
    scheduled_at: ScheduleAt.interval(REAP_INTERVAL_MICROS),
  });
});

/** Drop a session and everything hanging off it. */
function tearDown(ctx: any, host: any) {
  ctx.db.snapshot.host.delete(host);
  for (const row of [...ctx.db.input.by_host.filter(host)]) {
    ctx.db.input.guest.delete(row.guest);
  }
  ctx.db.session.host.delete(host);
}

export const reap = spacetimedb.reducer(
  { timer: reapTimer.rowType },
  (ctx) => {
    const cutoff = ctx.timestamp.microsSinceUnixEpoch - STALE_MICROS;
    for (const row of [...ctx.db.session.iter()]) {
      if (row.updatedAt.microsSinceUnixEpoch < cutoff) tearDown(ctx, row.host);
    }
  },
);

export const onDisconnect = spacetimedb.clientDisconnected((ctx) => {
  // Hosting: the run is over for everyone.
  if (ctx.db.session.host.find(ctx.sender)) tearDown(ctx, ctx.sender);
  // Guesting: free the seat, leave the run alone.
  const seat = ctx.db.input.guest.find(ctx.sender);
  if (seat) ctx.db.input.guest.delete(ctx.sender);
  for (const row of [...ctx.db.session.iter()]) {
    if (row.guest && row.guest.isEqual(ctx.sender)) {
      ctx.db.session.host.update({
        ...row,
        guest: undefined,
        joinable: true,
        players: 1,
      });
    }
  }
});

function clamp(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}

/** Announce (or re-announce) that this identity is hosting a live run. */
export const openSession = spacetimedb.reducer(
  {
    gameId: t.string(),
    title: t.string(),
    players: t.u32(),
    joinable: t.bool(),
  },
  (ctx, { gameId, title, players, joinable }) => {
    if (!gameId) throw new SenderError("gameId is required");
    if (players < 1 || players > 2) {
      throw new SenderError("players out of range");
    }
    const existing = ctx.db.session.host.find(ctx.sender);
    const row = {
      host: ctx.sender,
      gameId: clamp(gameId, MAX_GAME_ID),
      title: clamp(title, MAX_TITLE),
      stage: 0,
      score: 0n,
      players,
      joinable,
      guest: existing?.guest,
      startedAt: existing?.startedAt ?? ctx.timestamp,
      updatedAt: ctx.timestamp,
    };
    if (existing) ctx.db.session.host.update(row);
    else ctx.db.session.insert(row);
  },
);

/** Heartbeat + the numbers the lobby shows. Called a few times a second. */
export const updateSession = spacetimedb.reducer(
  { stage: t.u32(), score: t.u64(), players: t.u32(), joinable: t.bool() },
  (ctx, { stage, score, players, joinable }) => {
    const existing = ctx.db.session.host.find(ctx.sender);
    if (!existing) throw new SenderError("no session for this identity");
    ctx.db.session.host.update({
      ...existing,
      stage,
      score,
      players,
      // A seat that is already taken is not on offer again.
      joinable: joinable && !existing.guest,
      updatedAt: ctx.timestamp,
    });
  },
);

export const closeSession = spacetimedb.reducer((ctx) => {
  if (ctx.db.session.host.find(ctx.sender)) tearDown(ctx, ctx.sender);
});

/** The host's latest frame. Overwrites — watchers only want the newest. */
export const publishSnapshot = spacetimedb.reducer(
  { seq: t.u32(), blob: t.string() },
  (ctx, { seq, blob }) => {
    const live = ctx.db.session.host.find(ctx.sender);
    if (!live) throw new SenderError("no session for this identity");
    if (blob.length > MAX_BLOB) throw new SenderError("snapshot too large");
    const row = { host: ctx.sender, seq, at: ctx.timestamp, blob };
    if (ctx.db.snapshot.host.find(ctx.sender)) ctx.db.snapshot.host.update(row);
    else ctx.db.snapshot.insert(row);
    // Publishing a frame is itself proof of life, so the host does not have to
    // interleave updateSession calls at the snapshot rate.
    ctx.db.session.host.update({ ...live, updatedAt: ctx.timestamp });
  },
);

/** Take the second seat. First caller wins; the loser gets a clear error. */
export const requestJoin = spacetimedb.reducer(
  { host: t.identity() },
  (ctx, { host }) => {
    const live = ctx.db.session.host.find(host);
    if (!live) throw new SenderError("that run has ended");
    if (live.host.isEqual(ctx.sender)) {
      throw new SenderError("cannot join your own run");
    }
    if (live.guest) {
      // Idempotent for the holder: a retry after a flaky connection should not
      // read as "seat taken" to the player who already has it.
      if (live.guest.isEqual(ctx.sender)) return;
      throw new SenderError("the second seat is taken");
    }
    if (!live.joinable) {
      throw new SenderError("that run is not accepting a second player");
    }
    // Deliberately NOT touching updatedAt: that field is the HOST's heartbeat
    // and the only thing the reaper reads. Letting a guest refresh it would let
    // anyone keep a dead run in the lobby forever by re-joining it.
    ctx.db.session.host.update({
      ...live,
      guest: ctx.sender,
      joinable: false,
      players: 2,
    });
    ctx.db.input.insert({
      guest: ctx.sender,
      host,
      seq: 0,
      bits: 0,
      at: ctx.timestamp,
    });
  },
);

export const leaveSession = spacetimedb.reducer((ctx) => {
  const seat = ctx.db.input.guest.find(ctx.sender);
  if (seat) ctx.db.input.guest.delete(ctx.sender);
  for (const row of [...ctx.db.session.iter()]) {
    if (row.guest && row.guest.isEqual(ctx.sender)) {
      ctx.db.session.host.update({
        ...row,
        guest: undefined,
        joinable: true,
        players: 1,
      });
    }
  }
});

/** The guest's buttons for one frame. Overwrites; the host reads the latest. */
export const sendInput = spacetimedb.reducer(
  { seq: t.u32(), bits: t.u32() },
  (ctx, { seq, bits }) => {
    const seat = ctx.db.input.guest.find(ctx.sender);
    if (!seat) throw new SenderError("not seated in any run");
    // Late or duplicated deliveries must never rewind the ship.
    if (seq <= seat.seq && seat.seq - seq < 0x8000_0000) return;
    ctx.db.input.guest.update({ ...seat, seq, bits, at: ctx.timestamp });
  },
);
