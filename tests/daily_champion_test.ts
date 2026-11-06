// The daily world champion: whoever holds a game's TODAY'S BEST when the UTC
// day ends gets a push notification (lib/daily-champion/job.ts).
//
// Checked here: the Web Push sender against RFC 8291's own worked example and
// a decryptor written from the RFC, the VAPID JWT against the key it names,
// the sealed box the page writes into the open database, the midnight job
// against a database and a push service in memory (who is told, once, and
// who is refused), the service worker, and the pages that load the script.
// The bundle's half (the holder on today's board, the event) is in
// tests/game_scores_test.ts, run through the bundle's own submit path.

import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  encrypt,
  type PushSubscriptionJson,
  rawPublicKey,
  sendPush,
  vapidAuthorization,
} from "../lib/daily-champion/web-push.ts";
import {
  b64url,
  fromB64url,
  holderFor,
  newSecret,
  open,
  seal,
  verifyHolder,
} from "../static/champion/box.js";
import {
  type ChampionKeys,
  championNotification,
  CHAMPIONS,
  displayName,
  parseKeys,
  previousUtcDay,
  publicConfigFor,
  runDailyChampion,
  subscriptionProblem,
} from "../lib/daily-champion/job.ts";
import { standaloneGamePageHtml } from "../lib/game-page.ts";

const read = (p: string) =>
  Deno.readTextFile(new URL(`../${p}`, import.meta.url));
const enc = new TextEncoder();
const P256 = { name: "ECDH", namedCurve: "P-256" } as const;

// --- Web Push ---------------------------------------------------------------

Deno.test("encrypt reproduces RFC 8291's worked example byte for byte", async () => {
  // RFC 8291 Appendix A
  const asPub = fromB64url(
    "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  );
  const jwk = {
    kty: "EC",
    crv: "P-256",
    d: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
    x: b64url(asPub.slice(1, 33)),
    y: b64url(asPub.slice(33)),
  };
  const serverKeys = {
    privateKey: await crypto.subtle.importKey("jwk", jwk, P256, true, [
      "deriveBits",
    ]),
    publicKey: await crypto.subtle.importKey("raw", asPub, P256, true, []),
  };
  const body = await encrypt(
    {
      endpoint:
        "https://push.example.net/push/JzLQ3raZJfFBR0aqvOMsLrt54w4rJUsV",
      keys: {
        p256dh:
          "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
        auth: "BTBZMqHH6r4Tts7J_aSIgg",
      },
    },
    enc.encode("When I grow up, I want to be a watermelon"),
    { serverKeys, salt: fromB64url("DGv6ra1nlYgDCS1FRnbzlw") },
  );
  assertEquals(
    b64url(body),
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
  );
});

/** A browser's side: its key pair, its auth secret, its subscription. */
async function browser(endpoint = "https://fcm.googleapis.com/fcm/send/abc") {
  const keys = await crypto.subtle.generateKey(P256, true, ["deriveBits"]);
  const pub = new Uint8Array(
    await crypto.subtle.exportKey("raw", keys.publicKey),
  );
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const subscription: PushSubscriptionJson = {
    endpoint,
    keys: { p256dh: b64url(pub), auth: b64url(auth) },
  };
  return { keys, pub, auth, subscription };
}

async function hkdf(
  salt: Uint8Array<ArrayBuffer>,
  ikm: Uint8Array<ArrayBuffer>,
  info: string | Uint8Array<ArrayBuffer>,
  n: number,
) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, [
    "deriveBits",
  ]);
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt,
        info: typeof info === "string" ? enc.encode(info) : info,
      },
      key,
      n * 8,
    ),
  );
}

/** RFC 8291 section 3 from the user agent's end: what a browser does. */
async function decryptAsBrowser(
  b: Awaited<ReturnType<typeof browser>>,
  body: Uint8Array,
): Promise<string> {
  const salt = body.slice(0, 16);
  const rs = new DataView(body.buffer, body.byteOffset).getUint32(16);
  const idlen = body[20];
  const asPub = body.slice(21, 21 + idlen);
  const ct = body.slice(21 + idlen);
  assert(ct.length <= rs, "one record");
  const as = await crypto.subtle.importKey("raw", asPub, P256, false, []);
  const ecdh = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "ECDH", public: as },
      b.keys.privateKey,
      256,
    ),
  );
  const info = new Uint8Array([
    ...enc.encode("WebPush: info\0"),
    ...b.pub,
    ...asPub,
  ]);
  const ikm = await hkdf(b.auth, ecdh, info, 32);
  const cek = await hkdf(salt, ikm, "Content-Encoding: aes128gcm\0", 16);
  const nonce = await hkdf(salt, ikm, "Content-Encoding: nonce\0", 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, [
    "decrypt",
  ]);
  const plain = new Uint8Array(
    await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, ct),
  );
  let end = plain.length - 1;
  while (end >= 0 && plain[end] === 0) end--;
  assertEquals(plain[end], 2, "the last record ends in the 0x02 delimiter");
  return new TextDecoder().decode(plain.slice(0, end));
}

async function vapidKeys() {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  return {
    privateJwk: await crypto.subtle.exportKey("jwk", pair.privateKey),
    publicKey: pair.publicKey,
    subject: "https://codemonkey.games",
  };
}

Deno.test("a browser decrypts what encrypt sends it, with fresh keys every time", async () => {
  const b = await browser();
  const text = JSON.stringify({ title: "🏆", body: "x".repeat(300) });
  const one = await encrypt(b.subscription, enc.encode(text));
  const two = await encrypt(b.subscription, enc.encode(text));
  assertEquals(await decryptAsBrowser(b, one), text);
  assertEquals(await decryptAsBrowser(b, two), text);
  assert(b64url(one.slice(0, 16)) !== b64url(two.slice(0, 16)), "a fresh salt");
  await assertRejects(
    () =>
      encrypt({
        ...b.subscription,
        keys: { ...b.subscription.keys, auth: "AAAA" },
      }, enc.encode("x")),
    Error,
    "auth",
  );
});

Deno.test("the VAPID header is an ES256 JWT for the push service's origin, signed by the key it names", async () => {
  const v = await vapidKeys();
  const now = Date.UTC(2026, 9, 31, 0, 7);
  const header = await vapidAuthorization(
    "https://web.push.apple.com/QGuQyavXutnMH_A?x=1",
    v,
    now,
  );
  const m = header.match(/^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/);
  assert(m, header);
  const [, head, body, sig, k] = m;
  assertEquals(JSON.parse(new TextDecoder().decode(fromB64url(head))), {
    typ: "JWT",
    alg: "ES256",
  });
  const claims = JSON.parse(new TextDecoder().decode(fromB64url(body)));
  assertEquals(claims.aud, "https://web.push.apple.com");
  assertEquals(claims.sub, "https://codemonkey.games");
  assert(claims.exp > now / 1000 && claims.exp <= now / 1000 + 24 * 3600);
  assertEquals(k, b64url(rawPublicKey(v.privateJwk)));
  const pub = await crypto.subtle.importKey(
    "raw",
    fromB64url(k),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  assert(
    await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      pub,
      fromB64url(sig),
      enc.encode(`${head}.${body}`),
    ),
  );
});

Deno.test("sendPush posts the encrypted body with the headers a push service wants", async () => {
  const b = await browser(
    "https://updates.push.services.mozilla.com/wpush/v2/x",
  );
  const v = await vapidKeys();
  const seen: { url: string; init: RequestInit }[] = [];
  const res = await sendPush(b.subscription, { title: "hi" }, v, {
    fetch: ((url: string, init: RequestInit) => {
      seen.push({ url, init });
      return Promise.resolve(new Response("", { status: 201 }));
    }) as typeof fetch,
  });
  assertEquals(res, { status: 201, gone: false, ok: true, text: "" });
  const h = seen[0].init.headers as Record<string, string>;
  assertEquals(seen[0].url, b.subscription.endpoint);
  assertEquals(h["content-encoding"], "aes128gcm");
  assertEquals(h.ttl, "86400");
  assert(h.authorization.startsWith("vapid t="));
  assertEquals(
    await decryptAsBrowser(b, seen[0].init.body as Uint8Array),
    JSON.stringify({ title: "hi" }),
  );
  for (const status of [404, 410]) {
    const gone = await sendPush(b.subscription, {}, v, {
      fetch: (() =>
        Promise.resolve(new Response("", { status }))) as typeof fetch,
    });
    assertEquals([gone.ok, gone.gone], [false, true]);
  }
});

// --- the sealed box ---------------------------------------------------------

async function boxKeys() {
  const pair = await crypto.subtle.generateKey(P256, true, ["deriveBits"]);
  return await crypto.subtle.exportKey("jwk", pair.privateKey);
}

Deno.test("a sealed box opens only with the job's private key", async () => {
  const jwk = await boxKeys();
  const pub = b64url(rawPublicKey(jwk));
  const sealed = await seal(pub, "the secret and the subscription");
  assertEquals(await open(jwk, sealed), "the secret and the subscription");
  assert(!JSON.stringify(sealed).includes("secret"));
  const other = await boxKeys();
  await assertRejects(() => open(other, sealed));
  await assertRejects(() =>
    open(jwk, { ...sealed, ct: sealed.ct.slice(0, -2) + "AA" })
  );
  await assertRejects(() => open(jwk, { ...sealed, v: 2 }));
});

Deno.test("a holder is the secret's hash: public, stable, and no help forging a box", async () => {
  const secret = newSecret();
  const holder = await holderFor(secret);
  assert(/^[A-Za-z0-9_-]{43}$/.test(holder));
  assertEquals(await holderFor(secret), holder);
  assert(await verifyHolder(holder, secret));
  assert(!(await verifyHolder(holder, newSecret())));
  assert(!(await verifyHolder(holder, "")));
});

// --- the midnight job --------------------------------------------------------

/** The open database in memory, over the REST surface the job uses. */
function fakeDb(data: Record<string, unknown>) {
  const at = (path: string) => {
    let node: unknown = data;
    for (const k of path.split("/").filter(Boolean)) {
      node = node && typeof node === "object"
        ? (node as Record<string, unknown>)[k]
        : undefined;
    }
    return node ?? null;
  };
  const put = (path: string, value: unknown) => {
    const keys = path.split("/").filter(Boolean);
    let node = data as Record<string, unknown>;
    for (const k of keys.slice(0, -1)) {
      node = (node[k] ??= {}) as Record<string, unknown>;
    }
    if (value === undefined) delete node[keys[keys.length - 1]];
    else node[keys[keys.length - 1]] = value;
  };
  const writes: string[] = [];
  const serve = ((input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    const path = decodeURIComponent(url.pathname.replace(/\.json$/, ""));
    const method = init?.method ?? "GET";
    if (method === "GET") {
      let v = at(path);
      if (url.searchParams.get("shallow") && v && typeof v === "object") {
        v = Object.fromEntries(Object.keys(v).map((k) => [k, true]));
      }
      return Promise.resolve(Response.json(v));
    }
    writes.push(`${method} ${path}`);
    put(path, method === "DELETE" ? undefined : JSON.parse(String(init!.body)));
    return Promise.resolve(new Response(null, { status: 204 }));
  }) as typeof globalThis.fetch;
  return { data, fetch: serve, writes, at };
}

async function championKeys(): Promise<ChampionKeys> {
  return parseKeys(JSON.stringify({
    v: 1,
    subject: "https://codemonkey.games",
    vapid: (await vapidKeys()).privateJwk,
    box: await boxKeys(),
  }));
}

/** A browser that set a board and opted in: its holder and sealed box. */
async function champion(
  keys: ChampionKeys,
  gameId: string,
  secret = newSecret(),
) {
  const b = await browser();
  const box = await seal(
    publicConfigFor(keys).boxPublicKey,
    JSON.stringify({
      v: 1,
      secret,
      subscription: b.subscription,
      origin: "https://gs.codemonkey.games",
      games: { [gameId]: { url: "/games/2028-ai?level=gs", name: "gs" } },
    }),
  );
  return { b, holder: await holderFor(secret), box, secret };
}

Deno.test("at midnight the holder of each game's day is told, once", async () => {
  const keys = await championKeys();
  const me = await champion(keys, "gs-710c41d3");
  const db = fakeDb({
    leaderboards: {
      "gs-710c41d3": {
        daily: { "2026-10-30": { value: 114500, holder: me.holder } },
        meta: { name: "gs" },
      },
      "foo-a9f37ed7": { daily: { "2026-10-30": { value: 70700 } } },
      "ramsie-cae9647a": { daily: { "2026-10-29": { value: 13950 } } },
      globalHighScore: { value: 3782300 },
    },
    shmupX: {
      levels: { gs: { title: "SQUAD" } },
      champions: { subs: { [me.holder]: { box: me.box } } },
    },
  });
  const pushed: { sub: PushSubscriptionJson; payload: unknown }[] = [];
  const push = ((sub: PushSubscriptionJson, payload: unknown) => {
    pushed.push({ sub, payload });
    return Promise.resolve({ status: 201, ok: true, gone: false, text: "" });
  }) as typeof sendPush;
  const now = () => Date.UTC(2026, 9, 31, 0, 7);
  const run = () =>
    runDailyChampion({
      send: true,
      keys,
      fetch: db.fetch,
      now,
      push,
      db: "https://db.test",
    });

  const first = await run();
  assertEquals(first.date, "2026-10-30");
  assertEquals(
    first.results.map((r) => [r.gameId, r.status]),
    [
      ["foo-a9f37ed7", "no-holder"],
      ["gs-710c41d3", "sent"],
      ["ramsie-cae9647a", "no-record"],
    ],
  );
  assertEquals(pushed.length, 1);
  assertEquals(pushed[0].sub, me.b.subscription);
  assertEquals(pushed[0].payload, {
    title: "🏆 You're the daily world champion!",
    body: "Your 114,500 in SQUAD was the world's best score on Oct 30 (UTC).",
    url: "https://gs.codemonkey.games/games/2028-ai?level=gs",
    tag: "champion-gs-710c41d3-2026-10-30",
    gameId: "gs-710c41d3",
    date: "2026-10-30",
    value: 114500,
  });
  const sent = db.at(`${CHAMPIONS}/sent/2026-10-30/gs-710c41d3`) as Record<
    string,
    unknown
  >;
  assertEquals([sent.holder, sent.value, sent.status], [
    me.holder,
    114500,
    201,
  ]);

  // the same day again: nothing twice
  const again = await run();
  assertEquals(
    again.results.find((r) => r.gameId === "gs-710c41d3")!.status,
    "already-sent",
  );
  assertEquals(pushed.length, 1);
});

Deno.test("a box filed under someone else's holder is refused, and a dry run sends nothing", async () => {
  const keys = await championKeys();
  const victim = await champion(keys, "gs-710c41d3");
  const thief = await champion(keys, "gs-710c41d3");
  const db = fakeDb({
    leaderboards: {
      "gs-710c41d3": {
        daily: { "2026-10-30": { value: 114500, holder: victim.holder } },
      },
    },
    // the thief's box, sealed with the thief's own secret, under the victim
    shmupX: { champions: { subs: { [victim.holder]: { box: thief.box } } } },
  });
  let pushes = 0;
  const push = (() => {
    pushes++;
    return Promise.resolve({ status: 201, ok: true, gone: false, text: "" });
  }) as typeof sendPush;
  const opts = {
    keys,
    fetch: db.fetch,
    push,
    date: "2026-10-30",
    db: "https://db.test",
  };
  const refused = await runDailyChampion({ ...opts, send: true });
  assertEquals(refused.results[0].status, "bad-box");
  assertEquals(refused.results[0].detail, "sealed by another browser");

  db.data.shmupX = {
    champions: { subs: { [victim.holder]: { box: victim.box } } },
  };
  const dry = await runDailyChampion({ ...opts, send: false });
  assertEquals(dry.results[0].status, "would-send");
  assertEquals([pushes, db.writes], [0, []]);
  // without the keys a dry run cannot open the box, and says so
  const blind = await runDailyChampion({ ...opts, send: false, keys: null });
  assertEquals(blind.results[0].status, "unverified");
});

Deno.test("a subscription the push service has forgotten is dropped; a failed push is retried next run", async () => {
  const keys = await championKeys();
  const me = await champion(keys, "gs-710c41d3");
  const fresh = () =>
    fakeDb({
      leaderboards: {
        "gs-710c41d3": {
          daily: { "2026-10-30": { value: 9, holder: me.holder } },
        },
      },
      shmupX: { champions: { subs: { [me.holder]: { box: me.box } } } },
    });
  const answering = (status: number) =>
    (() =>
      Promise.resolve({
        status,
        ok: status < 300,
        gone: status === 404 || status === 410,
        text: "",
      })) as typeof sendPush;
  const opts = { keys, date: "2026-10-30", send: true, db: "https://db.test" };

  const gone = fresh();
  const r1 = await runDailyChampion({
    ...opts,
    fetch: gone.fetch,
    push: answering(410),
  });
  assertEquals(r1.results[0].status, "gone");
  assertEquals(gone.at(`${CHAMPIONS}/subs/${me.holder}`), null);
  assert(gone.at(`${CHAMPIONS}/sent/2026-10-30/gs-710c41d3`));

  const down = fresh();
  const r2 = await runDailyChampion({
    ...opts,
    fetch: down.fetch,
    push: answering(503),
  });
  assertEquals(r2.results[0].status, "failed");
  assertEquals(down.at(`${CHAMPIONS}/sent/2026-10-30/gs-710c41d3`), null);
  assert(down.at(`${CHAMPIONS}/subs/${me.holder}`));
});

Deno.test("a board filed under a player's holder for a game they never played tells them nothing", async () => {
  const keys = await championKeys();
  const me = await champion(keys, "gs-710c41d3");
  const db = fakeDb({
    leaderboards: {
      // the holder is public: anyone can write it onto a board of their own
      "0-spam": {
        daily: { "2026-10-30": { value: 1, holder: me.holder } },
        meta: { name: "Claim your PRIZE now" },
      },
      "gs-710c41d3": {
        daily: { "2026-10-30": { value: 114500, holder: me.holder } },
        meta: { name: "Your account is locked" },
      },
    },
    shmupX: { champions: { subs: { [me.holder]: { box: me.box } } } },
  });
  const bodies: string[] = [];
  const push = ((_s: unknown, payload: { body: string }) => {
    bodies.push(payload.body);
    return Promise.resolve({ status: 201, ok: true, gone: false, text: "" });
  }) as unknown as typeof sendPush;
  const run = await runDailyChampion({
    send: true,
    keys,
    fetch: db.fetch,
    push,
    date: "2026-10-30",
    db: "https://db.test",
  });
  assertEquals(run.results.map((r) => [r.gameId, r.status]), [
    ["0-spam", "not-played"],
    ["gs-710c41d3", "sent"],
  ]);
  // the name is the one the player's own page sealed, never the board's meta
  assertEquals(bodies, [
    "Your 114,500 in gs was the world's best score on Oct 30 (UTC).",
  ]);
});

Deno.test("a box that names no real push service, or broken keys, is refused without failing the run", async () => {
  const keys = await championKeys();
  const cases: [
    string,
    (b: PushSubscriptionJson) => PushSubscriptionJson,
    string,
  ][] = [
    [
      "a-1",
      (b) => ({ ...b, endpoint: "https://10.0.0.1/x" }),
      "10.0.0.1 is not a known push service",
    ],
    [
      "b-2",
      (b) => ({ ...b, endpoint: "http://fcm.googleapis.com/x" }),
      "endpoint is not https",
    ],
    [
      "c-3",
      (b) => ({ ...b, keys: { ...b.keys, p256dh: "AAAA" } }),
      "bad p256dh",
    ],
    ["d-4", (b) => ({ ...b, keys: { ...b.keys, auth: "AAAA" } }), "bad auth"],
  ];
  const leaderboards: Record<string, unknown> = {};
  const subs: Record<string, unknown> = {};
  for (const [gameId, broken] of cases) {
    const secret = newSecret();
    const holder = await holderFor(secret);
    const b = await browser();
    leaderboards[gameId] = { daily: { "2026-10-30": { value: 5, holder } } };
    subs[holder] = {
      box: await seal(
        publicConfigFor(keys).boxPublicKey,
        JSON.stringify({
          v: 1,
          secret,
          subscription: broken(b.subscription),
          origin: "https://codemonkey.games",
          games: { [gameId]: { name: "x" } },
        }),
      ),
    };
  }
  const db = fakeDb({ leaderboards, shmupX: { champions: { subs } } });
  let pushes = 0;
  const push = (() => {
    pushes++;
    return Promise.resolve({ status: 201, ok: true, gone: false, text: "" });
  }) as typeof sendPush;
  const run = await runDailyChampion({
    send: true,
    keys,
    fetch: db.fetch,
    push,
    date: "2026-10-30",
    db: "https://db.test",
  });
  assertEquals(
    run.results.map((r) => [r.gameId, r.status, r.detail]),
    cases.map(([id, , why]) => [id, "bad-box", why]),
  );
  assertEquals(pushes, 0);
});

Deno.test("one game's trouble is that game's: a failed read, a push turned away, a push service down", async () => {
  const keys = await championKeys();
  const a = await champion(keys, "a-1");
  const c = await champion(keys, "c-3");
  const d = await champion(keys, "d-4");
  const db = fakeDb({
    leaderboards: {
      "a-1": { daily: { "2026-10-30": { value: 1, holder: a.holder } } },
      "b-2": { daily: { "2026-10-30": { value: 2 } } },
      "c-3": { daily: { "2026-10-30": { value: 3, holder: c.holder } } },
      "d-4": { daily: { "2026-10-30": { value: 4, holder: d.holder } } },
    },
    shmupX: {
      champions: {
        subs: {
          [a.holder]: { box: a.box },
          [c.holder]: { box: c.box },
          [d.holder]: { box: d.box },
        },
      },
    },
  });
  const flaky =
    ((input: string, init?: RequestInit) =>
      input.includes("/b-2/")
        ? Promise.resolve(new Response("down", { status: 503 }))
        : db.fetch(input, init)) as typeof fetch;
  const answer = new Map([[a.b.subscription.endpoint, 201]]);
  // every browser() endpoint is the same; tell them apart by the p256dh
  const statusFor = (sub: PushSubscriptionJson) =>
    sub.keys.p256dh === c.b.subscription.keys.p256dh
      ? 403
      : sub.keys.p256dh === d.b.subscription.keys.p256dh
      ? 502
      : answer.get(sub.endpoint)!;
  const push = ((sub: PushSubscriptionJson) => {
    const status = statusFor(sub);
    return Promise.resolve({
      status,
      ok: status < 300,
      gone: false,
      text: "",
    });
  }) as typeof sendPush;
  const run = await runDailyChampion({
    send: true,
    keys,
    fetch: flaky,
    push,
    date: "2026-10-30",
    db: "https://db.test",
  });
  assertEquals(run.results.map((r) => [r.gameId, r.status]), [
    ["a-1", "sent"],
    ["b-2", "failed"],
    ["c-3", "rejected"],
    ["d-4", "failed"],
  ]);
  // turned away is final for the day; a service that was down is tried again
  assert(db.at(`${CHAMPIONS}/sent/2026-10-30/c-3`));
  assertEquals(db.at(`${CHAMPIONS}/sent/2026-10-30/d-4`), null);
});

Deno.test("a day still being played cannot be sent for", async () => {
  const keys = await championKeys();
  const now = () => Date.UTC(2026, 9, 31, 15, 0);
  for (const date of ["2026-10-31", "2026-11-01"]) {
    await assertRejects(
      () =>
        runDailyChampion({
          send: true,
          keys,
          date,
          now,
          fetch: fakeDb({}).fetch,
          db: "https://db.test",
        }),
      Error,
      "has not ended",
    );
  }
  // a dry run may look at it
  const dry = await runDailyChampion({
    send: false,
    keys,
    date: "2026-10-31",
    now,
    fetch: fakeDb({ leaderboards: {} }).fetch,
    db: "https://db.test",
  });
  assertEquals(dry.results, []);
});

Deno.test("a game's name is said plainly: no control or direction characters, at most 40", () => {
  assertEquals(displayName("SQUAD"), "SQUAD");
  assertEquals(displayName("a\u202eb\nc\u0007d"), "ab cd");
  assertEquals(displayName("x".repeat(60)).length, 40);
  assertEquals(displayName({ toString: 1 }), "");
  assertEquals(
    subscriptionProblem({ endpoint: "https://web.push.apple.com/x" }),
    "bad keys",
  );
});

Deno.test("the job crowns the UTC day that just ended, and refuses keys it cannot use", () => {
  assertEquals(previousUtcDay(Date.UTC(2026, 9, 31, 0, 7)), "2026-10-30");
  assertEquals(previousUtcDay(Date.UTC(2026, 10, 1, 0, 0)), "2026-10-31");
  assertEquals(previousUtcDay(Date.UTC(2027, 0, 1, 0, 30)), "2026-12-31");
  for (
    const bad of [
      "",
      "{}",
      JSON.stringify({ subject: "x", vapid: {}, box: {} }),
      JSON.stringify({ subject: "https://a", vapid: { kty: "EC" }, box: {} }),
    ]
  ) {
    let threw = false;
    try {
      parseKeys(bad);
    } catch {
      threw = true;
    }
    assert(threw, bad);
  }
  const n = championNotification(
    "x-1",
    "2026-12-31",
    1234567,
    "FOO",
    "https://a/",
  );
  assertEquals(
    n.body,
    "Your 1,234,567 in FOO was the world's best score on Dec 31 (UTC).",
  );
});

// --- the page and its worker --------------------------------------------------

Deno.test("config.json carries two P-256 public keys and the hosts the opt-in runs on", async () => {
  const config = JSON.parse(await read("static/champion/config.json"));
  for (const k of [config.vapidPublicKey, config.boxPublicKey]) {
    const raw = fromB64url(k);
    assertEquals([raw.length, raw[0]], [65, 4]);
    await crypto.subtle.importKey("raw", raw, P256, false, []);
  }
  assert(config.vapidPublicKey !== config.boxPublicKey, "two keys, two jobs");
  assertEquals(config.hosts, ["codemonkey.games"]);
});

Deno.test("both game pages load the champion script", async () => {
  const tag = '<script type="module" src="/champion/champion.js"></script>';
  assert((await read("routes/games/2028-ai.tsx")).includes(tag));
  assert(
    standaloneGamePageHtml({ title: "t", bundleSrc: "game.bundle.js" })
      .includes(tag),
  );
  // the script hands the bundle the hook it asks for, and listens for its event
  const page = await read("static/champion/champion.js");
  assert(page.includes("globalThis.__SHMUPX_CHAMPION__ = {"));
  assert(page.includes('addEventListener("shmupx:daily-best"'));
  assert(page.includes('const SCOPE = "/champion/";'));
});

Deno.test("the worker shows the push and opens only its own origin", async () => {
  const listeners: Record<string, (e: unknown) => void> = {};
  const shown: { title: string; opts: Record<string, unknown> }[] = [];
  const opened: string[] = [];
  const self = {
    location: { origin: "https://gs.codemonkey.games" },
    addEventListener: (
      t: string,
      f: (e: unknown) => void,
    ) => (listeners[t] = f),
    skipWaiting() {},
    registration: {
      showNotification: (title: string, opts: Record<string, unknown>) => {
        shown.push({ title, opts });
        return Promise.resolve();
      },
    },
    clients: {
      matchAll: () => Promise.resolve([]),
      openWindow: (url: string) => {
        opened.push(url);
        return Promise.resolve();
      },
    },
  };
  new Function("self", await read("static/champion/sw.js"))(self);
  const waits: Promise<unknown>[] = [];
  const event = (extra: Record<string, unknown>) => ({
    waitUntil: (p: Promise<unknown>) => waits.push(p),
    ...extra,
  });
  listeners.push(event({
    data: {
      json: () => ({
        title: "🏆 T",
        body: "B",
        url: "/games/2028-ai?level=gs",
        tag: "t1",
      }),
    },
  }));
  await Promise.all(waits);
  assertEquals(shown[0].title, "🏆 T");
  assertEquals(shown[0].opts.body, "B");
  assertEquals(shown[0].opts.tag, "t1");
  for (
    const [url, want] of [
      [
        "/games/2028-ai?level=gs",
        "https://gs.codemonkey.games/games/2028-ai?level=gs",
      ],
      ["https://evil.example/", "https://gs.codemonkey.games/"],
      ["javascript:alert(1)", "https://gs.codemonkey.games/"],
    ]
  ) {
    listeners.notificationclick(event({
      notification: { close() {}, data: { url } },
    }));
    await Promise.all(waits);
    assertEquals(opened.pop(), want);
  }
});
