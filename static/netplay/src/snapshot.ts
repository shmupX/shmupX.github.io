// The wire format for a live run's world state.
//
// The host encodes one of these a few times a second; watchers render it as
// the lobby preview and the guest renders it as the game. It is deliberately
// opaque to the SpacetimeDB module (which stores it as a string), so this file
// is the only place the format is known and it can change without republishing
// the module — the version byte lets a stale client bail instead of drawing
// garbage.
//
// Size is the whole design constraint. A snapshot at 15Hz per session is the
// bulk of the bandwidth, so every entity is packed to the fewest bytes that
// still look right:
//
//   - ships are 16.3 fixed point (1/8 px). The guest's own ship is drawn from
//     local prediction, but the OTHER ship is drawn straight from here and
//     whole-pixel jitter would be visible at 60fps.
//   - everything else is a byte per axis. X is already 0..255; Y is halved to
//     fit, which costs 2px of vertical precision on enemies and bullets. At
//     the speed they move, nobody can see it.
//
// Caps match the runtime's own limits (48 live zako) with headroom, and exist
// so a pathological frame cannot exceed the module's 8KB blob ceiling.

export const SNAPSHOT_MAGIC = 0x53; // 'S'
export const SNAPSHOT_VERSION = 1;

export const MAX_PLAYERS = 2;
export const MAX_ENEMIES = 64;
export const MAX_BULLETS = 96;
export const MAX_ENEMY_BULLETS = 128;

export const FLAG_STARTED = 1 << 0;
export const FLAG_BOSS = 1 << 1;
export const FLAG_CLEARED = 1 << 2;
export const FLAG_FROZEN = 1 << 3; // theWorldFlg — the SP cinematic

export interface SnapshotShip {
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  dead: boolean;
}

export interface SnapshotEntity {
  x: number;
  y: number;
  /** Index into the level's own enemy roster, so the guest can pick the art. */
  kind: number;
}

export interface SnapshotDot {
  x: number;
  y: number;
}

export interface Snapshot {
  flags: number;
  stage: number;
  score: number;
  ships: SnapshotShip[];
  enemies: SnapshotEntity[];
  bullets: SnapshotDot[];
  enemyBullets: SnapshotDot[];
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

// atob/Buffer-free, like the rest of this project's codecs: the same bundle is
// loaded by the browser, by the Deno smoke test, and by anything else that
// wants to read a snapshot.
function toBase64(bytes: Uint8Array): string {
  let out = "";
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < bytes.length; i++) {
    acc = (acc << 8) | bytes[i];
    bits += 8;
    while (bits >= 6) {
      bits -= 6;
      out += B64[(acc >> bits) & 63];
    }
  }
  if (bits) out += B64[(acc << (6 - bits)) & 63];
  while (out.length % 4) out += "=";
  return out;
}

function fromBase64(s: string): Uint8Array {
  const clean = s.replace(/=+$/, "");
  const out = new Uint8Array((clean.length * 3) >> 2);
  let acc = 0;
  let bits = 0;
  let o = 0;
  for (let i = 0; i < clean.length; i++) {
    acc = (acc << 6) | B64.indexOf(clean[i]);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
  }
  return out;
}

const clampByte = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v | 0);

export function encodeSnapshot(s: Snapshot): string {
  const ships = s.ships.slice(0, MAX_PLAYERS);
  const enemies = s.enemies.slice(0, MAX_ENEMIES);
  const bullets = s.bullets.slice(0, MAX_BULLETS);
  const eb = s.enemyBullets.slice(0, MAX_ENEMY_BULLETS);

  const bytes = new Uint8Array(
    12 + ships.length * 6 + enemies.length * 3 + bullets.length * 2 + eb.length * 2,
  );
  const dv = new DataView(bytes.buffer);
  bytes[0] = SNAPSHOT_MAGIC;
  bytes[1] = SNAPSHOT_VERSION;
  bytes[2] = s.flags & 0xff;
  bytes[3] = s.stage & 0xff;
  // Score is the shared pot and can outgrow u32 in a long run; it is clamped
  // rather than wrapped, because a lobby showing 12 for a 4-billion-point run
  // is worse than one showing the ceiling.
  dv.setUint32(4, Math.min(0xffffffff, Math.max(0, Math.floor(s.score))), true);
  bytes[8] = ships.length;
  bytes[9] = enemies.length;
  bytes[10] = bullets.length;
  bytes[11] = eb.length;

  let p = 12;
  for (const sh of ships) {
    // 1/8 px, so a ship's drift reads smoothly on the other client.
    dv.setUint16(p, Math.max(0, Math.min(0xffff, Math.round(sh.x * 8))), true);
    dv.setUint16(p + 2, Math.max(0, Math.min(0xffff, Math.round(sh.y * 8))), true);
    bytes[p + 4] = clampByte(sh.hp);
    bytes[p + 5] = (clampByte(sh.maxHp) & 0x7f) | (sh.dead ? 0x80 : 0);
    p += 6;
  }
  for (const e of enemies) {
    bytes[p] = clampByte(e.x);
    bytes[p + 1] = clampByte(e.y >> 1);
    bytes[p + 2] = clampByte(e.kind);
    p += 3;
  }
  for (const b of bullets) {
    bytes[p] = clampByte(b.x);
    bytes[p + 1] = clampByte(b.y >> 1);
    p += 2;
  }
  for (const b of eb) {
    bytes[p] = clampByte(b.x);
    bytes[p + 1] = clampByte(b.y >> 1);
    p += 2;
  }
  return toBase64(bytes);
}

/** null when the blob is truncated, corrupt, or from a newer client. */
export function decodeSnapshot(blob: string): Snapshot | null {
  if (!blob) return null;
  let bytes: Uint8Array;
  try {
    bytes = fromBase64(blob);
  } catch {
    return null;
  }
  if (bytes.length < 12) return null;
  if (bytes[0] !== SNAPSHOT_MAGIC || bytes[1] !== SNAPSHOT_VERSION) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const nShips = bytes[8];
  const nEnemies = bytes[9];
  const nBullets = bytes[10];
  const nEb = bytes[11];
  const need = 12 + nShips * 6 + nEnemies * 3 + nBullets * 2 + nEb * 2;
  if (bytes.length < need) return null;

  let p = 12;
  const ships: SnapshotShip[] = [];
  for (let i = 0; i < nShips; i++) {
    ships.push({
      x: dv.getUint16(p, true) / 8,
      y: dv.getUint16(p + 2, true) / 8,
      hp: bytes[p + 4],
      maxHp: bytes[p + 5] & 0x7f,
      dead: (bytes[p + 5] & 0x80) !== 0,
    });
    p += 6;
  }
  const enemies: SnapshotEntity[] = [];
  for (let i = 0; i < nEnemies; i++) {
    enemies.push({ x: bytes[p], y: bytes[p + 1] << 1, kind: bytes[p + 2] });
    p += 3;
  }
  const bullets: SnapshotDot[] = [];
  for (let i = 0; i < nBullets; i++) {
    bullets.push({ x: bytes[p], y: bytes[p + 1] << 1 });
    p += 2;
  }
  const enemyBullets: SnapshotDot[] = [];
  for (let i = 0; i < nEb; i++) {
    enemyBullets.push({ x: bytes[p], y: bytes[p + 1] << 1 });
    p += 2;
  }
  return {
    flags: bytes[2],
    stage: bytes[3],
    score: dv.getUint32(4, true),
    ships,
    enemies,
    bullets,
    enemyBullets,
  };
}

// --- guest input ----------------------------------------------------------
//
// One u32 per frame. Buttons are a bitfield; there is no analog axis because
// the runtime's own movement is digital (keyMoveSpeed per step), so a stick is
// thresholded to the same four directions before it gets here.

export const IN_LEFT = 1 << 0;
export const IN_RIGHT = 1 << 1;
export const IN_UP = 1 << 2;
export const IN_DOWN = 1 << 3;
export const IN_FIRE = 1 << 4; // the bomb / SP button
export const IN_CHARGE = 1 << 5;

export interface GuestInput {
  left: boolean;
  right: boolean;
  up: boolean;
  down: boolean;
  fire: boolean;
  charge: boolean;
}

export function packInput(i: GuestInput): number {
  return (i.left ? IN_LEFT : 0) |
    (i.right ? IN_RIGHT : 0) |
    (i.up ? IN_UP : 0) |
    (i.down ? IN_DOWN : 0) |
    (i.fire ? IN_FIRE : 0) |
    (i.charge ? IN_CHARGE : 0);
}

export function unpackInput(bits: number): GuestInput {
  return {
    left: (bits & IN_LEFT) !== 0,
    right: (bits & IN_RIGHT) !== 0,
    up: (bits & IN_UP) !== 0,
    down: (bits & IN_DOWN) !== 0,
    fire: (bits & IN_FIRE) !== 0,
    charge: (bits & IN_CHARGE) !== 0,
  };
}
