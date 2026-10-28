// How much of the project's API credit one player — and everybody — may spend
// through the assistant.
//
// Nobody signs in to the editor, so a "player" is a client address, and the
// limits are modest on purpose: a few requests an hour is a player building a
// boss, a few hundred a day is the whole site. Publishing a proposal costs no
// credits (it is a database write) but is a write to a shared catalog, so it
// has a bucket of its own.
//
// The counters live in Deno KV where there is one — a hosted deployment runs
// in several isolates, and a limit kept in one isolate's memory is a limit
// each isolate enforces separately — and in a Map otherwise. The fallback is
// per process, which is exactly right for a desktop install (one process,
// one player) and merely generous for a deployment without KV: the bucket is
// still bounded, by the number of isolates rather than by one.

export interface Limits {
  /** Requests one client may make in an hour. */
  asksPerHour: number;
  /** Requests everybody together may make in a UTC day. */
  asksPerDay: number;
  /** Publishes one client may make in an hour. */
  publishesPerHour: number;
}

export const DEFAULT_LIMITS: Limits = {
  asksPerHour: 8,
  asksPerDay: 200,
  publishesPerHour: 20,
};

const HOUR = 3_600_000;
const DAY = 86_400_000;

/** A positive integer from the environment, else the default. */
function intFrom(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export function limitsFromEnv(
  get: (key: string) => string | undefined,
): Limits {
  return {
    asksPerHour: intFrom(
      get("ASSISTANT_ASKS_PER_HOUR"),
      DEFAULT_LIMITS.asksPerHour,
    ),
    asksPerDay: intFrom(
      get("ASSISTANT_ASKS_PER_DAY"),
      DEFAULT_LIMITS.asksPerDay,
    ),
    publishesPerHour: intFrom(
      get("ASSISTANT_PUBLISHES_PER_HOUR"),
      DEFAULT_LIMITS.publishesPerHour,
    ),
  };
}

/** ─── counters ─────────────────────────────────────────────────────────── */

export interface Counter {
  /** Add one to a key that lives for `ttlMs`, and answer the count after. */
  bump(key: string, ttlMs: number): Promise<number>;
  /** The count without adding to it. */
  peek(key: string): Promise<number>;
}

export class MemoryCounter implements Counter {
  #counts = new Map<string, { n: number; until: number }>();
  constructor(private readonly now: () => number = Date.now) {}

  #sweep(): void {
    const t = this.now();
    for (const [key, entry] of this.#counts) {
      if (entry.until <= t) this.#counts.delete(key);
    }
  }

  bump(key: string, ttlMs: number): Promise<number> {
    this.#sweep();
    const entry = this.#counts.get(key);
    if (entry) {
      entry.n++;
      return Promise.resolve(entry.n);
    }
    this.#counts.set(key, { n: 1, until: this.now() + ttlMs });
    return Promise.resolve(1);
  }

  peek(key: string): Promise<number> {
    this.#sweep();
    return Promise.resolve(this.#counts.get(key)?.n ?? 0);
  }
}

const KV_PREFIX = "shmupx-assistant";

/**
 * The slice of Deno.Kv this uses, spelled out because Deno.Kv's types are
 * behind the unstable lib this project does not compile with. The runtime
 * object is the real one when there is one.
 */
export interface KvLike {
  get<T>(
    key: (string | number)[],
  ): Promise<{ value: T | null; versionstamp: string | null }>;
  set(
    key: (string | number)[],
    value: unknown,
    options?: { expireIn?: number },
  ): Promise<unknown>;
  atomic(): {
    check(
      entry: { key: (string | number)[]; versionstamp: string | null },
    ): KvAtomic;
  };
}

interface KvAtomic {
  set(
    key: (string | number)[],
    value: unknown,
    options?: { expireIn?: number },
  ): KvAtomic;
  commit(): Promise<{ ok: boolean }>;
}

export class KvCounter implements Counter {
  constructor(private readonly kv: KvLike) {}

  async bump(key: string, ttlMs: number): Promise<number> {
    const k = [KV_PREFIX, key];
    // Check-and-set, a few times; two isolates bumping the same key at the
    // same instant is a rate limiter's normal weather, not an error.
    for (let attempt = 0; attempt < 4; attempt++) {
      const entry = await this.kv.get<number>(k);
      const n = (entry.value ?? 0) + 1;
      const res = await this.kv.atomic()
        .check({ key: k, versionstamp: entry.versionstamp })
        .set(k, n, { expireIn: ttlMs })
        .commit();
      if (res.ok) return n;
    }
    const entry = await this.kv.get<number>(k);
    const n = (entry.value ?? 0) + 1;
    await this.kv.set(k, n, { expireIn: ttlMs });
    return n;
  }

  async peek(key: string): Promise<number> {
    return (await this.kv.get<number>([KV_PREFIX, key])).value ?? 0;
  }
}

/**
 * KV when this runtime has it and will open it, memory otherwise. Opening
 * can fail for reasons that are not this module's to fix — no permission, a
 * runtime without KV, a path that cannot be created — and the assistant
 * should still answer, so every failure is the memory counter.
 */
export async function openCounter(): Promise<Counter> {
  const open = (Deno as { openKv?: () => Promise<KvLike> }).openKv;
  if (typeof open !== "function") return new MemoryCounter();
  try {
    return new KvCounter(await open.call(Deno));
  } catch {
    return new MemoryCounter();
  }
}

/** ─── admission ────────────────────────────────────────────────────────── */

export type Admission =
  | { ok: true }
  | { ok: false; reason: string; retryAfterSeconds: number };

const utcDay = (t: number) => new Date(t).toISOString().slice(0, 10);

/**
 * May this client make this kind of request now? The client's own bucket
 * is asked first, so a client over its limit never counts against the day;
 * the day's bucket is everybody's.
 */
export async function admit(
  counter: Counter,
  limits: Limits,
  kind: "ask" | "publish",
  client: string,
  now: number = Date.now(),
): Promise<Admission> {
  const hour = Math.floor(now / HOUR);
  const secondsLeftInHour = Math.ceil(((hour + 1) * HOUR - now) / 1000);
  if (kind === "publish") {
    const n = await counter.bump(`publish:${client}:${hour}`, HOUR);
    if (n > limits.publishesPerHour) {
      return {
        ok: false,
        reason:
          `That is ${limits.publishesPerHour} publishes in an hour from here — try again later.`,
        retryAfterSeconds: secondsLeftInHour,
      };
    }
    return { ok: true };
  }
  const mine = await counter.bump(`ask:${client}:${hour}`, HOUR);
  if (mine > limits.asksPerHour) {
    return {
      ok: false,
      reason:
        `That is ${limits.asksPerHour} requests in an hour from here — try again in a while.`,
      retryAfterSeconds: secondsLeftInHour,
    };
  }
  const day = utcDay(now);
  const everyone = await counter.bump(`ask:day:${day}`, DAY);
  if (everyone > limits.asksPerDay) {
    const midnight = Date.parse(`${day}T24:00:00Z`);
    return {
      ok: false,
      reason: "The assistant has done all it can today — it is back tomorrow.",
      retryAfterSeconds: Math.ceil((midnight - now) / 1000),
    };
  }
  return { ok: true };
}

/**
 * Who is asking: the first address in X-Forwarded-For when a proxy set it
 * (Deno Deploy does), else the connection's own, else "local" — a desktop
 * install's in-process server.fetch has no address at all.
 */
export function clientKey(
  headers: Headers,
  addr: Deno.Addr | undefined,
): string {
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0].trim();
  if (forwarded) return forwarded;
  if (addr && (addr.transport === "tcp" || addr.transport === "udp")) {
    return addr.hostname;
  }
  return "local";
}
