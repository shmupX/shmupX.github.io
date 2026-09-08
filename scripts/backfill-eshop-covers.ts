// Give every published eShop Dezaemon game the title-screen cover it went out
// without.
//
//   deno task eshop:covers              # what it would do; writes nothing
//   deno task eshop:covers -- --write   # render and upload
//   deno task eshop:covers -- --write --only dezafoo
//   deno task eshop:covers -- --write --force   # re-render covers that exist
//
// WHY THESE ARE MISSING
// The editor's PUBLISH TO ESHOP used to send `logoDataURL || titleBgDataURL`
// — art the TITLE EDITOR was given — scaled down. A .sav import never sets
// either, so a published cart went out with `hasCover: false` and its shop card
// and coverflow row drew a text placeholder. Publishing now composes the cover
// from the cart itself (static/editor/index.html `dezaCoverDataUrl` →
// static/deza-shelf.js `composeShelfCover`), and the shelf fills one in on
// install even for a listing that has none — but the LISTING stays coverless
// until somebody re-publishes. This is that, without a re-publish: it reads
// what is already stored, renders, and writes only the cover node and the one
// `hasCover` field.
//
// It is the community library's own process, on the other node:
// `normalize → parse → isGameSave → decodeSave → composeCover`, the same four
// calls scripts/upload-deza-saves.ts makes for /dezaemon/covers.
//
// WRITES ARE OPT-IN. The default is a dry run, because this is the live
// database every client reads.
import { encodeBase64 } from "@std/encoding/base64";
import {
  composeCover,
  decodeSave,
  isGameSave,
  normalize,
  parse,
} from "../packages/shmup-engine/mod.js";
import { encodePNG } from "jsr:@img/png@^0.1.6";

const DB = "https://evil-invaders-default-rtdb.firebaseio.com";
const ROOT = "eshop";

const args = Deno.args;
const flag = (name: string) => args.includes(`--${name}`);
const value = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const write = flag("write");
const force = flag("force");
const only = value("only");

interface IndexRow {
  kind?: string;
  name?: string;
  title?: string;
  hasCover?: boolean;
  [key: string]: unknown;
}

async function getJson<T>(path: string): Promise<T | null> {
  const res = await fetch(`${DB}/${path}.json`);
  if (!res.ok) throw new Error(`GET ${path}: HTTP ${res.status}`);
  return await res.json() as T | null;
}

/** print=silent, so RTDB does not echo the value back and burn the quota. */
async function put(path: string, body: unknown): Promise<number> {
  const json = JSON.stringify(body);
  const res = await fetch(`${DB}/${path}.json?print=silent`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: json,
  });
  if (!res.ok) {
    throw new Error(
      `PUT ${path}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`,
    );
  }
  await res.body?.cancel();
  return new TextEncoder().encode(json).length;
}

const index = await getJson<Record<string, IndexRow>>(`${ROOT}/index`) ?? {};
const rows = Object.entries(index)
  .filter(([, row]) => row?.kind === "deza")
  .filter(([id]) => !only || id.includes(only))
  .filter(([, row]) => force || !row?.hasCover);

console.log(
  `${Object.keys(index).length} listings, ${rows.length} Dezaemon game${
    rows.length === 1 ? "" : "s"
  } to cover${write ? "" : " — DRY RUN, nothing is written"}`,
);

let made = 0, uploaded = 0;
for (const [id, row] of rows) {
  const label = row.title || row.name || id;
  try {
    const save = await getJson<{ sav?: string }>(`${ROOT}/saves/${id}`);
    if (!save?.sav) {
      console.log(`  - ${label}: no stored save under /${ROOT}/saves/${id}`);
      continue;
    }
    // The blob is gzip(logical image) in base64; normalize() unwraps exactly
    // that one layer, and parse() finds the DEZA2____NN entry inside it.
    const gz = Uint8Array.from(atob(save.sav), (c) => c.charCodeAt(0));
    const { data } = await normalize(gz);
    const entry = parse(data).filter(isGameSave)[0];
    if (!entry?.payload) {
      console.log(`  - ${label}: no readable game save in the stored blob`);
      continue;
    }
    const composed = composeCover(decodeSave(entry.payload.buffer));
    // encodePNG detaches the buffer it is given, so hand it a copy.
    const png = await encodePNG(new Uint8Array(composed.rgba), {
      width: composed.w,
      height: composed.h,
      compression: 0,
      filter: 0,
      interlace: 0,
    });
    made++;
    const kb = (png.length / 1024).toFixed(1);
    const from = composed.hasTitleArt ? "its drawn title page" : "its own art";
    console.log(
      `  ${
        write ? "→" : "·"
      } ${label}: ${composed.w}x${composed.h} from ${from}, ${kb}KB`,
    );
    if (!write) continue;
    // Cover first, then the one field on the listing that reveals it: a reader
    // that sees hasCover always finds a cover behind it.
    uploaded += await put(`${ROOT}/covers/${id}`, {
      png: `data:image/png;base64,${encodeBase64(png)}`,
      w: composed.w,
      h: composed.h,
      publishedAt: Number(row.publishedAt) || null,
    });
    uploaded += await put(`${ROOT}/index/${id}/hasCover`, true);
  } catch (e) {
    console.log(`  ! ${label}: ${(e as Error).message}`);
  }
}

console.log(
  `${made} cover${made === 1 ? "" : "s"} rendered` +
    (write
      ? `, ${(uploaded / 1024).toFixed(0)}KB written`
      : " — re-run with --write to upload them"),
);
