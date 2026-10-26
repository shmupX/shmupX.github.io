#!/usr/bin/env -S deno run -A
// scripts/asc-review.ts — the REVIEW step of .github/workflows/ios-publish.yml:
// once Apple has processed the build the run just uploaded, put the game's
// store listing on its App Store version and submit it for review.
//
//   deno run -A scripts/asc-review.ts --level foo \
//       --bundle-id com.easierbycode.game2028 --build-number 20261026.1430.213
//
// With ASC_KEY_ID, ASC_ISSUER_ID and ASC_API_KEY (the .p8's text) in the
// environment — the App Store Connect API key the upload step already uses.
//
// What it does, in App Store Connect API terms:
//   1. the app, by bundle id;
//   2. the build, by its number — polled until processingState is VALID
//      (Apple takes ten minutes, sometimes forty; --wait-minutes caps it);
//   3. an App Store version to put it on: the one still editable (PREPARE_FOR_
//      SUBMISSION, or rejected), else a new one at the build's marketing
//      version;
//   4. the listing: the description from the game's store listing — what the
//      PUBLISH panel's STORE LISTING wrote to shmupX/storeListings/<level> —
//      on the version's en-US localization, and the panel's App Store stills
//      as the screenshots of any display size that has none yet;
//   5. the build attached to the version, and a review submission created,
//      the version added to it, and submitted.
//
// Every refusal is an ::error annotation with a title, so the editor's run
// row says what Apple said; success is a ::notice. Nothing here is undone on
// failure — a half-filled version is the state to look at in App Store
// Connect, and the next publish picks it up as the editable one.

import { parseArgs } from "@std/cli/parse-args";
import { decodeBase64, encodeBase64Url } from "@std/encoding";

const API = "https://api.appstoreconnect.apple.com/v1";
const DB = "https://evil-invaders-default-rtdb.firebaseio.com";

const args = parseArgs(Deno.args, {
  string: ["level", "bundle-id", "build-number", "listing-url", "locale"],
  default: { "wait-minutes": 60, locale: "en-US" },
});

function fail(title: string, message: string): never {
  console.error(`::error title=${title}::${message}`);
  Deno.exit(1);
}

const level = String(args.level ?? "").trim();
const bundleId = String(args["bundle-id"] ?? "").trim();
const buildNumber = String(args["build-number"] ?? "").trim();
const waitMinutes = Number(args["wait-minutes"]) || 60;
const locale = String(args.locale);
if (!level || !bundleId || !buildNumber) {
  fail("Review", "--level, --bundle-id and --build-number are all needed.");
}
const keyId = (Deno.env.get("ASC_KEY_ID") ?? "").trim();
const issuerId = (Deno.env.get("ASC_ISSUER_ID") ?? "").trim();
const keyPem = (Deno.env.get("ASC_API_KEY") ?? "").trim();
if (!keyId || !issuerId || !keyPem) {
  fail(
    "Review",
    "ASC_KEY_ID, ASC_ISSUER_ID and ASC_API_KEY are not all set, so nothing can talk to App Store Connect.",
  );
}

// ── The token: an ES256 JWT, twenty minutes at most ─────────────────────────

async function importKey(pem: string): Promise<CryptoKey> {
  const b64 = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  return await crypto.subtle.importKey(
    "pkcs8",
    decodeBase64(b64),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
}

let cachedToken: { value: string; until: number } | null = null;
async function token(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.until > now + 60) return cachedToken.value;
  const key = await importKey(keyPem);
  const enc = (o: unknown) =>
    encodeBase64Url(new TextEncoder().encode(JSON.stringify(o)));
  const head = enc({ alg: "ES256", kid: keyId, typ: "JWT" });
  const body = enc({
    iss: issuerId,
    iat: now,
    exp: now + 15 * 60,
    aud: "appstoreconnect-v1",
  });
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new TextEncoder().encode(`${head}.${body}`),
  );
  const value = `${head}.${body}.${encodeBase64Url(new Uint8Array(sig))}`;
  cachedToken = { value, until: now + 15 * 60 };
  return value;
}

// ── The client ──────────────────────────────────────────────────────────────

interface Resource {
  type: string;
  id: string;
  attributes?: Record<string, unknown>;
  relationships?: Record<
    string,
    { data?: { type: string; id: string } | null }
  >;
}

async function asc(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ data: Resource[] | Resource | null; included?: Resource[] }> {
  const res = await fetch(path.startsWith("http") ? path : `${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${await token()}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return { data: null };
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const errors = Array.isArray(json?.errors) ? json.errors : [];
    const said = errors.map((e: { title?: string; detail?: string }) =>
      [e.title, e.detail].filter(Boolean).join(": ")
    ).join(" · ");
    throw new Error(
      `${method} ${path} → ${res.status}${said ? ` ${said}` : ""}`,
    );
  }
  return json;
}

const one = (r: { data: Resource[] | Resource | null }): Resource | null =>
  Array.isArray(r.data) ? r.data[0] ?? null : r.data;
const many = (r: { data: Resource[] | Resource | null }): Resource[] =>
  Array.isArray(r.data) ? r.data : r.data ? [r.data] : [];
const attr = (r: Resource | null, k: string): string =>
  String(r?.attributes?.[k] ?? "");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── MD5, for the screenshot upload's checksum ───────────────────────────────
// WebCrypto has no MD5 and the upload API asks for one; the algorithm is
// forty lines, so it is here rather than a dependency.

function md5Hex(input: Uint8Array): string {
  const K = new Uint32Array(64);
  for (let i = 0; i < 64; i++) {
    K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32);
  }
  const S = [
    7,
    12,
    17,
    22,
    7,
    12,
    17,
    22,
    7,
    12,
    17,
    22,
    7,
    12,
    17,
    22,
    5,
    9,
    14,
    20,
    5,
    9,
    14,
    20,
    5,
    9,
    14,
    20,
    5,
    9,
    14,
    20,
    4,
    11,
    16,
    23,
    4,
    11,
    16,
    23,
    4,
    11,
    16,
    23,
    4,
    11,
    16,
    23,
    6,
    10,
    15,
    21,
    6,
    10,
    15,
    21,
    6,
    10,
    15,
    21,
    6,
    10,
    15,
    21,
  ];
  const len = input.length;
  const padded = new Uint8Array(((len + 8) >> 6 << 6) + 64);
  padded.set(input);
  padded[len] = 0x80;
  const bits = BigInt(len) * 8n;
  new DataView(padded.buffer).setBigUint64(padded.length - 8, bits, true);
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  const M = new Uint32Array(16);
  const view = new DataView(padded.buffer);
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) M[i] = view.getUint32(off + i * 4, true);
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F: number, g: number;
      if (i < 16) {
        F = (B & C) | (~B & D);
        g = i;
      } else if (i < 32) {
        F = (D & B) | (~D & C);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        F = B ^ C ^ D;
        g = (3 * i + 5) % 16;
      } else {
        F = C ^ (B | ~D);
        g = (7 * i) % 16;
      }
      const t = (A + F + K[i] + M[g]) >>> 0;
      A = D;
      D = C;
      C = B;
      B = (B + ((t << S[i]) | (t >>> (32 - S[i])))) >>> 0;
    }
    a0 = (a0 + A) >>> 0;
    b0 = (b0 + B) >>> 0;
    c0 = (c0 + C) >>> 0;
    d0 = (d0 + D) >>> 0;
  }
  const out = new Uint8Array(16);
  new DataView(out.buffer).setUint32(0, a0, true);
  new DataView(out.buffer).setUint32(4, b0, true);
  new DataView(out.buffer).setUint32(8, c0, true);
  new DataView(out.buffer).setUint32(12, d0, true);
  return Array.from(out).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ── The listing the panel wrote ─────────────────────────────────────────────

interface Listing {
  title?: string;
  description?: string;
  shots?: Record<string, Record<string, string>>;
}

async function readListing(): Promise<Listing> {
  const url = String(args["listing-url"] ?? "").trim() ||
    `${DB}/shmupX/storeListings/${encodeURIComponent(level)}.json`;
  try {
    const res = await fetch(url);
    if (!res.ok) return {};
    const json = await res.json();
    return json && typeof json === "object" ? json as Listing : {};
  } catch {
    return {};
  }
}

/** App Store Connect's display type for each still the panel cut. */
const DISPLAY_TYPES: Record<string, string> = {
  "iphone-67": "APP_IPHONE_67",
  "iphone-65": "APP_IPHONE_65",
};

function dataUrlBytes(dataUrl: string): Uint8Array | null {
  const m = /^data:image\/png;base64,(.+)$/.exec(dataUrl);
  return m ? decodeBase64(m[1]) : null;
}

// ── The steps ───────────────────────────────────────────────────────────────

async function main() {
  console.log(`App Store Connect: ${bundleId}, build ${buildNumber}`);

  // 1. The app.
  const app = one(
    await asc("GET", `/apps?filter[bundleId]=${encodeURIComponent(bundleId)}`),
  );
  if (!app) {
    fail(
      "Review",
      `App Store Connect has no app record for ${bundleId}. Make one (My Apps → +) and publish again.`,
    );
  }
  console.log(`  app ${app.id} — ${attr(app, "name")}`);

  // 2. The build, processed.
  const deadline = Date.now() + waitMinutes * 60_000;
  let build: Resource | null = null;
  let marketing = "";
  for (;;) {
    const res = await asc(
      "GET",
      `/builds?filter[app]=${app.id}&filter[version]=${
        encodeURIComponent(buildNumber)
      }&include=preReleaseVersion&sort=-uploadedDate&limit=1`,
    );
    build = one(res);
    const state = attr(build, "processingState");
    if (build && state === "VALID") {
      const pre = (res.included ?? []).find((r) =>
        r.type === "preReleaseVersions"
      );
      marketing = attr(pre ?? null, "version");
      break;
    }
    if (build && (state === "FAILED" || state === "INVALID")) {
      fail(
        "Review",
        `Apple rejected build ${buildNumber} while processing it (${state}). App Store Connect's email says why.`,
      );
    }
    if (Date.now() > deadline) {
      fail(
        "Review",
        build
          ? `Build ${buildNumber} was still ${state} after ${waitMinutes} minutes. Publish again with REVIEW once it shows as ready in App Store Connect.`
          : `Build ${buildNumber} did not appear in App Store Connect within ${waitMinutes} minutes of the upload.`,
      );
    }
    console.log(
      `  build ${buildNumber}: ${build ? state : "not listed yet"} — waiting…`,
    );
    await sleep(60_000);
  }
  console.log(
    `  build ${build!.id} is processed (version ${marketing || "?"})`,
  );

  // 3. The version to put it on.
  const EDITABLE = new Set([
    "PREPARE_FOR_SUBMISSION",
    "DEVELOPER_REJECTED",
    "REJECTED",
    "METADATA_REJECTED",
    "INVALID_BINARY",
    "READY_FOR_REVIEW",
  ]);
  const BUSY = new Set([
    "WAITING_FOR_REVIEW",
    "IN_REVIEW",
    "PENDING_DEVELOPER_RELEASE",
    "PENDING_APPLE_RELEASE",
    "PROCESSING_FOR_DISTRIBUTION",
  ]);
  const versions = many(
    await asc(
      "GET",
      `/apps/${app.id}/appStoreVersions?filter[platform]=IOS&limit=20`,
    ),
  );
  const stateOf = (v: Resource) =>
    attr(v, "appVersionState") || attr(v, "appStoreState");
  let version = versions.find((v) => EDITABLE.has(stateOf(v))) ?? null;
  const busy = versions.find((v) => BUSY.has(stateOf(v)));
  if (!version && busy) {
    fail(
      "Review",
      `Version ${attr(busy, "versionString")} is ${
        stateOf(busy)
      } in App Store Connect; there is nothing to add a build to until Apple is done with it.`,
    );
  }
  const versionString = marketing || attr(version, "versionString") || "1.0";
  if (!version) {
    version = one(
      await asc("POST", "/appStoreVersions", {
        data: {
          type: "appStoreVersions",
          attributes: { platform: "IOS", versionString },
          relationships: { app: { data: { type: "apps", id: app.id } } },
        },
      }),
    );
    console.log(`  made App Store version ${versionString} (${version!.id})`);
  } else if (marketing && attr(version, "versionString") !== marketing) {
    await asc("PATCH", `/appStoreVersions/${version.id}`, {
      data: {
        type: "appStoreVersions",
        id: version.id,
        attributes: { versionString: marketing },
      },
    });
    console.log(`  version ${version.id} renumbered to ${marketing}`);
  } else {
    console.log(
      `  App Store version ${
        attr(version, "versionString")
      } (${version.id}) is ${stateOf(version)}`,
    );
  }

  // 4. The listing.
  const listing = await readListing();
  const description = String(listing.description ?? "").trim();
  const locs = many(
    await asc(
      "GET",
      `/appStoreVersions/${version!.id}/appStoreVersionLocalizations`,
    ),
  );
  let loc: Resource | null = locs.find((l) => attr(l, "locale") === locale) ??
    locs[0] ?? null;
  if (!loc) {
    loc = one(
      await asc("POST", "/appStoreVersionLocalizations", {
        data: {
          type: "appStoreVersionLocalizations",
          attributes: {
            locale,
            ...(description ? { description, whatsNew: description } : {}),
          },
          relationships: {
            appStoreVersion: {
              data: { type: "appStoreVersions", id: version!.id },
            },
          },
        },
      }),
    );
    console.log(`  made the ${locale} listing`);
  } else {
    const attributes: Record<string, string> = {};
    if (description) attributes.description = description;
    // Apple wants "what's new" on every version after the first.
    if (description && !attr(loc, "whatsNew")) {
      attributes.whatsNew = description;
    }
    if (Object.keys(attributes).length) {
      await asc("PATCH", `/appStoreVersionLocalizations/${loc.id}`, {
        data: { type: "appStoreVersionLocalizations", id: loc.id, attributes },
      });
      console.log(`  description set on the ${attr(loc, "locale")} listing`);
    } else {
      console.log(
        "  no description in the store listing; the one on the version stays",
      );
    }
  }

  // The stills, where a display size has no screenshots yet.
  const shots = listing.shots?.ios ?? {};
  let uploaded = 0;
  if (Object.keys(shots).length) {
    const sets = many(
      await asc(
        "GET",
        `/appStoreVersionLocalizations/${
          loc!.id
        }/appScreenshotSets?include=appScreenshots`,
      ),
    );
    for (const [key, dataUrl] of Object.entries(shots)) {
      const displayType = DISPLAY_TYPES[key];
      const bytes = displayType ? dataUrlBytes(dataUrl) : null;
      if (!displayType || !bytes) continue;
      let set = sets.find((s) =>
        attr(s, "screenshotDisplayType") === displayType
      ) ??
        null;
      if (set) {
        const has = (set.relationships?.appScreenshots as { data?: unknown[] })
          ?.data;
        if (Array.isArray(has) && has.length) {
          console.log(
            `  ${displayType}: has screenshots already, left as they are`,
          );
          continue;
        }
      } else {
        set = one(
          await asc("POST", "/appScreenshotSets", {
            data: {
              type: "appScreenshotSets",
              attributes: { screenshotDisplayType: displayType },
              relationships: {
                appStoreVersionLocalization: {
                  data: { type: "appStoreVersionLocalizations", id: loc!.id },
                },
              },
            },
          }),
        );
      }
      const fileName = `${level}-${key}.png`;
      const reserved = one(
        await asc("POST", "/appScreenshots", {
          data: {
            type: "appScreenshots",
            attributes: { fileName, fileSize: bytes.length },
            relationships: {
              appScreenshotSet: {
                data: { type: "appScreenshotSets", id: set!.id },
              },
            },
          },
        }),
      );
      const ops = (reserved?.attributes?.uploadOperations ?? []) as {
        method: string;
        url: string;
        length: number;
        offset: number;
        requestHeaders: { name: string; value: string }[];
      }[];
      for (const op of ops) {
        const headers: Record<string, string> = {};
        for (const h of op.requestHeaders ?? []) headers[h.name] = h.value;
        const part = bytes.slice(op.offset, op.offset + op.length);
        const res = await fetch(op.url, {
          method: op.method,
          headers,
          body: part,
        });
        if (!res.ok) {
          throw new Error(`screenshot part upload → ${res.status}`);
        }
        await res.body?.cancel();
      }
      await asc("PATCH", `/appScreenshots/${reserved!.id}`, {
        data: {
          type: "appScreenshots",
          id: reserved!.id,
          attributes: { uploaded: true, sourceFileChecksum: md5Hex(bytes) },
        },
      });
      uploaded++;
      console.log(`  ${displayType}: uploaded ${fileName}`);
    }
  }

  // 5. The build on the version, and the submission.
  await asc("PATCH", `/appStoreVersions/${version!.id}/relationships/build`, {
    data: { type: "builds", id: build!.id },
  });
  console.log(`  build ${buildNumber} attached to version ${versionString}`);

  const submissions = many(
    await asc(
      "GET",
      `/reviewSubmissions?filter[app]=${app.id}&filter[platform]=IOS&filter[state]=READY_FOR_REVIEW,WAITING_FOR_REVIEW,IN_REVIEW,UNRESOLVED_ISSUES&include=items`,
    ),
  );
  const inFlight = submissions.find((s) =>
    ["WAITING_FOR_REVIEW", "IN_REVIEW"].includes(attr(s, "state"))
  );
  if (inFlight) {
    fail(
      "Review",
      `A submission is already ${
        attr(inFlight, "state")
      } with Apple; this build is on version ${versionString}, ready for the next one.`,
    );
  }
  let submission =
    submissions.find((s) => attr(s, "state") === "READY_FOR_REVIEW") ??
      null;
  if (!submission) {
    submission = one(
      await asc("POST", "/reviewSubmissions", {
        data: {
          type: "reviewSubmissions",
          attributes: { platform: "IOS" },
          relationships: { app: { data: { type: "apps", id: app.id } } },
        },
      }),
    );
  }
  const items = many(
    await asc("GET", `/reviewSubmissions/${submission!.id}/items`),
  );
  const already = items.some((i) =>
    i.relationships?.appStoreVersion?.data?.id === version!.id
  );
  if (!already) {
    await asc("POST", "/reviewSubmissionItems", {
      data: {
        type: "reviewSubmissionItems",
        relationships: {
          reviewSubmission: {
            data: { type: "reviewSubmissions", id: submission!.id },
          },
          appStoreVersion: {
            data: { type: "appStoreVersions", id: version!.id },
          },
        },
      },
    });
  }
  await asc("PATCH", `/reviewSubmissions/${submission!.id}`, {
    data: {
      type: "reviewSubmissions",
      id: submission!.id,
      attributes: { submitted: true },
    },
  });
  console.log(
    `::notice title=Review::Submitted ${versionString} (build ${buildNumber}) for App Store review` +
      (uploaded
        ? ` with ${uploaded} new screenshot${uploaded === 1 ? "" : "s"}`
        : "") +
      ".",
  );
}

try {
  await main();
} catch (e) {
  const msg = (e as Error).message;
  if (/PATCH .*relationships\/build/.test(msg)) {
    fail(
      "Review",
      `App Store Connect would not attach the build: ${msg}. Attach it to the version by hand and submit from there.`,
    );
  }
  if (/reviewSubmissions/.test(msg)) {
    fail(
      "Review",
      `App Store Connect refused the submission: ${msg}. The listing is on the version; look at it in App Store Connect — a missing age rating, privacy answer or screenshot size is the usual reason.`,
    );
  }
  fail("Review", msg);
}
