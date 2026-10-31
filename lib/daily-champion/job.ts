/**
 * The daily world champion: just after 00:00 UTC, whoever holds a game's
 * TODAY'S BEST for the day that just ended gets a push notification saying so.
 *
 * - A board (leaderboards/<gameId>/daily/<UTC date>) names the browser that
 *   raised it by `holder`, the hash of a secret only that browser keeps
 *   (static/champion/champion.js; game.bundle.js writes it in the same
 *   transaction as the value). A record raised by a page without the champion
 *   script, or by an older bundle, carries none, and nobody is told.
 * - A browser that opted in keeps its push subscription, with its secret and
 *   the games it raised a board in, sealed to the job's box key at
 *   shmupX/champions/subs/<holder>. The job opens it, and sends only when the
 *   secret inside hashes to the holder the board names (a box filed under
 *   another browser's holder is refused), the box lists the game (the holder
 *   is public, so anyone can write it onto a board of their own), and the
 *   subscription is a known push service's.
 * - It sends once per game and day, and writes shmupX/champions/sent/<date>/
 *   <gameId> so a second run that day does not send again. A subscription
 *   the push service has forgotten (404, 410) is deleted.
 *
 * The database is open to anyone, so the board itself is no more trustworthy
 * than it ever was: whoever writes a higher value onto a game's board with
 * their own holder on it is told they won.
 */

import {
  b64url,
  fromB64url,
  open,
  verifyHolder,
} from "../../static/champion/box.js";
import {
  type PushSubscriptionJson,
  rawPublicKey,
  sendPush,
  type SendResult,
  type VapidKeys,
} from "./web-push.ts";

export const DEFAULT_DB = "https://evil-invaders-default-rtdb.firebaseio.com";
/** shmupX's own corner of the shared database (lib/rtdb-root.ts). */
export const CHAMPIONS = "shmupX/champions";
export const CONFIG_URL = new URL(
  "../../static/champion/config.json",
  import.meta.url,
);

/** What DAILY_CHAMPION_KEYS holds: both private JWKs and the VAPID subject. */
export interface ChampionKeys {
  vapid: VapidKeys;
  box: { privateJwk: JsonWebKey };
}

/** The public halves pages read (static/champion/config.json). */
export interface ChampionConfig {
  v: 1;
  vapidPublicKey: string;
  boxPublicKey: string;
  /** Hosts (and their subdomains) a page offers the opt-in on. */
  hosts: string[];
}

export const HOSTS = ["codemonkey.games"];

function privateP256(jwk: unknown, what: string): JsonWebKey {
  const k = jwk as JsonWebKey;
  if (
    !k || k.kty !== "EC" || k.crv !== "P-256" || !k.d || !k.x || !k.y
  ) {
    throw new Error(`DAILY_CHAMPION_KEYS: ${what} is not a private P-256 JWK`);
  }
  return { kty: "EC", crv: "P-256", d: k.d, x: k.x, y: k.y };
}

/** DAILY_CHAMPION_KEYS, checked: `{v, subject, vapid: jwk, box: jwk}`. */
export function parseKeys(text: string): ChampionKeys {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("DAILY_CHAMPION_KEYS is not JSON");
  }
  const subject = String(raw.subject ?? "");
  if (!/^(mailto:|https:\/\/)/.test(subject)) {
    throw new Error("DAILY_CHAMPION_KEYS: subject must be mailto: or https:");
  }
  return {
    vapid: { privateJwk: privateP256(raw.vapid, "vapid"), subject },
    box: { privateJwk: privateP256(raw.box, "box") },
  };
}

export function publicConfigFor(keys: ChampionKeys): ChampionConfig {
  return {
    v: 1,
    vapidPublicKey: b64url(rawPublicKey(keys.vapid.privateJwk)),
    boxPublicKey: b64url(rawPublicKey(keys.box.privateJwk)),
    hosts: HOSTS,
  };
}

/** The UTC date before `now`'s, as the boards key it (YYYY-MM-DD). */
export function previousUtcDay(now: number): string {
  return new Date(now - 24 * 3600 * 1000).toISOString().slice(0, 10);
}

const HOLDER = /^[A-Za-z0-9_-]{43}$/;
const GAME_ID = /^[a-z0-9-]+$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** A database key the REST API takes as it stands. */
const PLAIN_KEY = /^[^.$#[\]/\s]+$/;

/** What the browser sealed: its secret, its subscription, where it played. */
export interface SealedSubscription {
  v: 1;
  secret: string;
  subscription: PushSubscriptionJson;
  origin: string;
  games?: Record<string, { url?: string; name?: string }>;
}

export interface ChampionResult {
  gameId: string;
  status:
    | "no-record"
    | "no-holder"
    | "already-sent"
    | "not-subscribed"
    | "bad-box"
    | "not-played"
    | "unverified"
    | "would-send"
    | "sent"
    | "gone"
    | "rejected"
    | "failed";
  value?: number;
  holder?: string;
  detail?: string;
  notification?: Notification;
}

export interface Notification {
  title: string;
  body: string;
  url: string;
  tag: string;
  gameId: string;
  date: string;
  value: number;
}

export interface JobOptions {
  /** The UTC day to crown (YYYY-MM-DD); the one before `now` by default. */
  date?: string;
  /** Send, and record what was sent; otherwise only report. */
  send: boolean;
  keys: ChampionKeys | null;
  db?: string;
  fetch?: typeof fetch;
  now?: () => number;
  push?: typeof sendPush;
}

/** "Oct 30" for 2026-10-30. */
export function dayLabel(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** Where tapping the notification goes: the game's page on its own origin. */
export function championUrl(box: SealedSubscription, gameId: string): string {
  let origin: string;
  try {
    origin = new URL(box.origin).origin;
  } catch {
    return "";
  }
  const url = box.games?.[gameId]?.url;
  if (url) {
    try {
      const u = new URL(url, origin);
      if (u.origin === origin) return u.href;
    } catch {
      // fall through to the origin
    }
  }
  return `${origin}/`;
}

/** The notification a champion gets. */
export function championNotification(
  gameId: string,
  date: string,
  value: number,
  game: string,
  url: string,
): Notification {
  return {
    title: "🏆 You're the daily world champion!",
    body: `Your ${value.toLocaleString("en-US")} in ${game} was the world's ` +
      `best score on ${dayLabel(date)} (UTC).`,
    url,
    tag: `champion-${gameId}-${date}`,
    gameId,
    date,
    value,
  };
}

/** The push services browsers subscribe through; no other endpoint is sent to. */
export const PUSH_HOSTS = [
  "fcm.googleapis.com", // Chrome, Edge on Android, Opera, Samsung Internet
  "push.services.mozilla.com", // Firefox
  "push.apple.com", // Safari
  "notify.windows.com", // Edge on Windows
];

/** Why a sealed subscription cannot be pushed to, or null when it can. */
export function subscriptionProblem(sub: unknown): string | null {
  const s = sub as PushSubscriptionJson | undefined;
  let host: string;
  try {
    const u = new URL(String(s?.endpoint));
    if (u.protocol !== "https:") return "endpoint is not https";
    host = u.hostname;
  } catch {
    return "no push endpoint";
  }
  if (!PUSH_HOSTS.some((h) => host === h || host.endsWith("." + h))) {
    return `${host} is not a known push service`;
  }
  try {
    const p256dh = fromB64url(String(s?.keys?.p256dh));
    const auth = fromB64url(String(s?.keys?.auth));
    if (p256dh.length !== 65 || p256dh[0] !== 4) return "bad p256dh";
    if (auth.length !== 16) return "bad auth";
  } catch {
    return "bad keys";
  }
  return null;
}

/**
 * A game's name as a notification may say it: a string, without control or
 * direction-override characters, at most 40 characters.
 */
export function displayName(name: unknown): string {
  if (typeof name !== "string") return "";
  // line breaks become spaces; other controls and direction marks go
  const clean = name.replace(/\s+/g, " ").replace(
    // deno-lint-ignore no-control-regex
    /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g,
    "",
  ).trim();
  return clean.length > 40 ? clean.slice(0, 39) + "…" : clean;
}

const message = (e: unknown) => e instanceof Error ? e.message : String(e);

/**
 * Crown each game's champion of `date` and tell them.
 *
 * Only a game the champion's own page sealed into its box is told: the page
 * adds a game when the bundle says this browser raised its board. The holder
 * is public, so without that anyone could file boards under it for games the
 * player never touched. A game's trouble (a read that failed, a push turned
 * away) is that game's result; the run carries on with the rest.
 */
export async function runDailyChampion(
  options: JobOptions,
): Promise<{ date: string; results: ChampionResult[] }> {
  const db = (options.db ?? DEFAULT_DB).replace(/\/+$/, "");
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const push = options.push ?? sendPush;
  const date = options.date ?? previousUtcDay(now());
  if (!DATE.test(date)) throw new Error(`not a date: ${date}`);
  if (options.send && !options.keys) {
    throw new Error("sending needs DAILY_CHAMPION_KEYS");
  }
  // A day still being played has no champion yet, and a send would mark it
  // done before tonight's run could crown whoever leads at midnight.
  if (options.send && date > previousUtcDay(now())) {
    throw new Error(`${date} (UTC) has not ended yet`);
  }

  const url = (path: string, query = "") => `${db}/${path}.json${query}`;
  const get = async (path: string, query = "") => {
    const res = await doFetch(url(path, query), {
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      await res.body?.cancel();
      throw new Error(`GET ${path}: HTTP ${res.status}`);
    }
    return await res.json();
  };
  const write = async (
    method: "PUT" | "DELETE",
    path: string,
    body?: unknown,
  ) => {
    const res = await doFetch(url(path, "?print=silent"), {
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    await res.body?.cancel();
    if (!res.ok) throw new Error(`${method} ${path}: HTTP ${res.status}`);
  };

  const ids = Object.keys(
    (await get("leaderboards", "?shallow=true")) ?? {},
  ).filter((id) => GAME_ID.test(id)).sort();
  const results: ChampionResult[] = [];
  for (const gameId of ids) {
    try {
      results.push(await crown(gameId));
    } catch (e) {
      results.push({ gameId, status: "failed", detail: message(e) });
    }
  }
  return { date, results };

  async function crown(gameId: string): Promise<ChampionResult> {
    const board = await get(`leaderboards/${gameId}/daily/${date}`);
    const value = Math.floor(Number(board?.value));
    if (!board || !(value > 0)) return { gameId, status: "no-record" };
    const holder = typeof board.holder === "string" ? board.holder : "";
    if (!HOLDER.test(holder)) return { gameId, status: "no-holder", value };
    const base = { gameId, value, holder };
    const sentPath = `${CHAMPIONS}/sent/${date}/${gameId}`;
    if (await get(sentPath)) return { ...base, status: "already-sent" };
    const record = await get(`${CHAMPIONS}/subs/${holder}`);
    if (!record?.box) return { ...base, status: "not-subscribed" };
    if (!options.keys) return { ...base, status: "unverified" };

    let box: SealedSubscription;
    try {
      box = JSON.parse(await open(options.keys.box.privateJwk, record.box));
      if (!(await verifyHolder(holder, box?.secret))) {
        throw new Error("sealed by another browser");
      }
      const problem = subscriptionProblem(box.subscription);
      if (problem) throw new Error(problem);
    } catch (e) {
      return { ...base, status: "bad-box", detail: message(e) };
    }
    const played = box.games && typeof box.games === "object" &&
        Object.hasOwn(box.games, gameId)
      ? box.games[gameId]
      : null;
    if (!played) return { ...base, status: "not-played" };

    // The name the champion's page sealed (the game's key), and the title
    // its record gives it when it has one.
    const name = displayName(played.name);
    const title = name && PLAIN_KEY.test(name)
      ? displayName(
        await get(`shmupX/levels/${encodeURIComponent(name)}/title`).catch(
          () => null,
        ),
      )
      : "";
    const notification = championNotification(
      gameId,
      date,
      value,
      title || name || gameId,
      championUrl(box, gameId),
    );
    if (!options.send) return { ...base, status: "would-send", notification };

    let sent: SendResult;
    try {
      sent = await push(box.subscription, notification, options.keys.vapid, {
        fetch: doFetch,
        now: now(),
      });
    } catch (e) {
      // the network or a timeout: the next run of the day tries again
      return { ...base, status: "failed", detail: message(e), notification };
    }
    const status: ChampionResult["status"] = sent.ok
      ? "sent"
      : sent.gone
      ? "gone"
      : sent.status === 429 || sent.status >= 500
      ? "failed"
      : "rejected";
    const notes: string[] = sent.ok ? [] : [`HTTP ${sent.status} ${sent.text}`];
    try {
      if (sent.gone) await write("DELETE", `${CHAMPIONS}/subs/${holder}`);
      if (status !== "failed") {
        await write("PUT", sentPath, {
          holder,
          value,
          status: sent.status,
          at: { ".sv": "timestamp" },
        });
      }
    } catch (e) {
      notes.push(`not recorded: ${message(e)}`);
    }
    return {
      ...base,
      status,
      detail: notes.length ? notes.join("; ") : undefined,
      notification,
    };
  }
}
