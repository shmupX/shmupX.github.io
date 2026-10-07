// What the packaged app leaves out of its binary, and how it does without.
//
// The binary embeds _fresh/client — Vite's copy of static/ — whole (embedArgs
// in packages/shmup-harbor/scripts/build-desktop.ts), so everything under
// static/ ships in it unless build-desktop excludes it. These it excludes.
//
// Fresh's production staticFiles() serves from the build snapshot's file list,
// and that list still names an excluded file: opening it throws and the request
// 500s. So main.ts answers these paths ahead of staticFiles(), and only in a
// packaged app — a checkout and the deploy serve them from static/ as before.

/** Where a packaged app streams what it does not carry: the deploy. */
export const STREAM_ORIGIN = "https://codemonkey.games";

/**
 * An arcade romset: /games/<id>/<romset>.zip, the shape every arcade row's
 * romUrl in data/eshop.json takes (tests/eshop_catalog_test.ts pins each one).
 * The dashboard fetches the romset at every launch, so a packaged app proxies
 * it from STREAM_ORIGIN; offline, the launch says it could not reach the board.
 */
export const ROMSET_PATH =
  /^\/games\/[a-z0-9][a-z0-9-]*\/[A-Za-z0-9_.-]+\.zip$/;

/**
 * Paths a packaged app leaves out and answers 404 for. A trailing slash means
 * everything under it.
 *
 * - 2028-ai's custom BGM: 41 MB, one track that four bosses share. Without its
 *   manifest.json the level loader streams each track from the level's own
 *   source URL, and plays the stock sound if that fails
 *   (static/phaser-plugins/level-loader.js, _queueAudioOverrides).
 * - Super Mario SP's eShop archive: its row left the catalogue, and a stale copy
 *   in a checkout would otherwise still ride along.
 */
export const LEFT_OUT: readonly string[] = [
  "/games/2028-ai/assets/custom-bgm/",
  "/games/super-mario-sp-web.zip",
];

export function isLeftOut(pathname: string): boolean {
  return LEFT_OUT.some((p) =>
    p.endsWith("/") ? pathname.startsWith(p) : pathname === p
  );
}

/** The romUrls a packaged app streams: every arcade row's that has the romset shape. */
export function streamedRomsets(
  eshop: ReadonlyArray<{ kind?: unknown; romUrl?: unknown }>,
): string[] {
  return eshop.flatMap((e) =>
    e.kind === "arcade" && typeof e.romUrl === "string" &&
      ROMSET_PATH.test(e.romUrl)
      ? [e.romUrl]
      : []
  );
}

// What the proxy passes back. Range rides through both ways so a probe for one
// byte (static/eshop-library.js) stays one byte when the deploy honours it.
const PASSED_HEADERS = [
  "content-type",
  "content-length",
  "content-range",
  "accept-ranges",
  "etag",
  "last-modified",
];

/** Answer `req` for `pathname` with the deploy's copy, or a 502 saying why not. */
export async function streamFromDeploy(
  req: Request,
  pathname: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const headers = new Headers();
  const range = req.headers.get("range");
  if (range) headers.set("range", range);
  let upstream: Response;
  try {
    upstream = await fetchImpl(STREAM_ORIGIN + pathname, {
      method: req.method,
      headers,
    });
  } catch (err) {
    return new Response(
      `could not reach ${STREAM_ORIGIN}: ${(err as Error).message}`,
      { status: 502, headers: { "content-type": "text/plain" } },
    );
  }
  const out = new Headers();
  for (const k of PASSED_HEADERS) {
    const v = upstream.headers.get(k);
    if (v) out.set(k, v);
  }
  if (req.method === "HEAD") await upstream.body?.cancel();
  return new Response(req.method === "HEAD" ? null : upstream.body, {
    status: upstream.status,
    headers: out,
  });
}
