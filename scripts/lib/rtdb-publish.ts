// The transport every "publish a save library to the Realtime Database" script
// shares: digests, gzip, and a throttled, retrying, quiet PUT.
//
// Extracted when the Super Famicom library (scripts/upload-sfc-saves.ts) became
// the second publisher. The two differ in almost everything that matters — one
// stores a deinterleaved Saturn cart and the other a raw SRAM dump, they join
// against different metadata tables and render covers with different composers
// — but they push bytes into the same database under the same two constraints,
// and those are exactly the lines that must not drift:
//
//   print=silent   without it RTDB echoes every written value back, which for
//                  the Saturn library alone would burn tens of megabytes of the
//                  project's monthly download quota to no purpose.
//   the budget     RTDB documents a 64 MB/minute bytes-written cap, and a run
//                  that ignores it rides the ceiling and starts failing.
//
// A second copy of either would be found the hard way, once, in production.

/** RTDB's documented cap is 64 MB/min; publishers stay well under it. */
export const DEFAULT_WRITE_BUDGET_BYTES_PER_MIN = 36 * 1024 * 1024;

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream()
    .pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export interface PutOptions {
  /** Database origin, no trailing slash. */
  db: string;
  /** Bytes per minute this run may write. */
  budgetBytesPerMin?: number;
  /** Where the retry notices go; defaults to console.warn. */
  warn?: (message: string) => void;
}

/**
 * A `put(path, value)` that answers with the number of bytes it wrote.
 *
 * The rolling window belongs to the returned function, not to the module, so
 * two publishers in one process each keep their own budget rather than
 * silently halving one.
 */
export function makePut(
  {
    db,
    budgetBytesPerMin = DEFAULT_WRITE_BUDGET_BYTES_PER_MIN,
    warn = console.warn,
  }: PutOptions,
): (path: string, value: unknown) => Promise<number> {
  let window: { at: number; bytes: number }[] = [];

  async function throttle(nextBytes: number) {
    for (;;) {
      const cutoff = Date.now() - 60_000;
      window = window.filter((w) => w.at > cutoff);
      const inWindow = window.reduce((n, w) => n + w.bytes, 0);
      if (inWindow + nextBytes <= budgetBytesPerMin) return;
      const oldest = window[0];
      const waitMs = Math.max(250, oldest.at + 60_000 - Date.now());
      await new Promise((r) => setTimeout(r, Math.min(waitMs, 5_000)));
    }
  }

  return async function put(path: string, value: unknown): Promise<number> {
    const body = JSON.stringify(value);
    const bytes = new TextEncoder().encode(body).length;
    await throttle(bytes);
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        const res = await fetch(`${db}/${path}.json?print=silent`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body,
        });
        if (res.ok) {
          await res.body?.cancel();
          window.push({ at: Date.now(), bytes });
          return bytes;
        }
        const text = (await res.text()).slice(0, 300);
        if (attempt === 4) throw new Error(`HTTP ${res.status}: ${text}`);
        warn(`  ! ${path} HTTP ${res.status} — retry ${attempt}/3`);
      } catch (e) {
        if (attempt === 4) throw e;
        warn(`  ! ${path} ${(e as Error).message} — retry ${attempt}/3`);
      }
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
    return bytes;
  };
}

/**
 * Japanese genre names, mirroring DEZA_GENRE_JA in the editor. Covers all 15
 * genre values games-db.json uses; games-db-sfc.json draws from the same set,
 * so a Super Famicom row reads in Japanese exactly as a Saturn one does.
 */
export const GENRE_JA: Record<string, string> = {
  "Vertical Shoot-em-up": "縦スクロールシューティング",
  "Horizontal Shoot-em-up": "横スクロールシューティング",
  "Vertical Shoot-em-up / Danmaku": "縦スクロールシューティング／弾幕",
  "Horizontal Shoot-em-up / Danmaku": "横スクロールシューティング／弾幕",
  "Vertical Shoot-em-up / Story": "縦スクロールシューティング／ストーリー",
  "Horizontal Shoot-em-up / Story": "横スクロールシューティング／ストーリー",
  "Score Attack Vertical Shoot-em-up":
    "スコアアタック縦スクロールシューティング",
  "Score Attack Horizontal Shoot-em-up":
    "スコアアタック横スクロールシューティング",
  "Action - Shoot-em-up": "アクションシューティング",
  "Action - Racing": "アクションレーシング",
  "Action - Puzzle": "アクションパズル",
  "Action": "アクション",
  "Tool": "ツール",
  "Movie": "ムービー",
  "Avant-Garde Art": "前衛アート",
};
