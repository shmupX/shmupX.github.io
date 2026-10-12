// The few localStorage keys a packaged app keeps on disk, so what was
// installed is still installed at the next launch.
//
// Under `deno desktop` the page's storage does not outlive the launch (a fresh
// CEF profile and a fresh port every time — lib/offline-store.ts), so the
// arcade section and its shelf would vanish on every restart however much of
// the board is kept on disk. The server writes these keys to one JSON file in
// the launcher's data directory: every HTML page it serves carries a script
// that puts the saved values back before the page's own scripts read them, and
// sends each later change back. Nothing else in the page changes, and a
// browser that keeps its storage (a borrowed one, on Windows) simply finds the
// values already there.

import { dirname } from "@std/path";

/**
 * What survives a restart: the installed emulator cores (svelte-src/
 * Dashboard.svelte EMU_KEY, static/ps2-library.js) and the arcade shelf
 * (static/eshop-library.js ARCADE_SHELF_KEY).
 */
export const KEPT_KEYS: readonly string[] = [
  "shmupx-emulators",
  "shmupx-arcade-shelf",
];

/** Where a page sends a change. */
export const KEPT_STORAGE_URL = "/api/kept-storage";

const MAX_BODY = 1 << 20;

export interface KeptState {
  /** When the page that wrote it says it did, so a late write cannot undo a newer one. */
  stamp: number;
  values: Record<string, string>;
}

export async function readKept(file: string): Promise<KeptState> {
  try {
    const raw = JSON.parse(await Deno.readTextFile(file));
    const values: Record<string, string> = {};
    for (const k of KEPT_KEYS) {
      if (typeof raw?.values?.[k] === "string") values[k] = raw.values[k];
    }
    return { stamp: Number(raw?.stamp) || 0, values };
  } catch {
    return { stamp: 0, values: {} };
  }
}

// Writes are applied one at a time, so two pages saving at once cannot
// interleave a read of the file with the other's rename.
let queue: Promise<unknown> = Promise.resolve();

/**
 * Apply a page's PUT: `{ stamp, values: { key: string | null } }`, keys outside
 * KEPT_KEYS ignored, null meaning removed. Older than what is on disk is a
 * no-op. Resolves to the HTTP status to answer with.
 */
export function applyKept(file: string, body: unknown): Promise<number> {
  const run = queue.then(async () => {
    const b = body as { stamp?: unknown; values?: unknown };
    const stamp = Number(b?.stamp);
    if (!Number.isFinite(stamp) || !b?.values || typeof b.values !== "object") {
      return 400;
    }
    const now = await readKept(file);
    if (stamp < now.stamp) return 204;
    const incoming = b.values as Record<string, unknown>;
    for (const k of KEPT_KEYS) {
      if (!(k in incoming)) continue;
      const v = incoming[k];
      if (typeof v === "string") now.values[k] = v;
      else if (v === null) delete now.values[k];
    }
    now.stamp = stamp;
    await Deno.mkdir(dirname(file), { recursive: true });
    const part = `${file}.${crypto.randomUUID()}.part`;
    await Deno.writeTextFile(part, JSON.stringify(now));
    await Deno.rename(part, file);
    return 204;
  });
  queue = run.catch(() => {});
  return run;
}

/** Read a PUT body no larger than MAX_BODY, or null. */
export async function readBody(req: Request): Promise<unknown> {
  const text = await req.text();
  if (text.length > MAX_BODY) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * The script every HTML page in a packaged app starts with: put the saved
 * values back where the page has none, then send every later change to the
 * kept keys to the server. Frames share the top page's storage, so a change
 * made from the editor in the game frame is sent from there.
 */
export function keptStorageScript(state: KeptState): string {
  const json = (v: unknown) =>
    JSON.stringify(v).replace(
      /[<\u2028\u2029]/g,
      (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"),
    );
  return `<script>(function(){` +
    `var K=${json(KEPT_KEYS)},S=${json(state.values)},U=${
      json(KEPT_STORAGE_URL)
    };` +
    `var ls;try{ls=window.localStorage}catch(e){return}` +
    `try{for(var i=0;i<K.length;i++){var k=K[i];if(k in S&&ls.getItem(k)===null)ls.setItem(k,S[k])}}catch(e){}` +
    `function send(){var v={};for(var i=0;i<K.length;i++)v[K[i]]=ls.getItem(K[i]);` +
    `try{fetch(U,{method:"PUT",keepalive:true,headers:{"content-type":"application/json"},` +
    `body:JSON.stringify({stamp:performance.timeOrigin+performance.now(),values:v})}).catch(function(){})}catch(e){}}` +
    `var P=Storage.prototype,set=P.setItem,rem=P.removeItem,clr=P.clear;` +
    `P.setItem=function(k,v){set.call(this,k,v);if(this===ls&&K.indexOf(String(k))>=0)send()};` +
    `P.removeItem=function(k){rem.call(this,k);if(this===ls&&K.indexOf(String(k))>=0)send()};` +
    `P.clear=function(){clr.call(this);if(this===ls)send()};` +
    `})();</script>`;
}

/** `html` with the script placed before anything else in its <head>. */
export function injectKeptStorage(html: string, state: KeptState): string {
  const script = keptStorageScript(state);
  const head = html.match(/<head[^>]*>/i);
  if (head && head.index !== undefined) {
    const at = head.index + head[0].length;
    return html.slice(0, at) + script + html.slice(at);
  }
  return script + html;
}
