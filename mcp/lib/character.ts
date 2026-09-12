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
  encodeFrameMap,
  type FrameRef,
  loadAtlas,
  packFrames,
  type ResolvedFrame,
  resolveFrame,
  sheetDataUrl,
} from "./art.ts";
import { assertSafeKey, get, listKeys, put } from "./rtdb.ts";

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
  return next;
}

/** List the characters in the catalog. */
export function listCharacters(): Promise<string[]> {
  return listKeys("characters");
}

/** Read one character record. */
export async function getCharacter(name: string): Promise<Character> {
  assertSafeKey("Character name", name);
  const record = await get<Character>(`characters/${name}`);
  if (!record || typeof record !== "object") {
    throw new ArtError(
      `No character at characters/${name}. Use shmupx_list_characters to see valid names.`,
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

/**
 * Build a character record and the atlas that serves it.
 *
 * Nothing is written: the caller decides whether to publish. That split is
 * deliberate — the catalog is open-write and shared with spriteX and both
 * editors, so a dry run has to be the default and the only way to reach a
 * write is to ask for one.
 */
export async function buildCharacter(
  req: CreateRequest,
): Promise<CreateResult> {
  assertSafeKey("Character name", req.name);
  const warnings: string[] = [];

  const source = req.cloneFrom ? await getCharacter(req.cloneFrom) : {};
  const record: Character = deepClone(source);
  record.name = req.name;

  // Resolved art, keyed by the reference that produced it so the same frame
  // asked for twice is packed once.
  const byRef = new Map<string, ResolvedFrame>();
  const taken = new Set<string>();
  const pulled: ResolvedFrame[] = [];

  const pull = async (ref: FrameRef): Promise<string> => {
    const key = JSON.stringify(ref);
    const already = byRef.get(key);
    if (already) return already.name;
    const resolved = await resolveFrame(ref);
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
      });
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

/**
 * Publish a built character: the record, and the atlas its textureKey names.
 *
 * Two writes rather than one multi-path update, because the catalog stores
 * them as siblings of unrelated trees and a PUT to the root would replace far
 * more than this character.
 */
export async function publishCharacter(
  result: CreateResult,
): Promise<string[]> {
  const atlasRecord = {
    json: JSON.stringify({
      ...result.atlas.json,
      frames: encodeFrameMap(result.atlas.json.frames),
    }),
    png: result.atlas.dataUrl,
  };
  await put(`atlases/${result.name}`, atlasRecord);
  await put(`characters/${result.name}`, result.character);
  return [`atlases/${result.name}`, `characters/${result.name}`];
}
