// shmupX netplay client — the whole browser-side surface of online 2P.
//
// Bundled by scripts/build-netplay.ts into static/netplay/shmupx-netplay.js so
// the game page can `import("/netplay/shmupx-netplay.js")` with no CDN and no
// import map, the same rule static/engine/shmup-engine.js follows: the
// launcher's mapped gamepad/keyboard input needs a same-origin gameframe.
//
// Three roles, one connection:
//
//   lobby   subscribe to `session` and watch who is playing what. Cheap enough
//           to leave running on a title screen or a dashboard.
//   host    own a `session` row, heartbeat it, publish snapshots, and read the
//           guest's input rows.
//   guest   take a seat, stream input, and render the host's snapshots.
//
// Everything here is fire-and-forget. A dead network must never take the game
// down with it: no call throws into the game loop, and every failure path ends
// with the game running offline exactly as it does today.

import { DbConnection, type EventContext, type Session, type Snapshot } from "../bindings/index.ts";
import { Identity } from "spacetimedb";
import {
  decodeSnapshot,
  encodeSnapshot,
  type GuestInput,
  packInput,
  type Snapshot as WorldSnapshot,
  unpackInput,
} from "./snapshot.ts";

export * from "./snapshot.ts";

/** Where the module lives. Overridable so a dev can point at a local server. */
export const DEFAULT_URI = "wss://maincloud.spacetimedb.com";
export const DEFAULT_MODULE = "shmupx-netplay";

export interface LiveSession {
  hostHex: string;
  gameId: string;
  title: string;
  stage: number;
  score: number;
  players: number;
  joinable: boolean;
  /** The host's last heartbeat, in ms since the epoch. */
  updatedAt: number;
  /** True when this client is the one hosting it. */
  mine: boolean;
}

type Listener<T> = (value: T) => void;

/** The module's own message, where it gave one. */
function reason(err: unknown): string {
  if (!err) return "unknown error";
  const msg = (err as { message?: string }).message ?? String(err);
  return msg.replace(/^Error:\s*/, "");
}

function emit<T>(set: Set<Listener<T>>, value: T) {
  for (const fn of [...set]) {
    try {
      fn(value);
    } catch (err) {
      console.warn("[netplay] listener threw", err);
    }
  }
}

export interface ConnectOptions {
  uri?: string;
  moduleName?: string;
  /** Only sessions for this game reach the lobby listeners. Omit for all. */
  gameId?: string;
  onStatus?: (status: "connecting" | "online" | "offline", detail?: string) => void;
}

export class Netplay {
  private conn: DbConnection | null = null;
  private identity: Identity | null = null;
  private sessionListeners = new Set<Listener<LiveSession[]>>();
  private snapshotListeners = new Map<string, Set<Listener<WorldSnapshot>>>();
  private inputListeners = new Set<Listener<{ seq: number; bits: number; input: GuestInput }>>();
  private seatListeners = new Set<Listener<{ guestHex: string | null }>>();
  private gameId: string | undefined;
  private status: "connecting" | "online" | "offline" = "offline";
  private onStatus: ConnectOptions["onStatus"];
  private hosting = false;
  private seatedOn: string | null = null;
  private inputSeq = 0;
  private snapshotSeq = 0;
  private lastSentBits = -1;
  private lastOpen: { gameId: string; title: string; players: number; joinable: boolean } | null = null;
  private reopening = false;

  get online() {
    return this.status === "online";
  }
  get identityHex() {
    return this.identity ? this.identity.toHexString() : null;
  }
  get isHosting() {
    return this.hosting;
  }
  get joinedHost() {
    return this.seatedOn;
  }

  connect(opts: ConnectOptions = {}): Promise<void> {
    this.gameId = opts.gameId;
    this.onStatus = opts.onStatus;
    this.setStatus("connecting");
    return new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };
      try {
        DbConnection.builder()
          .withUri(opts.uri ?? DEFAULT_URI)
          .withDatabaseName(opts.moduleName ?? DEFAULT_MODULE)
          .onConnect((conn, identity) => {
            this.conn = conn;
            this.identity = identity;
            this.setStatus("online");
            this.wire(conn);
            done();
          })
          .onConnectError((_ctx, err) => {
            this.setStatus("offline", String(err));
            done();
          })
          .onDisconnect(() => {
            this.conn = null;
            this.hosting = false;
            this.seatedOn = null;
            this.setStatus("offline");
            emit(this.sessionListeners, []);
            done();
          })
          .build();
      } catch (err) {
        this.setStatus("offline", String(err));
        done();
      }
    });
  }

  /**
   * Reducer calls are async and reject when the module refuses. Nothing here
   * is worth interrupting a game for — a dropped heartbeat or a lost input
   * frame is corrected by the next one — so failures are logged and swallowed
   * rather than left to surface as unhandled rejections.
   */
  private fire(label: string, p: Promise<unknown> | undefined) {
    if (!p || typeof p.then !== "function") return;
    p.catch((err: unknown) => {
      const why = reason(err);
      // The module reaps a session whose host went quiet — a slept laptop, a
      // tunnel, a long stage transition. Every later call then fails the same
      // way forever, so the first one re-announces instead of giving up.
      if (this.hosting && why.includes("no session for this identity")) {
        this.reopen();
        return;
      }
      if (label !== "sendInput" && label !== "publishSnapshot") {
        console.warn(`[netplay] ${label} refused: ${why}`);
      }
    });
  }

  /** Re-announce a session the server no longer has. At most one in flight. */
  private reopen() {
    if (!this.conn || !this.lastOpen || this.reopening) return;
    this.reopening = true;
    const o = this.lastOpen;
    this.fireRaw(
      this.conn.reducers.openSession({
        gameId: o.gameId,
        title: o.title,
        players: o.players,
        joinable: o.joinable,
      }),
    );
    // One attempt per second at most, however many calls are failing.
    setTimeout(() => {
      this.reopening = false;
    }, 1000);
  }

  private fireRaw(p: Promise<unknown> | undefined) {
    if (p && typeof p.then === "function") p.catch(() => {});
  }

  private setStatus(status: typeof this.status, detail?: string) {
    this.status = status;
    try {
      this.onStatus?.(status, detail);
    } catch { /* a status listener must never break the connection */ }
  }

  private wire(conn: DbConnection) {
    // One subscription for the directory, one for the frames. Split because
    // they have very different lifetimes: the lobby list is up the whole time
    // a title screen is, while snapshots only matter while watching or
    // playing, and they are by far the heavier stream.
    conn.subscriptionBuilder()
      .onError((_ctx, err) => console.warn("[netplay] subscription error", err))
      .subscribe(["SELECT * FROM session", "SELECT * FROM snapshot", "SELECT * FROM input"]);

    const push = () => this.pushSessions();
    conn.db.session.onInsert(push);
    conn.db.session.onUpdate((_ctx: EventContext, old: Session, row: Session) => {
      push();
      if (!this.hosting || !this.identity || !row.host.isEqual(this.identity)) return;
      // Only when the seat actually CHANGES HANDS. This row is also updated by
      // every heartbeat and every snapshot, and a listener that fired on all of
      // those would have the host re-seat its guest several times a second —
      // wiping the buttons it had just received.
      const before = old.guest ? old.guest.toHexString() : null;
      const after = row.guest ? row.guest.toHexString() : null;
      if (before === after) return;
      emit(this.seatListeners, { guestHex: after });
    });
    conn.db.session.onDelete(push);

    const onSnap = (_ctx: EventContext, row: Snapshot) => {
      const hostHex = row.host.toHexString();
      const set = this.snapshotListeners.get(hostHex);
      if (!set || !set.size) return;
      const decoded = decodeSnapshot(row.blob);
      if (decoded) emit(set, decoded);
    };
    conn.db.snapshot.onInsert(onSnap);
    conn.db.snapshot.onUpdate((ctx: EventContext, _o: Snapshot, row: Snapshot) => onSnap(ctx, row));

    const onInput = (_ctx: EventContext, row: { host: Identity; seq: number; bits: number }) => {
      if (!this.hosting || !this.identity || !row.host.isEqual(this.identity)) return;
      emit(this.inputListeners, { seq: row.seq, bits: row.bits, input: unpackInput(row.bits) });
    };
    conn.db.input.onInsert(onInput);
    conn.db.input.onUpdate((ctx: EventContext, _o: unknown, row: never) => onInput(ctx, row));
  }

  private pushSessions() {
    if (!this.conn) return;
    const rows: LiveSession[] = [];
    for (const row of this.conn.db.session.iter()) {
      if (this.gameId && row.gameId !== this.gameId) continue;
      const hostHex = row.host.toHexString();
      rows.push({
        hostHex,
        gameId: row.gameId,
        title: row.title,
        stage: row.stage,
        score: Number(row.score),
        players: row.players,
        joinable: row.joinable,
        updatedAt: Number(row.updatedAt.microsSinceUnixEpoch / 1000n),
        mine: this.identityHex === hostHex,
      });
    }
    rows.sort((a, b) => b.score - a.score);
    emit(this.sessionListeners, rows);
  }

  /** Live list of runs, filtered to this client's game when one was given. */
  onSessions(fn: Listener<LiveSession[]>): () => void {
    this.sessionListeners.add(fn);
    if (this.conn) this.pushSessions();
    return () => this.sessionListeners.delete(fn);
  }

  /** Frames from one host — the lobby preview and the guest's view alike. */
  watch(hostHex: string, fn: Listener<WorldSnapshot>): () => void {
    let set = this.snapshotListeners.get(hostHex);
    if (!set) {
      set = new Set();
      this.snapshotListeners.set(hostHex, set);
    }
    set.add(fn);
    // Paint immediately from whatever is already cached rather than waiting
    // for the host's next frame.
    const cached = this.conn?.db.snapshot.iter();
    if (cached) {
      for (const row of cached) {
        if (row.host.toHexString() !== hostHex) continue;
        const decoded = decodeSnapshot(row.blob);
        if (decoded) {
          try {
            fn(decoded);
          } catch { /* ignore */ }
        }
      }
    }
    return () => {
      const s = this.snapshotListeners.get(hostHex);
      if (!s) return;
      s.delete(fn);
      if (!s.size) this.snapshotListeners.delete(hostHex);
    };
  }

  // --- hosting ------------------------------------------------------------

  openSession(gameId: string, title: string, players: number, joinable: boolean) {
    if (!this.conn) return;
    this.hosting = true;
    this.snapshotSeq = 0;
    this.lastOpen = { gameId, title, players, joinable };
    this.fire("openSession", this.conn.reducers.openSession({ gameId, title, players, joinable }));
  }

  updateSession(stage: number, score: number, players: number, joinable: boolean) {
    if (!this.conn || !this.hosting) return;
    if (this.lastOpen) this.lastOpen = { ...this.lastOpen, players, joinable };
    this.fire(
      "updateSession",
      this.conn.reducers.updateSession({
        stage,
        score: BigInt(Math.max(0, Math.floor(score))),
        players,
        joinable,
      }),
    );
  }

  publishSnapshot(world: WorldSnapshot) {
    if (!this.conn || !this.hosting) return;
    this.fire(
      "publishSnapshot",
      this.conn.reducers.publishSnapshot({
        seq: this.snapshotSeq++ >>> 0,
        blob: encodeSnapshot(world),
      }),
    );
  }

  closeSession() {
    if (!this.conn || !this.hosting) return;
    this.hosting = false;
    this.lastOpen = null;
    this.fire("closeSession", this.conn.reducers.closeSession());
  }

  /** Fires when a guest takes or frees this host's second seat. */
  onSeat(fn: Listener<{ guestHex: string | null }>): () => void {
    this.seatListeners.add(fn);
    return () => this.seatListeners.delete(fn);
  }

  /** The guest's buttons, as they arrive. The host feeds these to player 2. */
  onGuestInput(fn: Listener<{ seq: number; bits: number; input: GuestInput }>): () => void {
    this.inputListeners.add(fn);
    return () => this.inputListeners.delete(fn);
  }

  // --- guesting -----------------------------------------------------------

  /**
   * Take the second seat. Resolves with the module's own refusal reason when
   * it says no ("the second seat is taken", "that run has ended"), so the UI
   * can say something true rather than a generic failure.
   */
  async join(hostHex: string): Promise<{ ok: boolean; error?: string }> {
    if (!this.conn) return { ok: false, error: "offline" };
    try {
      await this.conn.reducers.requestJoin({ host: Identity.fromString(hostHex) });
      this.seatedOn = hostHex;
      this.inputSeq = 0;
      this.lastSentBits = -1;
      return { ok: true };
    } catch (err) {
      return { ok: false, error: reason(err) };
    }
  }

  leave() {
    if (!this.conn || !this.seatedOn) return;
    this.seatedOn = null;
    this.fire("leaveSession", this.conn.reducers.leaveSession());
  }

  /**
   * Stream one frame of buttons. Unchanged input is not resent — the host
   * holds the last value, so a still stick costs nothing.
   */
  sendInput(input: GuestInput) {
    if (!this.conn || !this.seatedOn) return;
    const bits = packInput(input);
    if (bits === this.lastSentBits) return;
    this.lastSentBits = bits;
    this.fire("sendInput", this.conn.reducers.sendInput({ seq: ++this.inputSeq >>> 0, bits }));
  }

  disconnect() {
    if (!this.conn) return;
    this.closeSession();
    this.leave();
    try {
      this.conn.disconnect();
    } catch { /* already gone */ }
    this.conn = null;
    this.setStatus("offline");
  }
}

/** One connection per page. Callers share it rather than opening their own. */
let shared: Netplay | null = null;
let sharedReady: Promise<Netplay> | null = null;

export function netplay(opts: ConnectOptions = {}): Promise<Netplay> {
  if (sharedReady) return sharedReady;
  shared = new Netplay();
  sharedReady = shared.connect(opts).then(() => shared!);
  return sharedReady;
}

export function currentNetplay(): Netplay | null {
  return shared;
}
