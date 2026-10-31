// The daily world champion's sealed box, shared by the page that seals a
// browser's push subscription (champion.js) and the midnight job that opens it
// (lib/daily-champion/job.ts). Plain WebCrypto, so the same file runs in a
// browser and in Deno.
//
// The database is open to anyone, so a subscription goes in sealed to the
// job's public key (config.json's boxPublicKey) and only the job, which holds
// the private one, can open it: ECDH P-256 with a fresh key per seal, HKDF-
// SHA-256 over the shared secret, AES-256-GCM. The box carries the browser's
// champion secret too; the board names a browser by the secret's hash
// (holderFor), and the job opens a box only for the holder it was filed under
// (verifyHolder), so a box written under someone else's holder is refused.

const INFO = new TextEncoder().encode("shmupX daily champion box v1");
const P256 = { name: "ECDH", namedCurve: "P-256" };

export function b64url(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromB64url(text) {
  const s = String(text).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(s + "===".slice((s.length + 3) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** A fresh champion secret: 32 random bytes, base64url. */
export function newSecret() {
  return b64url(crypto.getRandomValues(new Uint8Array(32)));
}

/**
 * The id a board names a browser by: the SHA-256 of its secret, base64url
 * (43 characters, all legal in a database key). Public; the secret is not.
 */
export async function holderFor(secret) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(String(secret)),
  );
  return b64url(digest);
}

async function boxKey(privateKey, publicKey, ephemeralRaw, boxRaw) {
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "ECDH", public: publicKey },
      privateKey,
      256,
    ),
  );
  const ikm = await crypto.subtle.importKey("raw", shared, "HKDF", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: concat(ephemeralRaw, boxRaw),
      info: INFO,
    },
    ikm,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/**
 * `text` sealed to the job's public key (raw uncompressed P-256, base64url):
 * `{v, epk, iv, ct}`, all base64url.
 */
export async function seal(boxPublicKey, text) {
  const boxRaw = fromB64url(boxPublicKey);
  const box = await crypto.subtle.importKey("raw", boxRaw, P256, false, []);
  const eph = await crypto.subtle.generateKey(P256, true, ["deriveBits"]);
  const ephRaw = new Uint8Array(
    await crypto.subtle.exportKey("raw", eph.publicKey),
  );
  const key = await boxKey(eph.privateKey, box, ephRaw, boxRaw);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(text),
  );
  return { v: 1, epk: b64url(ephRaw), iv: b64url(iv), ct: b64url(ct) };
}

/**
 * The text in a sealed box, with the job's private key (a P-256 JWK). Throws
 * when the box is malformed or was not sealed to this key.
 */
export async function open(boxPrivateJwk, sealed) {
  if (!sealed || sealed.v !== 1) throw new Error("not a v1 box");
  const priv = await crypto.subtle.importKey(
    "jwk",
    { ...boxPrivateJwk, key_ops: ["deriveBits"], ext: true },
    P256,
    false,
    ["deriveBits"],
  );
  const boxRaw = concat(
    new Uint8Array([4]),
    fromB64url(boxPrivateJwk.x),
    fromB64url(boxPrivateJwk.y),
  );
  const ephRaw = fromB64url(sealed.epk);
  const eph = await crypto.subtle.importKey("raw", ephRaw, P256, false, []);
  const key = await boxKey(priv, eph, ephRaw, boxRaw);
  const text = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromB64url(sealed.iv) },
    key,
    fromB64url(sealed.ct),
  );
  return new TextDecoder().decode(text);
}

/** Whether `secret` is the one `holder` names. */
export async function verifyHolder(holder, secret) {
  return typeof secret === "string" && secret.length > 0 &&
    (await holderFor(secret)) === holder;
}
