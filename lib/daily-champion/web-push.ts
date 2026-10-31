/**
 * Web Push, sent straight to a browser's push service with WebCrypto and
 * nothing else: the payload encrypted as RFC 8291 says (aes128gcm, RFC 8188)
 * and the request signed with a VAPID JWT (RFC 8292). A browser that
 * subscribed with our VAPID public key gets the message from Chrome's, Firefox's,
 * Edge's or Apple's push service alike, with no Firebase or vendor SDK.
 *
 * `encrypt` takes its ephemeral key and salt as options so tests can check it
 * byte for byte against RFC 8291's Appendix A; a real send draws both fresh.
 */

import { b64url, fromB64url } from "../../static/champion/box.js";

/** A browser's PushSubscription, as `subscription.toJSON()` gives it. */
export interface PushSubscriptionJson {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** The VAPID key pair: a P-256 private JWK (with x and y) and its subject. */
export interface VapidKeys {
  privateJwk: JsonWebKey;
  /** `mailto:` or `https:` contact the push service can reach us at. */
  subject: string;
}

const enc = new TextEncoder();

/** Bytes on an ArrayBuffer of their own, as WebCrypto and fetch take them. */
type Bytes = Uint8Array<ArrayBuffer>;

function concat(...parts: Uint8Array[]): Bytes {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

async function hkdf(
  salt: Bytes,
  ikm: Bytes,
  info: Bytes,
  bytes: number,
): Promise<Bytes> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, [
    "deriveBits",
  ]);
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt, info },
      key,
      bytes * 8,
    ),
  );
}

/** The raw uncompressed point (65 bytes) of a P-256 JWK. */
export function rawPublicKey(jwk: JsonWebKey): Bytes {
  return concat(
    new Uint8Array([4]),
    fromB64url(jwk.x!),
    fromB64url(jwk.y!),
  );
}

export interface EncryptOptions {
  /** The application server's ECDH key pair; fresh when omitted. */
  serverKeys?: CryptoKeyPair;
  /** The 16-byte salt; random when omitted. */
  salt?: Bytes;
  /** The record size written in the header (RFC 8188); 4096 by default. */
  recordSize?: number;
}

/**
 * `payload` encrypted for one subscription, as the request body: the
 * aes128gcm header (salt, record size, the server's public key) and one
 * record, padded with the 0x02 last-record delimiter (RFC 8291 section 4).
 */
export async function encrypt(
  subscription: PushSubscriptionJson,
  payload: Uint8Array,
  options: EncryptOptions = {},
): Promise<Bytes> {
  const uaPublic = fromB64url(subscription.keys.p256dh);
  const authSecret = fromB64url(subscription.keys.auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 4) {
    throw new Error("p256dh is not an uncompressed P-256 point");
  }
  if (authSecret.length !== 16) throw new Error("auth is not 16 bytes");
  const P256 = { name: "ECDH", namedCurve: "P-256" };
  const server = options.serverKeys ??
    await crypto.subtle.generateKey(P256, true, ["deriveBits"]);
  const asPublic = new Uint8Array(
    await crypto.subtle.exportKey("raw", server.publicKey),
  );
  const ua = await crypto.subtle.importKey("raw", uaPublic, P256, false, []);
  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "ECDH", public: ua },
      server.privateKey,
      256,
    ),
  );
  // RFC 8291 3.4: IKM from the ECDH secret, keyed by the auth secret and
  // bound to both public keys; then the content key and nonce (RFC 8188).
  const keyInfo = concat(enc.encode("WebPush: info\0"), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);
  const salt = options.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(
    salt,
    ikm,
    enc.encode("Content-Encoding: aes128gcm\0"),
    16,
  );
  const nonce = await hkdf(
    salt,
    ikm,
    enc.encode("Content-Encoding: nonce\0"),
    12,
  );
  const recordSize = options.recordSize ?? 4096;
  // one record: the payload, the 0x02 delimiter, no padding; a push service
  // takes at most 4096 bytes of body, the 86-byte header included
  const plain = concat(payload, new Uint8Array([2]));
  if (plain.length + 16 > recordSize || 86 + plain.length + 16 > 4096) {
    throw new Error("payload too large");
  }
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, [
    "encrypt",
  ]);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, plain),
  );
  const header = new Uint8Array(16 + 4 + 1 + asPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, recordSize);
  header[20] = asPublic.length;
  header.set(asPublic, 21);
  return concat(header, ct);
}

/**
 * The VAPID `Authorization` header for a push service's origin: an ES256 JWT
 * (aud, exp at most 24 h out, sub) and our public key (RFC 8292 section 3).
 */
export async function vapidAuthorization(
  endpoint: string,
  vapid: VapidKeys,
  now = Date.now(),
): Promise<string> {
  const aud = new URL(endpoint).origin;
  const head = b64url(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const body = b64url(
    enc.encode(
      JSON.stringify({
        aud,
        exp: Math.floor(now / 1000) + 12 * 3600,
        sub: vapid.subject,
      }),
    ),
  );
  const key = await crypto.subtle.importKey(
    "jwk",
    { ...vapid.privateJwk, key_ops: ["sign"], ext: true },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  // WebCrypto's ECDSA signature is already r || s, the form a JWT wants.
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    enc.encode(`${head}.${body}`),
  );
  const k = b64url(rawPublicKey(vapid.privateJwk));
  return `vapid t=${head}.${body}.${b64url(sig)}, k=${k}`;
}

export interface SendResult {
  status: number;
  /** The push service no longer knows the subscription: drop it. */
  gone: boolean;
  ok: boolean;
  text: string;
}

/** The start of a response body, on one line: the rest is never read. */
async function firstBytes(res: Response, n: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  try {
    const { value } = await reader.read();
    return new TextDecoder().decode((value ?? new Uint8Array()).slice(0, n))
      // deno-lint-ignore no-control-regex
      .replace(/[\x00-\x1f\x7f]+/g, " ").trim();
  } catch {
    return "";
  } finally {
    reader.cancel().catch(() => {});
  }
}

/** Push `payload` (JSON-encoded) to one subscription. */
export async function sendPush(
  subscription: PushSubscriptionJson,
  payload: unknown,
  vapid: VapidKeys,
  {
    fetch: doFetch = fetch,
    ttl = 24 * 3600,
    topic,
    now = Date.now(),
  }: {
    fetch?: typeof fetch;
    ttl?: number;
    topic?: string;
    now?: number;
  } = {},
): Promise<SendResult> {
  const body = await encrypt(
    subscription,
    enc.encode(JSON.stringify(payload)),
  );
  const headers: Record<string, string> = {
    "content-encoding": "aes128gcm",
    "content-type": "application/octet-stream",
    ttl: String(ttl),
    urgency: "normal",
    authorization: await vapidAuthorization(subscription.endpoint, vapid, now),
  };
  // A newer message with the same topic replaces one still undelivered.
  if (topic) headers.topic = topic;
  const res = await doFetch(subscription.endpoint, {
    method: "POST",
    headers,
    body,
    // a push service answers at once; one that does not is not one
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  });
  return {
    status: res.status,
    gone: res.status === 404 || res.status === 410,
    ok: res.status >= 200 && res.status < 300,
    text: await firstBytes(res, 300),
  };
}
