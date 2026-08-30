// End-to-end check of online 2P against a real SpacetimeDB.
//
// Two clients connect over WebSocket exactly as two browsers would — one
// hosts, one joins — and the test walks the whole flow: the run appears in the
// lobby, the guest takes the seat, buttons travel guest->host, frames travel
// host->guest, and leaving frees the seat again.
//
// Gated on a server actually being there, like the engine's fixture-gated
// tests, so the suite stays green on a machine with no SpacetimeDB:
//
//   spacetimedb-standalone start --data-dir /tmp/stdb-data \
//     --jwt-pub-key-path /tmp/stdb-data/id_ecdsa.pub \
//     --jwt-priv-key-path /tmp/stdb-data/id_ecdsa
//   cd spacetimedb && spacetime publish shmupx-netplay --server local --yes
//   deno test -A tests/netplay_smoke_test.ts
//
// Point it elsewhere with SHMUPX_NETPLAY_URI / SHMUPX_NETPLAY_DB.

import { assert, assertEquals } from "@std/assert";
// Values come from the BUNDLE, so this exercises exactly the file the browser
// loads. Types come from the sources it was built from — esbuild emits no
// declarations, and snapshot.ts is dependency-free so importing it costs
// nothing at runtime (it is type-only).
import {
  decodeSnapshot,
  encodeSnapshot,
  Netplay,
  packInput,
  unpackInput,
} from "../static/netplay/shmupx-netplay.js";
import type { GuestInput, Snapshot } from "../static/netplay/src/snapshot.ts";

// Declared here rather than imported from client.ts: that module pulls in the
// SpacetimeDB SDK, whose types live under spacetimedb/module/node_modules and
// are not resolvable from the repo root. This is the shape the lobby consumes,
// so writing it out also pins what the test is asserting about.
interface LiveSession {
  hostHex: string;
  gameId: string;
  title: string;
  stage: number;
  score: number;
  players: number;
  joinable: boolean;
  mine: boolean;
}

const URI = Deno.env.get("SHMUPX_NETPLAY_URI") ?? "ws://127.0.0.1:3000";
const DB = Deno.env.get("SHMUPX_NETPLAY_DB") ?? "shmupx-netplay";
const HTTP = URI.replace(/^ws/, "http");

async function serverUp(): Promise<boolean> {
  try {
    const res = await fetch(`${HTTP}/v1/ping`, {
      signal: AbortSignal.timeout(1500),
    });
    await res.body?.cancel();
    return res.ok;
  } catch {
    return false;
  }
}

const UP = await serverUp();
if (!UP) {
  console.log(
    `%c[netplay] no SpacetimeDB at ${HTTP} — skipping the online tests`,
    "color: gray",
  );
}

/** Poll until `check` passes, so the test follows the network, not a sleep. */
async function until<T>(
  label: string,
  check: () => T | null | undefined | false,
  timeoutMs = 8000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = check();
    if (v) return v as T;
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${label}`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

function world(score: number, shipX: number): Snapshot {
  return {
    flags: 1,
    stage: 2,
    score,
    ships: [
      { x: shipX, y: 400, hp: 3, maxHp: 3, dead: false },
      { x: 192, y: 400, hp: 2, maxHp: 3, dead: false },
    ],
    enemies: [{ x: 40, y: 100, kind: 3 }, { x: 200, y: 250, kind: 1 }],
    bullets: [{ x: 64, y: 380 }],
    enemyBullets: [{ x: 41, y: 120 }, { x: 210, y: 260 }],
  };
}

Deno.test("the snapshot codec round-trips within its stated precision", () => {
  // Pure, so it runs with or without a server — this is the format contract
  // both ends of the wire depend on.
  const w = world(123456, 64.375);
  const back = decodeSnapshot(encodeSnapshot(w));
  assert(back, "decodes");
  assertEquals(back.stage, 2);
  assertEquals(back.score, 123456);
  assertEquals(back.flags, 1);
  // Ships are 1/8 px, so an exact eighth survives exactly.
  assertEquals(back.ships[0].x, 64.375);
  assertEquals(back.ships[0].hp, 3);
  assertEquals(back.ships[1].maxHp, 3);
  assertEquals(back.ships[1].dead, false);
  // Everything else is a byte per axis, with Y halved.
  assertEquals(back.enemies.map((e) => [e.x, e.y, e.kind]), [[40, 100, 3], [
    200,
    250,
    1,
  ]]);
  assertEquals(back.bullets, [{ x: 64, y: 380 }]);
  assertEquals(back.enemyBullets.length, 2);
});

Deno.test("a corrupt or foreign snapshot decodes to null, never to garbage", () => {
  assertEquals(decodeSnapshot(""), null);
  assertEquals(decodeSnapshot("bm90IGEgc25hcHNob3Q="), null); // wrong magic
  const good = encodeSnapshot(world(1, 10));
  assertEquals(decodeSnapshot(good.slice(0, 6)), null); // truncated
});

Deno.test("input packs and unpacks every button", () => {
  const all: GuestInput = {
    left: true,
    right: false,
    up: true,
    down: false,
    fire: true,
    charge: true,
  };
  assertEquals(unpackInput(packInput(all)), all);
  assertEquals(
    packInput({
      left: false,
      right: false,
      up: false,
      down: false,
      fire: false,
      charge: false,
    }),
    0,
  );
});

Deno.test({
  name: "a hosted run is visible, joinable, and relays input and frames",
  ignore: !UP,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const gameId = `smoke-${crypto.randomUUID().slice(0, 8)}`;
    const host = new Netplay();
    const guest = new Netplay();
    await host.connect({ uri: URI, moduleName: DB, gameId });
    await guest.connect({ uri: URI, moduleName: DB, gameId });
    assert(host.online, "host connected");
    assert(guest.online, "guest connected");

    try {
      let seen: LiveSession[] = [];
      guest.onSessions((rows: LiveSession[]) => {
        seen = rows;
      });

      // --- the run appears in the lobby --------------------------------
      host.openSession(gameId, "SMOKE LEVEL", 1, true);
      const listed = await until("the session to reach the lobby", () => {
        const row = seen.find((r) => r.hostHex === host.identityHex);
        return row ?? null;
      });
      assertEquals(listed.title, "SMOKE LEVEL");
      assertEquals(listed.joinable, true);
      assertEquals(listed.players, 1);
      assertEquals(listed.mine, false, "the guest does not own this run");

      // --- the guest watches before committing -------------------------
      const frames: Snapshot[] = [];
      const unwatch = guest.watch(
        host.identityHex!,
        (s: Snapshot) => frames.push(s),
      );
      host.publishSnapshot(world(4200, 64));
      const first = await until("a preview frame", () => frames[0] ?? null);
      assertEquals(first.score, 4200);
      assertEquals(first.ships.length, 2);

      // --- and then takes the seat -------------------------------------
      const joined = await guest.join(host.identityHex!);
      assertEquals(joined.error, undefined);
      assert(joined.ok, "join accepted");

      await until("the seat to close", () => {
        const row = seen.find((r) => r.hostHex === host.identityHex);
        return row && !row.joinable && row.players === 2 ? row : null;
      });

      // --- buttons travel guest -> host --------------------------------
      const got: number[] = [];
      host.onGuestInput(({ bits }: { bits: number }) => got.push(bits));
      guest.sendInput({
        left: true,
        right: false,
        up: false,
        down: false,
        fire: true,
        charge: false,
      });
      const bits = await until(
        "the host to see the guest's buttons",
        () => got.at(-1) ?? null,
      );
      const decoded = unpackInput(bits);
      assertEquals(decoded.left, true);
      assertEquals(decoded.fire, true);
      assertEquals(decoded.right, false);

      // --- frames keep travelling host -> guest -------------------------
      host.publishSnapshot(world(9001, 70));
      await until(
        "a gameplay frame",
        () => frames.find((f) => f.score === 9001) ?? null,
      );

      // --- leaving frees the seat --------------------------------------
      guest.leave();
      await until("the seat to reopen", () => {
        const row = seen.find((r) => r.hostHex === host.identityHex);
        return row && row.joinable && row.players === 1 ? row : null;
      });

      unwatch();
      // --- and closing the run clears it from the lobby ----------------
      host.closeSession();
      await until("the session to disappear", () => {
        return seen.every((r) => r.hostHex !== host.identityHex) ? true : null;
      });
    } finally {
      host.disconnect();
      guest.disconnect();
      // Let the sockets finish closing so the test runner sees no stray work.
      await new Promise((r) => setTimeout(r, 150));
    }
  },
});

Deno.test({
  name: "a heartbeat does not re-announce the seat",
  ignore: !UP,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    // Regression: onSeat used to fire on EVERY session update, and the host
    // re-seats its guest when it does — which reset the buttons the guest was
    // holding several times a second, so a held direction moved the ship a few
    // pixels and then stopped dead.
    const gameId = `smoke-${crypto.randomUUID().slice(0, 8)}`;
    const host = new Netplay();
    const guest = new Netplay();
    await host.connect({ uri: URI, moduleName: DB, gameId });
    await guest.connect({ uri: URI, moduleName: DB, gameId });

    try {
      const seats: Array<{ guestHex: string | null }> = [];
      host.onSeat((ev: { guestHex: string | null }) => seats.push(ev));
      host.openSession(gameId, "HEARTBEAT", 1, true);

      let rows: LiveSession[] = [];
      guest.onSessions((r: LiveSession[]) => {
        rows = r;
      });
      await until(
        "the run to be listed",
        () => rows.find((r) => r.hostHex === host.identityHex) ?? null,
      );

      assert((await guest.join(host.identityHex!)).ok, "guest seated");
      await until("the seat event", () => seats.length >= 1);
      const afterJoin = seats.length;
      assertEquals(seats[0].guestHex, guest.identityHex);

      // Everything a live host does between seat changes: heartbeats and
      // frames, both of which write the same session row.
      for (let i = 0; i < 4; i++) {
        host.updateSession(1, 100 * i, 2, false);
        host.publishSnapshot(world(100 * i, 64));
        await new Promise((r) => setTimeout(r, 60));
      }
      await new Promise((r) => setTimeout(r, 250));
      assertEquals(seats.length, afterJoin, "no seat events from heartbeats");

      // A real change still reports.
      guest.leave();
      await until("the vacate event", () => seats.length > afterJoin);
      assertEquals(seats[seats.length - 1].guestHex, null);
    } finally {
      host.disconnect();
      guest.disconnect();
      await new Promise((r) => setTimeout(r, 150));
    }
  },
});

Deno.test({
  name: "a guest cannot keep a dead run alive by joining it",
  ignore: !UP,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    // `updatedAt` is the HOST's heartbeat and the only thing the reaper reads.
    // requestJoin used to refresh it, which would have let anyone hold a
    // finished run in the lobby indefinitely.
    const gameId = `smoke-${crypto.randomUUID().slice(0, 8)}`;
    const host = new Netplay();
    const guest = new Netplay();
    await host.connect({ uri: URI, moduleName: DB, gameId });
    await guest.connect({ uri: URI, moduleName: DB, gameId });

    try {
      let rows: LiveSession[] = [];
      guest.onSessions((r: LiveSession[]) => {
        rows = r;
      });
      host.openSession(gameId, "REAPER", 1, true);
      await until(
        "the run to be listed",
        () => rows.find((r) => r.hostHex === host.identityHex) ?? null,
      );

      const before = rows.find((r) =>
        r.hostHex === host.identityHex
      )!.updatedAt;
      assert(before > 0, "the session has a heartbeat");
      assert((await guest.join(host.identityHex!)).ok, "guest seated");
      const seated = await until("the seat to close", () => {
        const row = rows.find((r) => r.hostHex === host.identityHex);
        return row && !row.joinable ? row : null;
      });
      assertEquals(
        seated.updatedAt,
        before,
        "joining did not touch the heartbeat",
      );
    } finally {
      host.disconnect();
      guest.disconnect();
      await new Promise((r) => setTimeout(r, 150));
    }
  },
});

Deno.test({
  name: "a host whose session was reaped re-announces itself",
  ignore: !UP,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    // A slept laptop or a long stage transition can outlast the module's
    // staleness window. Every later call then failed the same way forever;
    // now the first failure re-opens the session.
    const gameId = `smoke-${crypto.randomUUID().slice(0, 8)}`;
    const host = new Netplay();
    const watcher = new Netplay();
    await host.connect({ uri: URI, moduleName: DB, gameId });
    await watcher.connect({ uri: URI, moduleName: DB, gameId });

    try {
      let rows: LiveSession[] = [];
      watcher.onSessions((r: LiveSession[]) => {
        rows = r;
      });
      host.openSession(gameId, "REVIVE", 1, true);
      await until(
        "the run to be listed",
        () => rows.find((r) => r.hostHex === host.identityHex) ?? null,
      );

      // Go quiet for longer than the module's staleness window (15s) so the
      // real reaper collects the row — no privileged SQL, exactly what a
      // slept laptop does to itself.
      await until(
        "the reaper to collect the silent run",
        () => rows.every((r) => r.hostHex !== host.identityHex),
        30000,
      );

      // The host does not know it was reaped; it just keeps heartbeating.
      host.updateSession(1, 500, 1, true);
      await until(
        "the host to re-announce itself",
        () => rows.find((r) => r.hostHex === host.identityHex) ?? null,
        10000,
      );
    } finally {
      host.disconnect();
      watcher.disconnect();
      await new Promise((r) => setTimeout(r, 150));
    }
  },
});

Deno.test({
  name: "the second seat is first-come, and a host cannot join itself",
  ignore: !UP,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const gameId = `smoke-${crypto.randomUUID().slice(0, 8)}`;
    const host = new Netplay();
    const a = new Netplay();
    const b = new Netplay();
    await host.connect({ uri: URI, moduleName: DB, gameId });
    await a.connect({ uri: URI, moduleName: DB, gameId });
    await b.connect({ uri: URI, moduleName: DB, gameId });

    try {
      let rows: LiveSession[] = [];
      a.onSessions((r: LiveSession[]) => {
        rows = r;
      });
      host.openSession(gameId, "CONTESTED", 1, true);
      await until(
        "the run to be listed",
        () => rows.find((r) => r.hostHex === host.identityHex) ?? null,
      );

      const first = await a.join(host.identityHex!);
      assert(first.ok, `first join accepted: ${first.error ?? ""}`);

      const second = await b.join(host.identityHex!);
      assertEquals(second.ok, false, "the second seat is already taken");
      assert(second.error, "and says so");

      const selfJoin = await host.join(host.identityHex!);
      assertEquals(
        selfJoin.ok,
        false,
        "a host cannot take its own second seat",
      );
    } finally {
      host.disconnect();
      a.disconnect();
      b.disconnect();
      await new Promise((r) => setTimeout(r, 150));
    }
  },
});
