// Creating a character: clone an existing one, swap frames in, publish.
//
// A "character" here is exactly what the catalog already stores at
// characters/<name> — the record the level editor's ADD button folds into a
// level as bossData.boss<N>, and the same shape the runtime reads at
// game.bundle.js:11876. dezaBoss0 is one: anim, bulletDataA/C, a dezaemon
// trailer, hp/score/interval/spgage/shadow*, and a textureKey naming the
// atlas its frames live in. Cloning is therefore a deep copy plus a new
// textureKey, and "swap in any frame from any sprite or atlas" is a matter of
// repacking the atlas that textureKey points at.

import {
  ArtError,
  type AtlasJson,
  type FrameContext,
  type FrameRef,
  invalidateAtlas,
  loadAtlas,
  packFrames,
  type ResolvedFrame,
  resolveFrame,
  sheetDataUrl,
} from "./art.ts";
import { assertSafeKey, dbPath, get, listKeys, put } from "./rtdb.ts";

export type Character = Record<string, unknown>;

/**
 * Every projectile slot the runtime arms a boss out of. Four logical slots,
 * each with a `projectileData*` alias — anything that touches one has to touch
 * all of them, so this is kept in step with BOSS_PROJECTILE_KEYS at
 * static/games/2028-ai/game.bundle.js:197-206.
 */
export const PROJECTILE_KEYS = [
  "bulletData",
  "projectileData",
  "bulletDataA",
  "projectileDataA",
  "bulletDataB",
  "projectileDataB",
  "bulletDataC",
  "projectileDataC",
] as const;

/**
 * The slot "the main projectile" means.
 *
 * Not `bulletData`, which reads like the obvious answer and is the wrong one.
 * A record carrying `dezaemon.boss` and no `attackPattern` arms the Dezaemon
 * engine (initDezaBoss, game.bundle.js:5493), whose only weapon resolver is
 * bossWeapon() — and that reads scene.bossProjDataA/B/C exclusively, never the
 * unsuffixed slot. On the stock attack-pattern path every pattern likewise
 * starts `scene.bossProjDataA || scene.bossProjData`. So A wins wherever it
 * exists, and writing `bulletData` on a dezaBoss clone changes nothing at all.
 */
export const MAIN_PROJECTILE_KEY = "bulletDataA";

/**
 * The most frames one build may cut out of the attached pictures.
 *
 * Each cut is a crop, a pixel-scale detection, a background flood and a
 * shrink over as much as a whole 2000-px picture — on the order of 180 ms of
 * synchronous CPU — and the refs are tiny: `{upload: 0, as: "f7"}` is a new
 * frame every time its `as` changes, so a few kilobytes of anim states could
 * otherwise ask for minutes of it inside one ask or one publish. Sixteen is
 * a boss's whole animation set and its shots with room over; a build that
 * wants more is asking for the same frame under many names, and the same ref
 * written again is packed once for nothing.
 */
export const MAX_UPLOAD_FRAMES = 16;

export interface ProjectileOverride {
  texture?: FrameRef[];
  speed?: number;
  damage?: number;
  hp?: number;
  score?: number;
  spgage?: number;
  /** Flip speed for a multi-frame bullet — spawnDezaBossBullet reads it. */
  frameRate?: number;
}

export interface CreateRequest {
  name: string;
  cloneFrom?: string;
  anim?: Record<string, FrameRef[]>;
  projectiles?: Record<string, ProjectileOverride>;
  stageBgEnd?: FrameRef | null;
  /**
   * Opacity for the stage-end backdrop, 0..1. On its own — with no
   * `stageBgEnd` — it makes the SHIPPED backdrop translucent.
   */
  stageBgEndAlpha?: number;
  stats?: Record<string, number | boolean>;
}

export interface CreateResult {
  name: string;
  clonedFrom: string | null;
  character: Character;
  atlas: {
    json: AtlasJson;
    dataUrl: string;
    frameCount: number;
    size: { w: number; h: number };
  };
  /** Every frame in the packed atlas, and where its pixels came from. */
  provenance: { frame: string; source: string }[];
  /** Names the record still references that no source could supply. */
  unresolved: string[];
  warnings: string[];
}

const deepClone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Opacity the runtime will accept: finite, and inside 0..1. */
function clampAlpha(value: number): number {
  if (!Number.isFinite(value)) {
    throw new ArtError(`stageBgEndAlpha must be a number, got ${value}.`);
  }
  return Math.max(0, Math.min(1, value));
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : [];
}

/**
 * Every frame name a record references.
 *
 * Mirrors the level editor's own missing-texture collector
 * (static/editor/index.html:2139-2152): anim keys that do not start with "_",
 * each projectile slot's `texture`, and dezaemon.partArt. Two the editor does
 * not walk are included because the runtime does read them — dezaemon.coreArt,
 * and the top-level `texture` bossAdd falls back to when anim.idle is absent.
 */
export function referencedFrames(record: Character): string[] {
  const names = new Set<string>();
  const add = (value: unknown) => {
    for (const name of asStringArray(value)) names.add(name);
    if (typeof value === "string") names.add(value);
  };

  const anim = record.anim;
  if (anim && typeof anim === "object") {
    for (const [key, frames] of Object.entries(anim)) {
      if (!key.startsWith("_")) add(frames);
    }
  }
  for (const key of PROJECTILE_KEYS) {
    const slot = record[key];
    if (slot && typeof slot === "object") {
      add((slot as { texture?: unknown }).texture);
    }
  }
  const deza = record.dezaemon as
    | { partArt?: unknown; coreArt?: unknown }
    | undefined;
  if (deza && typeof deza === "object") {
    if (deza.partArt && typeof deza.partArt === "object") {
      for (const frames of Object.values(deza.partArt)) add(frames);
    }
    add(deza.coreArt);
  }
  add(record.texture);

  // stageBgEnd names art the same way, in either of its spellings.
  const bg = record.stageBgEnd;
  if (typeof bg === "string") names.add(bg);
  else if (bg && typeof bg === "object") {
    const frame = (bg as { frame?: unknown }).frame;
    if (typeof frame === "string") names.add(frame);
  }

  // The boss's own danger balloon (game.bundle.js bossDangerBalloon): a bare
  // list of frames, or {frames, x, y}.
  const balloon = record.dangerBalloon;
  add(
    Array.isArray(balloon)
      ? balloon
      : (balloon as { frames?: unknown } | undefined)?.frames,
  );

  // A boss's overlay (game.bundle.js armBossOverlay): the parts laid over it,
  // and the glow cut for each of its frames.
  const overlay = record.overlay as
    | { parts?: unknown; glow?: { frames?: unknown } }
    | undefined;
  if (overlay && typeof overlay === "object") {
    if (Array.isArray(overlay.parts)) {
      for (const part of overlay.parts) {
        add((part as { frame?: unknown } | null)?.frame);
      }
    }
    const glow = overlay.glow?.frames;
    if (glow && typeof glow === "object") {
      for (const frame of Object.values(glow)) add(frame);
    }
  }

  // A boss's second stage (game.bundle.js bossStage2Record) is laid over the
  // record mid-fight: its anim sets, weapon slots and balloon are art the boss
  // needs as much as its own.
  const stage2 = record.stage2;
  if (stage2 && typeof stage2 === "object" && !Array.isArray(stage2)) {
    for (const name of referencedFrames(stage2 as Character)) names.add(name);
  }

  return [...names];
}

/**
 * Rewrite every frame name a record references, in place on a copy.
 *
 * Needed whenever a record moves into a level whose atlas spells the same art
 * differently — `dezaBoss0_0.png` where the catalog says `.gif`. The runtime's
 * own resolveFrame() would find the sibling at draw time, but it never gets
 * the chance: mergeRecipe's repair pass runs first and tests
 * `atlasFrames[anim[k][0]]` EXACTLY, so a record naming the other extension
 * looks like art that did not travel and is reverted to the base game's boss
 * wholesale. Renaming up front is the only thing that survives that pass.
 *
 * Walks exactly what referencedFrames() collects, so the two cannot drift.
 */
export function remapFrames(
  record: Character,
  rename: Record<string, string>,
): Character {
  const next = deepClone(record);
  const one = (name: unknown) =>
    typeof name === "string" && rename[name] ? rename[name] : name;
  const list = (value: unknown) =>
    Array.isArray(value) ? value.map(one) : value;

  const anim = next.anim;
  if (anim && typeof anim === "object") {
    for (const [key, frames] of Object.entries(anim)) {
      if (!key.startsWith("_")) {
        (anim as Record<string, unknown>)[key] = list(frames);
      }
    }
  }
  for (const key of PROJECTILE_KEYS) {
    const slot = next[key] as { texture?: unknown } | undefined;
    if (slot && typeof slot === "object" && slot.texture !== undefined) {
      slot.texture = list(slot.texture);
    }
  }
  const deza = next.dezaemon as
    | { partArt?: Record<string, unknown>; coreArt?: unknown }
    | undefined;
  if (deza && typeof deza === "object") {
    if (deza.partArt && typeof deza.partArt === "object") {
      for (const [k, frames] of Object.entries(deza.partArt)) {
        deza.partArt[k] = list(frames);
      }
    }
    if (deza.coreArt !== undefined) deza.coreArt = list(deza.coreArt);
  }
  if (next.texture !== undefined) next.texture = list(next.texture);

  const bg = next.stageBgEnd;
  if (typeof bg === "string") next.stageBgEnd = one(bg);
  else if (bg && typeof bg === "object") {
    const o = bg as { frame?: unknown };
    if (o.frame !== undefined) o.frame = one(o.frame);
  }

  const balloon = next.dangerBalloon;
  if (Array.isArray(balloon)) next.dangerBalloon = list(balloon);
  else if (balloon && typeof balloon === "object") {
    const o = balloon as { frames?: unknown };
    if (o.frames !== undefined) o.frames = list(o.frames);
  }

  // The glow is keyed by the boss's own frames, which are renamed too.
  const overlay = next.overlay as
    | { parts?: unknown; glow?: { frames?: Record<string, unknown> } }
    | undefined;
  if (overlay && typeof overlay === "object") {
    if (Array.isArray(overlay.parts)) {
      for (const part of overlay.parts) {
        if (part && typeof part === "object" && "frame" in part) {
          part.frame = one(part.frame);
        }
      }
    }
    const glow = overlay.glow;
    if (glow?.frames && typeof glow.frames === "object") {
      glow.frames = Object.fromEntries(
        Object.entries(glow.frames).map(([k, v]) => [one(k) as string, one(v)]),
      );
    }
  }

  const stage2 = next.stage2;
  if (stage2 && typeof stage2 === "object" && !Array.isArray(stage2)) {
    next.stage2 = remapFrames(stage2 as Character, rename);
  }
  return next;
}

/**
 * List the characters in the catalog: shmupX's own, shmupX/characters. The
 * root-level characters/* is cmg's catalog, and unlike source art (art.ts) a
 * character is never borrowed from it — what these tools clone, edit and
 * place is shmupX's library.
 */
export function listCharacters(): Promise<string[]> {
  return listKeys("characters");
}

/** Read one character record, from shmupX's catalog only. */
export async function getCharacter(name: string): Promise<Character> {
  assertSafeKey("Character name", name);
  const record = await get<Character>(`characters/${name}`);
  if (!record || typeof record !== "object") {
    throw new ArtError(
      `No character at ${
        dbPath(`characters/${name}`)
      } (shmupX's catalog; cmg's root-level characters are not read). ` +
        `Use shmupx_list_characters to see valid names.`,
    );
  }
  return record;
}

/**
 * Assign the name a newly pulled-in frame will carry in the packed atlas.
 *
 * Source names are kept — they are what an author recognises, and a level's
 * sheet is stacked over game_asset rather than merged into the shipped frame
 * namespace, so "hadouken1" cannot collide with another level's art. Within
 * one sheet a collision is real, and there the source atlas disambiguates.
 */
function uniqueName(resolved: ResolvedFrame, taken: Set<string>): string {
  const preferred = resolved.name;
  if (!taken.has(preferred)) return preferred;
  const scope = resolved.scope;
  let candidate = `${scope}_${preferred}`;
  let n = 2;
  while (taken.has(candidate)) candidate = `${scope}${n++}_${preferred}`;
  return candidate;
}

function isUploadRef(ref: FrameRef): boolean {
  return typeof ref === "object" && ref !== null && "upload" in ref;
}

/**
 * The cuts a request's build would make: its distinct upload refs, by the
 * same JSON key pull() dedupes on, wherever in the request they appear.
 */
function uploadCuts(req: CreateRequest): number {
  const refs: FrameRef[] = [
    ...Object.values(req.anim ?? {}).flat(),
    ...Object.values(req.projectiles ?? {}).flatMap((p) => p?.texture ?? []),
    ...(req.stageBgEnd ? [req.stageBgEnd] : []),
  ];
  return new Set(refs.filter(isUploadRef).map((ref) => JSON.stringify(ref)))
    .size;
}

function tooManyCuts(): ArtError {
  return new ArtError(
    `This build cuts more than ${MAX_UPLOAD_FRAMES} frames out of the ` +
      `attached pictures; one build cuts at most ${MAX_UPLOAD_FRAMES}. ` +
      "Reuse frames: write the identical ref (same fields, same `as`) " +
      "wherever the same picture goes — it is cut and packed once — " +
      "instead of a new `as` or maxSize for every state or frame.",
  );
}

/**
 * Build a character record and the atlas that serves it.
 *
 * Nothing is written: the caller decides whether to publish. That split is
 * deliberate — the catalog is open-write and shared with spriteX and both
 * editors, so a dry run has to be the default and the only way to reach a
 * write is to ask for one.
 *
 * `options.uploads` are the pictures attached to the request being served,
 * handed to every resolveFrame below so an `{upload: n}` ref anywhere in the
 * request — an anim state, a projectile, the backdrop — can be cut. The refs
 * stay plain data, so the JSON dedupe key still packs a picture asked for
 * twice once, and that is also what MAX_UPLOAD_FRAMES counts: distinct
 * upload refs, each a cut, never the places a cut is used.
 */
export async function buildCharacter(
  req: CreateRequest,
  options: FrameContext = {},
): Promise<CreateResult> {
  assertSafeKey("Character name", req.name);
  // Counted up front, before the source is read or anything is cut: counting
  // only as pull() cuts would refuse the seventeenth after the first sixteen
  // had already spent their seconds, for a build that fails anyway. pull()
  // still counts as it cuts, so a ref from anywhere this misses is held to
  // the same limit.
  if (uploadCuts(req) > MAX_UPLOAD_FRAMES) throw tooManyCuts();
  const warnings: string[] = [];

  const source = req.cloneFrom ? await getCharacter(req.cloneFrom) : {};
  const record: Character = deepClone(source);
  record.name = req.name;

  // Resolved art, keyed by the reference that produced it so the same frame
  // asked for twice is packed once.
  const byRef = new Map<string, ResolvedFrame>();
  const taken = new Set<string>();
  const pulled: ResolvedFrame[] = [];
  let cuts = 0;

  const pull = async (ref: FrameRef): Promise<string> => {
    const key = JSON.stringify(ref);
    const already = byRef.get(key);
    if (already) return already.name;
    // Counted before the cut, so the one over the limit costs nothing.
    if (isUploadRef(ref) && ++cuts > MAX_UPLOAD_FRAMES) throw tooManyCuts();
    const resolved = await resolveFrame(ref, options);
    resolved.name = uniqueName(resolved, taken);
    taken.add(resolved.name);
    byRef.set(key, resolved);
    pulled.push(resolved);
    return resolved.name;
  };

  // --- overrides ---------------------------------------------------------
  if (req.anim) {
    const anim = (record.anim && typeof record.anim === "object"
      ? record.anim
      : {}) as Record<string, unknown>;
    for (const [state, refs] of Object.entries(req.anim)) {
      anim[state] = [];
      for (const ref of refs) {
        (anim[state] as string[]).push(await pull(ref));
      }
    }
    record.anim = anim;
  }

  for (const [slot, override] of Object.entries(req.projectiles ?? {})) {
    if (!(PROJECTILE_KEYS as readonly string[]).includes(slot)) {
      throw new ArtError(
        `"${slot}" is not a projectile slot. One of: ${
          PROJECTILE_KEYS.join(", ")
        }. ` +
          `The main projectile is ${MAIN_PROJECTILE_KEY}.`,
      );
    }
    const existing = record[slot];
    const next = (existing && typeof existing === "object"
      ? deepClone(existing)
      : { damage: 1, hp: 1, score: 0, speed: 2, spgage: 0 }) as Record<
        string,
        unknown
      >;
    if (override.texture) {
      const frames: string[] = [];
      for (const ref of override.texture) {
        frames.push(await pull(ref));
      }
      next.texture = frames;
    }
    for (
      const field of [
        "speed",
        "damage",
        "hp",
        "score",
        "spgage",
        "frameRate",
      ] as const
    ) {
      if (override[field] !== undefined) {
        next[field] = override[field];
      }
    }
    record[slot] = next;
  }

  // stageBgEnd is a bare frame name until it needs to carry an alpha, at which
  // point it becomes the {frame, alpha} object the runtime also accepts. An
  // alpha with no art of its own asks for the shipped backdrop, translucent.
  if (req.stageBgEnd === null) {
    delete record.stageBgEnd;
  } else if (req.stageBgEnd !== undefined) {
    const frame = await pull(req.stageBgEnd);
    record.stageBgEnd = req.stageBgEndAlpha === undefined
      ? frame
      : { frame, alpha: clampAlpha(req.stageBgEndAlpha) };
  } else if (req.stageBgEndAlpha !== undefined) {
    const inherited = record.stageBgEnd;
    const frame = typeof inherited === "string"
      ? inherited
      : (inherited as { frame?: unknown } | undefined)?.frame;
    record.stageBgEnd = typeof frame === "string"
      ? { frame, alpha: clampAlpha(req.stageBgEndAlpha) }
      : { alpha: clampAlpha(req.stageBgEndAlpha) };
  }

  for (const [field, value] of Object.entries(req.stats ?? {})) {
    record[field] = value;
  }

  // --- art the clone brought with it -------------------------------------
  // Whatever the record still names and no override supplied comes out of the
  // source character's own atlas.
  const sourceAtlasName = typeof source.textureKey === "string"
    ? source.textureKey
    : req.cloneFrom ?? null;
  const carried = referencedFrames(record).filter((name) => !taken.has(name));
  const unresolved: string[] = [];

  if (carried.length && sourceAtlasName) {
    const atlas = await loadAtlas(sourceAtlasName).catch((err) => {
      warnings.push(
        `Source atlas atlases/${sourceAtlasName} could not be read (${
          err instanceof Error ? err.message : String(err)
        }); the clone's own frames were not carried over.`,
      );
      return null;
    });
    for (const name of carried) {
      if (!atlas || !atlas.frames[name]) {
        unresolved.push(name);
        continue;
      }
      const resolved = await resolveFrame({
        atlas: sourceAtlasName,
        frame: name,
      }, options);
      taken.add(resolved.name);
      pulled.push(resolved);
    }
  } else {
    unresolved.push(...carried);
  }

  record.textureKey = req.name;

  const { sheet, json } = packFrames(pulled);
  return {
    name: req.name,
    clonedFrom: req.cloneFrom ?? null,
    character: record,
    atlas: {
      json,
      dataUrl: await sheetDataUrl(sheet),
      frameCount: Object.keys(json.frames).length,
      size: { w: sheet.width, h: sheet.height },
    },
    provenance: pulled.map((f) => ({ frame: f.name, source: f.source })),
    unresolved,
    warnings,
  };
}

export interface PublishOptions {
  /**
   * How to spell each frame's key in the stored json, by frame name. Frames
   * not named here are stored under their plain name. An in-place rewrite
   * passes the spellings the atlas already had, so readers that match the
   * raw key keep finding them.
   */
  frameKeys?: Record<string, string>;
  /**
   * The atlas node's ETag from the read this write was computed from. The
   * database then refuses the write if anything else touched the node in
   * between, instead of letting the stale copy win.
   */
  atlasIfMatch?: string | null;
}

/**
 * Publish a built character: the record, and the atlas its textureKey names,
 * both into shmupX's catalog (shmupX/atlases/<name>, shmupX/characters/<name>;
 * rtdb.ts roots every write there). cmg's root-level copies are never written,
 * so a character published here is not in cmg's catalog. The answer names the
 * paths as the database has them.
 *
 * Two writes rather than one multi-path update, because the catalog stores
 * them as siblings of unrelated trees and a PUT to the root would replace far
 * more than this character.
 *
 * Frame keys inside the json STRING are stored plain. Nothing forbids a dot
 * inside a JSON string — that rule is for real database keys, and it is why
 * a level's atlasFrames go through encodeKey — and the level editor's
 * library loader matches a record's plain-dot names against these keys with
 * no decoding, so a dot-encoded key here is a frame the editor cannot find.
 */
export async function publishCharacter(
  result: CreateResult,
  { frameKeys = {}, atlasIfMatch = null }: PublishOptions = {},
): Promise<string[]> {
  const frames: Record<string, unknown> = {};
  for (const [name, rect] of Object.entries(result.atlas.json.frames)) {
    frames[frameKeys[name] ?? name] = rect;
  }
  const atlasRecord = {
    json: JSON.stringify({ ...result.atlas.json, frames }),
    png: result.atlas.dataUrl,
  };
  try {
    await put(`atlases/${result.name}`, atlasRecord, {
      ifMatch: atlasIfMatch,
    });
    await put(`characters/${result.name}`, result.character);
  } finally {
    // Whatever happened, the cache no longer matches the database.
    invalidateAtlas(result.name);
  }
  return [
    dbPath(`atlases/${result.name}`),
    dbPath(`characters/${result.name}`),
  ];
}

/** Publish only a character's record, leaving whatever atlas it names alone. */
export async function publishRecord(
  name: string,
  record: Character,
): Promise<string[]> {
  assertSafeKey("Character name", name);
  await put(`characters/${name}`, record);
  return [dbPath(`characters/${name}`)];
}
