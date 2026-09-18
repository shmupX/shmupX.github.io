// Objects: the catalog's characters addressed the way a person says them —
// "the second boss", "the last one", "the pyramid" — and edited with a few
// dials instead of field names.
//
// The character tools are precise and that is their problem for voice: a
// spoken edit never carries an id, and "make the boss bulkier" has to become
// a record name, a set of frames and some numbers before anything can happen.
// This module is that translation. An object is still exactly a
// characters/<id> record with its art at atlases/<textureKey>; what is added
// is a role read off the record's shape, an ordinal read off the stage number
// in its name, a resolver for the phrase, and three edits — aggression,
// silhouette, palette — defined in terms of what the runtime actually reads
// and what the pixels can bear. Every claim about the runtime below names the
// line in static/games/2028-ai/game.bundle.js it rests on, and
// tests/object_mcp_test.ts pins each one.

import { cut } from "@shmupx/shmup-harbor/raster";
import type { Raster } from "@shmupx/shmup-harbor/png";
import {
  ArtError,
  frameMap,
  type FrameRect,
  invalidateAtlas,
  loadAtlas,
  loadAtlasJson,
  type LoadedAtlas,
  packFrames,
  type ResolvedFrame,
  sheetDataUrl,
  storedFrameKey,
} from "./art.ts";
import {
  assertSafeKey,
  databaseUrl,
  decodeFrameName,
  get,
  listKeys,
} from "./rtdb.ts";
import {
  type Character,
  type CreateResult,
  getCharacter,
  PROJECTILE_KEYS,
  publishCharacter,
  publishRecord,
  referencedFrames,
} from "./character.ts";
import {
  dominantColors,
  type PaletteEdit,
  paletteEditIsEmpty,
  parseColor,
  pngBase64,
  recolor,
  scaleNearest,
} from "./pixels.ts";

/** ─── roles and order ──────────────────────────────────────────────────── */

export const ROLES = ["boss", "enemy", "player", "projectile", "art"] as const;
export type Role = typeof ROLES[number];

const SUFFIXED_SLOTS = PROJECTILE_KEYS.filter((k) => /[ABC]$/.test(k));

const has = (record: Character, key: string) =>
  record[key] !== undefined && record[key] !== null;

/**
 * What kind of thing a record is, read off its shape.
 *
 * The catalog is one flat tree, and it holds bosses next to zako, a player
 * (dukeNukem), a bullet and a backdrop. None of them say what they are, but
 * each shape is distinctive: a player carries maxHp and its shoot tables; a
 * boss arms the Dezaemon engine (dezaemon.boss), has animation states, fires
 * from a suffixed slot, or is simply too tough to be a zako; a bullet has a
 * speed and no hp; a backdrop has nothing but art. A role is a hint for the
 * resolver, never a gate — every tool takes any id.
 */
export function classify(record: Character): Role {
  if (
    has(record, "maxHp") || has(record, "shootNormal") ||
    has(record, "defaultShootName")
  ) return "player";
  const deza = record.dezaemon as
    | { boss?: unknown; record?: unknown }
    | undefined;
  const dezaObj = deza && typeof deza === "object" ? deza : null;
  const hp = record.hp;
  if (
    (dezaObj && !!dezaObj.boss) ||
    (record.anim !== null && typeof record.anim === "object") ||
    SUFFIXED_SLOTS.some((k) => has(record, k)) ||
    (typeof hp === "number" && hp >= 100 &&
      !(dezaObj && dezaObj.record !== undefined))
  ) return "boss";
  if (!has(record, "hp") && !has(record, "interval") && !has(record, "anim")) {
    return typeof record.speed === "number" ? "projectile" : "art";
  }
  return "enemy";
}

/**
 * Does this record carry a Dezaemon zako behaviour block? Such an enemy is
 * driven by the cart's own tables at run time — initEnemyBehavior
 * (game.bundle.js:9033) hands it to updateEnemyBehavior, whose fire executor
 * takes its cadence from `dezaemon.behavior.fire` (zakoReload, 4472) and its
 * shot speed and art from the level's bullet bank (dezaVolley, 5155-5187).
 * The record's own `interval`, and its slot's `speed` and `texture`, are
 * never consulted; only the slot's `damage` is.
 */
export function hasDezaBehavior(record: Character): boolean {
  const deza = record.dezaemon as { behavior?: unknown } | undefined;
  return !!deza && typeof deza === "object" && !!deza.behavior &&
    typeof deza.behavior === "object";
}

/**
 * Does the runtime read this record's `interval` as a fire cadence?
 *
 * Only for a stock zako: `enemy.getData("interval") || 300` (10979) is the
 * ticks between its shots. A Dezaemon zako fires on its behaviour table, and
 * a boss on its pattern script — bossAdd copies `bossData.interval` into
 * scene.bossInterval (12082) and nothing ever reads it back.
 */
export function cadenceIsRead(record: Character, role: Role): boolean {
  return role === "enemy" && !hasDezaBehavior(record);
}

/**
 * Does the runtime read this record's projectile slots for shot speed and
 * art? Every bullet spawner does — spawnDezaBossBullet (5731), the stock
 * zako's spawnEnemyBullet (9145), the stock boss patterns (12427) — except
 * for a Dezaemon zako, whose dezaVolley overwrites both from the level's
 * bullet bank after the spawn. Damage survives for everyone.
 */
export function shotsAreRead(record: Character, role: Role): boolean {
  return !(role === "enemy" && hasDezaBehavior(record));
}

/**
 * The stage a boss-family name carries: dezaBoss4_ramsie is stage 4,
 * dezaBoss1_bulky is a stage-1 variant, hadoukenBoss has none. Anchored so a
 * digit elsewhere in a name — dezaKissBullet0_0_gif — is not a stage.
 */
export function stageOf(id: string): number | null {
  const m = /^[a-z]*boss[_-]?(\d+)(?:[_-].*)?$/i.exec(id);
  return m ? Number(m[1]) : null;
}

/** dezaBoss0, dezaBoss1, dezaBoss3, dezaBoss10 — not 0, 1, 10, 3. */
export function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, "en", { numeric: true, sensitivity: "base" }) ||
    (a < b ? -1 : a > b ? 1 : 0);
}

const ORDINAL_WORDS = [
  "first",
  "second",
  "third",
  "fourth",
  "fifth",
  "sixth",
  "seventh",
  "eighth",
  "ninth",
  "tenth",
];

export function ordinalWord(n: number): string {
  return ORDINAL_WORDS[n - 1] ?? `${n}th`;
}

/** ─── frames a record names ────────────────────────────────────────────── */

const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : typeof value === "string"
    ? [value]
    : [];

/** Animation states a record carries. "idle" is implied by a bare `texture`. */
export function statesOf(record: Character): string[] {
  const anim = record.anim as Record<string, unknown> | undefined;
  const keys = anim && typeof anim === "object"
    ? Object.keys(anim).filter((k) =>
      !k.startsWith("_") && strings(anim[k]).length > 0
    )
    : [];
  if (!keys.includes("idle") && strings(record.texture).length) {
    keys.unshift("idle");
  }
  return keys;
}

/**
 * The slot that fires as "the main projectile", in the runtime's own order:
 * bossAdd reads bulletDataA || projectileDataA first, the unsuffixed pair
 * after that, and the Dezaemon path's B and C behind them.
 */
export function mainProjectileSlot(record: Character): string | null {
  for (
    const key of [
      "bulletDataA",
      "projectileDataA",
      "bulletData",
      "projectileData",
      "bulletDataB",
      "projectileDataB",
      "bulletDataC",
      "projectileDataC",
    ]
  ) {
    const slot = record[key] as { texture?: unknown } | undefined;
    if (slot && typeof slot === "object" && strings(slot.texture).length) {
      return key;
    }
  }
  return null;
}

/** The frame stageBgEnd names, in either of its spellings. */
export function backdropFrame(record: Character): string | null {
  const bg = record.stageBgEnd;
  if (typeof bg === "string") return bg;
  if (bg && typeof bg === "object") {
    const frame = (bg as { frame?: unknown }).frame;
    if (typeof frame === "string") return frame;
  }
  return null;
}

/** The frames a Dezaemon boss's parts — its turrets and limbs — draw with. */
export function partFrames(record: Character): string[] {
  const deza = record.dezaemon as { partArt?: unknown } | undefined;
  const partArt = deza && typeof deza === "object" ? deza.partArt : null;
  if (!partArt || typeof partArt !== "object") return [];
  const out: string[] = [];
  for (const frames of Object.values(partArt)) out.push(...strings(frames));
  return out;
}

/**
 * The frame names behind one preview state. "idle" falls back to the bare
 * `texture` list exactly as bossAdd does (`anim.idle || texture`, 12096), so
 * the frame this draws is the frame the runtime would spawn the object with.
 */
export function framesFor(record: Character, state: string): string[] {
  const label = typeof record.name === "string" ? record.name : "this object";
  if (state === "projectile") {
    const slot = mainProjectileSlot(record);
    if (!slot) {
      throw new ArtError(`${label} has no projectile slot with frames.`);
    }
    return strings((record[slot] as { texture: unknown }).texture);
  }
  if (state === "backdrop") {
    const frame = backdropFrame(record);
    if (!frame) throw new ArtError(`${label} has no stageBgEnd backdrop.`);
    return [frame];
  }
  const anim = record.anim as Record<string, unknown> | undefined;
  const fromAnim = anim && typeof anim === "object" && !state.startsWith("_")
    ? strings(anim[state])
    : [];
  if (fromAnim.length) return fromAnim;
  if (state === "idle") {
    const texture = strings(record.texture);
    if (texture.length) return texture;
  }
  const available = [
    ...statesOf(record),
    ...(mainProjectileSlot(record) ? ["projectile"] : []),
    ...(backdropFrame(record) ? ["backdrop"] : []),
  ];
  throw new ArtError(
    `${label} has no frames for state "${state}". States: ${
      available.join(", ") || "none"
    }.`,
  );
}

export const EDIT_SCOPES = ["body", "projectiles", "all"] as const;
export type EditScope = typeof EDIT_SCOPES[number];

/**
 * The frames an art edit touches. "body" is everything the record draws as
 * itself — animation states, the bare texture, Dezaemon parts and core — and
 * excludes its bullets and its backdrop, so "make the boss red" does not also
 * turn its shots and the wall behind it red.
 */
export function framesInScope(
  record: Character,
  scope: EditScope,
): Set<string> {
  const all = new Set(referencedFrames(record));
  if (scope === "all") return all;
  const projectiles = new Set<string>();
  for (const key of PROJECTILE_KEYS) {
    const slot = record[key] as { texture?: unknown } | undefined;
    if (slot && typeof slot === "object") {
      for (const frame of strings(slot.texture)) projectiles.add(frame);
    }
  }
  if (scope === "projectiles") return projectiles;
  const backdrop = backdropFrame(record);
  const body = new Set<string>();
  for (const frame of all) {
    if (!projectiles.has(frame) && frame !== backdrop) body.add(frame);
  }
  return body;
}

/** ─── summaries ────────────────────────────────────────────────────────── */

export interface ObjectSummary {
  /** The catalog character name — or, listing a level, its slot ("boss1"). */
  id: string;
  label: string;
  role: Role;
  /**
   * The number a person counts this object by, within its role: a numbered
   * one is its stage + 1 (boss1 is second), the unnumbered follow after the
   * highest stage in natural order. This is exactly the number the resolver
   * accepts, so what the list says is what a phrase gets.
   */
  ordinal: number | null;
  ordinalWord: string | null;
  /** The boss slot the name or the level carries. */
  stage: number | null;
  /** The catalog character behind a level slot; the id itself in the catalog. */
  character: string | null;
  /** Whether `character` is a catalog entry the edit tools can take. */
  inCatalog: boolean;
  textureKey: string | null;
  states: string[];
  projectiles: string[];
  /** Pixel size of the frame the runtime spawns it with. */
  size: { w: number; h: number } | null;
  frames: number;
  hp: number | string | null;
  score: number | null;
  interval: number | null;
}

interface Entry {
  id: string;
  record: Character;
  /** Decoded frame map to size the idle frame from; null when unreadable. */
  frames: Record<string, FrameRect> | null;
  stage: number | null;
  role: Role;
  character: string | null;
  inCatalog: boolean;
}

function lookupRect(
  frames: Record<string, FrameRect>,
  name: string,
): FrameRect | null {
  return frames[name] ?? frames[decodeFrameName(name)] ?? null;
}

function idleSize(entry: Entry): { w: number; h: number } | null {
  if (!entry.frames) return null;
  let names: string[];
  try {
    names = framesFor(entry.record, "idle");
  } catch {
    return null;
  }
  const rect = names[0] ? lookupRect(entry.frames, names[0]) : null;
  return rect ? { w: rect.frame.w, h: rect.frame.h } : null;
}

const numberOrNull = (v: unknown) => typeof v === "number" ? v : null;

function catalogEntry(id: string, record: Character): Entry {
  const role = classify(record);
  return {
    id,
    record,
    frames: null,
    // A stage number means something only on a boss; a bullet saved as
    // dezaBoss1_shot is not the second boss.
    stage: role === "boss" ? stageOf(id) : null,
    role,
    character: id,
    inCatalog: true,
  };
}

function summarize(entry: Entry): ObjectSummary {
  const { id, record } = entry;
  return {
    id,
    label: id,
    role: entry.role,
    ordinal: null,
    ordinalWord: null,
    stage: entry.stage,
    character: entry.character,
    inCatalog: entry.inCatalog,
    textureKey: typeof record.textureKey === "string"
      ? record.textureKey
      : null,
    states: statesOf(record),
    projectiles: PROJECTILE_KEYS.filter((k) => has(record, k)),
    size: idleSize(entry),
    frames: referencedFrames(record).length,
    hp: typeof record.hp === "number" || typeof record.hp === "string"
      ? record.hp
      : null,
    score: numberOrNull(record.score),
    interval: numberOrNull(record.interval),
  };
}

/**
 * Order the objects role by role and give each the number a person counts
 * it by. A numbered member's ordinal is its stage + 1, so boss1 is "second"
 * whether it is read off a level or the catalog and a missing stage is a
 * missing ordinal — a catalog without dezaBoss2 has no third boss. The
 * unnumbered members of a role follow after its highest stage, in natural
 * order. The resolver counts by this same field, so the list and the phrase
 * cannot disagree.
 */
export function numberObjects(objects: ObjectSummary[]): ObjectSummary[] {
  const out: ObjectSummary[] = [];
  for (const role of ROLES) {
    const members = objects.filter((o) => o.role === role);
    const staged = members.filter((o) => o.stage !== null)
      .sort((a, b) => a.stage! - b.stage! || naturalCompare(a.id, b.id));
    const rest = members.filter((o) => o.stage === null)
      .sort((a, b) => naturalCompare(a.id, b.id));
    const maxStage = staged.length ? staged[staged.length - 1].stage! : -1;
    for (const o of staged) {
      o.ordinal = o.stage! + 1;
      o.ordinalWord = ordinalWord(o.ordinal);
    }
    rest.forEach((o, i) => {
      o.ordinal = maxStage + 2 + i;
      o.ordinalWord = ordinalWord(o.ordinal);
    });
    out.push(...staged, ...rest);
  }
  return out;
}

function orderAndNumber(entries: Entry[]): ObjectSummary[] {
  return numberObjects(entries.map(summarize));
}

/** ─── the phrase ───────────────────────────────────────────────────────── */

export interface ParsedQuery {
  ordinal: number | null;
  last: boolean;
  /** A zero-based slot named outright: "slot 2". */
  stage: number | null;
  /** The first role word; any further ones are hints. */
  role: Role | null;
  /** Later role words — "the boss's bullets" names a boss, hinting at shots. */
  hints: Role[];
  /** Words that were none of the above, tried as name fragments. */
  fragments: string[];
}

const ROLE_WORDS: Record<string, Role> = {
  boss: "boss",
  bosses: "boss",
  enemy: "enemy",
  enemies: "enemy",
  zako: "enemy",
  player: "player",
  ship: "player",
  hero: "player",
  bullet: "projectile",
  bullets: "projectile",
  projectile: "projectile",
  projectiles: "projectile",
  shot: "projectile",
  shots: "projectile",
  backdrop: "art",
  background: "art",
  art: "art",
};

const STOP_WORDS = new Set([
  "the",
  "a",
  "an",
  "of",
  "in",
  "on",
  "to",
  "for",
  "that",
  "this",
  "one",
  "object",
  "character",
  "sprite",
  "guy",
  "thing",
  "and",
  "my",
  "our",
  "its",
  "it",
  "make",
  "please",
  "select",
  "pick",
  "show",
  "me",
  "from",
  "with",
]);

/**
 * Read the ordinal, the role and any name fragments out of a phrase.
 *
 * "the second boss" is an ordinal and a role. "boss 2", "stage 2" and
 * "level 2" are the same ordinal — people count from one, and the HUD shows
 * STAGE 1 over the boss in slot boss0 — while "slot 2" names the zero-based
 * key itself. "boss1" with no space is an identifier and stays a fragment;
 * a possessive is dropped so "the boss's bullets" does not grow an "s".
 */
export function parseQuery(text: string): ParsedQuery {
  const parsed: ParsedQuery = {
    ordinal: null,
    last: false,
    stage: null,
    role: null,
    hints: [],
    fragments: [],
  };
  const tokens = text
    .toLowerCase()
    .replace(/[’']s\b/g, "")
    .replace(/[^\p{L}\p{N}#_\-\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const word = ORDINAL_WORDS.indexOf(t);
    if (word >= 0) {
      parsed.ordinal = word + 1;
      continue;
    }
    const nth = /^(\d+)(st|nd|rd|th)$/.exec(t);
    if (nth) {
      parsed.ordinal = Number(nth[1]);
      continue;
    }
    if (t === "last" || t === "final") {
      parsed.last = true;
      continue;
    }
    if (t === "slot") {
      const next = tokens[i + 1];
      if (next && /^\d+$/.test(next)) {
        parsed.stage = Number(next);
        i++;
      }
      continue;
    }
    if (
      t === "stage" || t === "level" || t === "number" || t === "no" ||
      t === "num"
    ) {
      const next = tokens[i + 1];
      if (next && /^\d+$/.test(next)) {
        parsed.ordinal = Number(next);
        i++;
      }
      continue;
    }
    const hash = /^#(\d+)$/.exec(t);
    if (hash) {
      parsed.ordinal = Number(hash[1]);
      continue;
    }
    if (/^\d+$/.test(t)) {
      parsed.ordinal = Number(t);
      continue;
    }
    if (ROLE_WORDS[t]) {
      if (parsed.role === null) parsed.role = ROLE_WORDS[t];
      else if (ROLE_WORDS[t] !== parsed.role) parsed.hints.push(ROLE_WORDS[t]);
      continue;
    }
    if (STOP_WORDS.has(t) || t.length < 2) continue;
    parsed.fragments.push(t);
  }
  return parsed;
}

export interface Resolution {
  /** The one object the phrase names, or null. */
  resolved: ObjectSummary | null;
  /** Everything still in the running — one entry when resolved. */
  candidates: ObjectSummary[];
  ambiguous: boolean;
  /** Fragments that matched nothing and were dropped. */
  ignored: string[];
  /** Role words that did not pick the object but may say what to edit on it. */
  hints: Role[];
  explanation: string;
}

/**
 * Resolve a phrase against a list of objects, deterministically.
 *
 * An exact id wins outright, spaces or not — speech renders "dezaBoss1" as
 * "deza boss 1". Otherwise names come first: each fragment narrows to the
 * objects whose id or character contains it, and a fragment matching nothing
 * ("bulkier") is dropped. A role word then narrows what the names left —
 * unless it would leave nothing, in which case the name is the stronger
 * signal and the role becomes a hint ("akuma's bullets" is akuma, about its
 * shots). The ordinal decides last, by the very `ordinal` the listing shows,
 * so a missing stage resolves to nothing rather than to a guess.
 */
export function resolveQuery(
  query: string,
  objects: ObjectSummary[],
): Resolution {
  const lower = query.trim().toLowerCase();
  const compact = lower.replace(/[\s'’]/g, "");
  const named = (o: ObjectSummary) =>
    [o.id, o.character].some((v) => {
      const n = v?.toLowerCase();
      return n !== undefined && (n === lower || n === compact);
    });
  const exact = objects.filter(named);
  if (exact.length === 1) {
    return {
      resolved: exact[0],
      candidates: exact,
      ambiguous: false,
      ignored: [],
      hints: [],
      explanation: `"${query}" is ${exact[0].id} by name.`,
    };
  }

  const q = parseQuery(query);
  const notes: string[] = [];
  const ignored: string[] = [];
  const hints: Role[] = [...q.hints];
  let candidates = objects.slice();

  for (const fragment of q.fragments) {
    const hit = candidates.filter((o) =>
      o.id.toLowerCase().includes(fragment) ||
      (o.character?.toLowerCase().includes(fragment) ?? false)
    );
    if (hit.length) {
      candidates = hit;
      notes.push(`"${fragment}": ${hit.length}`);
    } else {
      ignored.push(fragment);
    }
  }
  const byName = q.fragments.length > ignored.length;

  if (q.role) {
    const inRole = candidates.filter((o) => o.role === q.role);
    if (inRole.length) {
      candidates = inRole;
      notes.push(`${q.role}: ${inRole.length}`);
    } else if (byName) {
      hints.unshift(q.role);
      notes.push(`"${q.role}" kept as a hint — the name points elsewhere`);
    } else {
      candidates = [];
      notes.push(`${q.role}: 0`);
    }
  }

  const ordinals = candidates
    .map((o) => o.ordinal)
    .filter((n): n is number => n !== null);
  const present = `present: ${
    [...new Set(ordinals)].sort((a, b) => a - b).map(ordinalWord).join(", ") ||
    "none"
  }`;

  if (q.stage !== null) {
    candidates = candidates.filter((o) => o.stage === q.stage);
    notes.push(`slot ${q.stage}: ${candidates.length}`);
  }
  if (q.last) {
    // "The last boss" is the final stage's, not the end of the listing: the
    // highest numbered slot where there are slots, else the highest ordinal.
    const staged = candidates.filter((o) =>
      o.stage !== null && o.ordinal !== null
    );
    const pool = staged.length
      ? staged
      : candidates.filter((o) => o.ordinal !== null);
    const max = pool.length ? Math.max(...pool.map((o) => o.ordinal!)) : null;
    candidates = max === null ? [] : pool.filter((o) => o.ordinal === max);
    notes.push(
      max === null
        ? "last: nothing numbered"
        : `last = ${ordinalWord(max)}${
          staged.length ? " (highest stage)" : ""
        }`,
    );
  } else if (q.ordinal !== null) {
    candidates = candidates.filter((o) => o.ordinal === q.ordinal);
    notes.push(
      `${ordinalWord(q.ordinal)}: ${candidates.length} (${present})`,
    );
  }

  const criteria = q.role !== null || q.stage !== null || q.last ||
    q.ordinal !== null || byName;
  if (!criteria) {
    candidates = [];
    notes.push("nothing in the phrase names an object");
  }

  return {
    resolved: candidates.length === 1 ? candidates[0] : null,
    candidates,
    ambiguous: candidates.length > 1,
    ignored,
    hints,
    explanation: notes.join("; ") +
      (ignored.length ? `; ignored: ${ignored.join(", ")}` : ""),
  };
}

/** ─── listing ──────────────────────────────────────────────────────────── */

export interface ListRequest {
  level?: string;
  role?: Role;
  query?: string;
}

export interface ListResult extends Partial<Resolution> {
  scope: "catalog" | "level";
  level: string | null;
  database: string;
  count: number;
  objects: ObjectSummary[];
  query: string | null;
}

/**
 * A level name as a URL path segment. Level keys are what their authors
 * typed — "Daioh P!", "SummerCarnival'99 LECCA" — so the identifier rule the
 * other trees use is too strict here; what matters is that the segment
 * cannot walk the path or start a query.
 */
export function levelSegment(level: string): string {
  if (
    !level || level.length > 200 ||
    // deno-lint-ignore no-control-regex
    /[/.#$[\]\x00-\x1f\x7f]/.test(level)
  ) {
    throw new ArtError(
      `Level name ${JSON.stringify(level)} is not a valid database key.`,
    );
  }
  return encodeURIComponent(level);
}

async function catalogEntries(): Promise<Entry[]> {
  const all = (await get<Record<string, Character>>("characters")) ?? {};
  const ids = Object.keys(all).filter((id) =>
    all[id] !== null && typeof all[id] === "object"
  );
  const maps = await Promise.all(ids.map(async (id) => {
    const record = all[id];
    const key = typeof record.textureKey === "string" ? record.textureKey : id;
    try {
      return frameMap(await loadAtlasJson(key));
    } catch {
      return null;
    }
  }));
  return ids.map((id, i) => ({
    ...catalogEntry(id, all[id]),
    frames: maps[i],
  }));
}

async function levelEntries(level: string): Promise<Entry[]> {
  const segment = levelSegment(level);
  const [bossData, rawFrames, catalog] = await Promise.all([
    get<Record<string, Character>>(`levels/${segment}/bossData`),
    get<Record<string, FrameRect>>(`levels/${segment}/atlasFrames`),
    listKeys("characters"),
  ]);
  if (!bossData || typeof bossData !== "object") {
    const levels = await listKeys("levels").catch(() => [] as string[]);
    throw new ArtError(
      `levels/${level} has no bossData. The name has to be the exact key under /levels, ` +
        `spaces and punctuation included` +
        (levels.length ? `: ${levels.join(", ")}` : "") +
        `. Omit level to list the catalog instead.`,
    );
  }
  const frames: Record<string, FrameRect> | null = rawFrames
    ? Object.fromEntries(
      Object.entries(rawFrames).map(([k, v]) => [decodeFrameName(k), v]),
    )
    : null;
  const inCatalog = new Set(catalog);
  return Object.entries(bossData)
    .filter(([, record]) => record !== null && typeof record === "object")
    .map(([slot, record]) => {
      const name = typeof record.name === "string" ? record.name : null;
      const m = /^boss(\d+)$/.exec(slot);
      return {
        id: slot,
        record,
        frames,
        stage: m ? Number(m[1]) : null,
        // Everything under bossData is a boss, whatever shape it arrived in.
        role: "boss" as Role,
        character: name,
        inCatalog: name !== null && inCatalog.has(name),
      };
    });
}

/**
 * List the objects a phrase can name, and resolve the phrase if one is given.
 *
 * Without `level` the objects are the catalog's characters — the records the
 * other tools edit. With it they are that level's boss slots, each naming the
 * catalog character it came from when there is one, since that is the id an
 * edit takes: a level's copy is edited by editing the character and placing
 * it again.
 */
export async function listObjects(req: ListRequest = {}): Promise<ListResult> {
  const entries = req.level
    ? await levelEntries(req.level)
    : await catalogEntries();
  let objects = orderAndNumber(entries);
  if (req.role) objects = objects.filter((o) => o.role === req.role);
  const result: ListResult = {
    scope: req.level ? "level" : "catalog",
    level: req.level ?? null,
    database: databaseUrl(),
    count: objects.length,
    objects,
    query: req.query ?? null,
  };
  if (req.query) Object.assign(result, resolveQuery(req.query, objects));
  return result;
}

/** ─── one object ───────────────────────────────────────────────────────── */

async function loadEntry(
  id: string,
): Promise<Entry & { atlas: LoadedAtlas | null }> {
  const record = await getCharacter(id);
  const key = typeof record.textureKey === "string" ? record.textureKey : id;
  const atlas = await loadAtlas(key).catch(() => null);
  return { ...catalogEntry(id, record), frames: atlas?.frames ?? null, atlas };
}

function cutFrame(
  sheet: Raster | null,
  frames: Record<string, FrameRect>,
  name: string,
  where: string,
): Raster {
  const rect = lookupRect(frames, name);
  if (!rect) {
    throw new ArtError(`${where} has no frame "${name}".`);
  }
  if (!sheet) throw new ArtError(`${where} has no png sheet to cut from.`);
  return cut(sheet, rect.frame);
}

/**
 * Everything about one object an edit needs to know first: its summary, the
 * frames each state and slot draws, the numbers each dial would move — and
 * whether the runtime would notice — and the colours it is made of, so
 * "redder" can be judged against what is there.
 */
export async function describeObject(id: string) {
  const entry = await loadEntry(id);
  const { record, atlas, role } = entry;
  // Its ordinal is its place among the whole catalog's objects of that role,
  // which one record cannot know; number the catalog and take its answer.
  const all = (await get<Record<string, Character>>("characters")) ?? {};
  const numbered = orderAndNumber(
    Object.entries(all)
      .filter(([, r]) => r !== null && typeof r === "object")
      .map(([name, r]) => catalogEntry(name, r)),
  ).find((o) => o.id === id);
  const summary = summarize(entry);
  summary.ordinal = numbered?.ordinal ?? null;
  summary.ordinalWord = numbered?.ordinalWord ?? null;

  const referenced = referencedFrames(record);
  const missing = atlas
    ? referenced.filter((f) => !lookupRect(atlas.frames, f))
    : referenced;

  let idle: string[] = [];
  try {
    idle = framesFor(record, "idle");
  } catch {
    // An object with no drawable state still has a record worth reading.
  }
  const colors = atlas?.sheet && idle[0] && lookupRect(atlas.frames, idle[0])
    ? dominantColors(cutFrame(atlas.sheet, atlas.frames, idle[0], id))
    : [];

  const slots = PROJECTILE_KEYS.filter((k) => has(record, k)).map((key) => {
    const slot = record[key] as Record<string, unknown>;
    return {
      slot: key,
      main: key === mainProjectileSlot(record),
      speed: numberOrNull(slot.speed),
      damage: numberOrNull(slot.damage),
      hp: numberOrNull(slot.hp),
      frameRate: numberOrNull(slot.frameRate),
      frames: strings(slot.texture),
    };
  });

  const body = [...framesInScope(record, "body")];
  const parts = partFrames(record);
  const intervalRead = cadenceIsRead(record, role);
  const shotsRead = shotsAreRead(record, role);
  return {
    ...summary,
    referencedFrames: referenced,
    missingFrames: missing,
    stateFrames: Object.fromEntries(
      statesOf(record).map((s) => [s, framesFor(record, s)]),
    ),
    projectileSlots: slots,
    backdrop: backdropFrame(record),
    dials: {
      aggression: {
        interval: numberOrNull(record.interval),
        /** Whether the runtime reads `interval` at all for this object. */
        intervalRead,
        intervalDefault: intervalRead ? ZAKO_INTERVAL_DEFAULT : null,
        /** Whether the slots' speed and art are the runtime's, or the cart's. */
        shotsRead,
        cadence: intervalRead
          ? "interval is the ticks between its shots"
          : role === "enemy"
          ? "the cart's fire table (dezaemon.behavior.fire) owns the cadence; interval is not read"
          : "a boss fires on its pattern script's clock; interval is not read",
        projectiles: slots.map((s) => ({
          slot: s.slot,
          speed: s.speed,
          damage: s.damage,
        })),
      },
      silhouette: {
        frames: body.filter((f) => !parts.includes(f)),
        partsKeptAtSize: parts,
        size: summary.size,
      },
      palette: { frames: body, colors },
    },
    character: record,
  };
}

/** ─── rendering ────────────────────────────────────────────────────────── */

export interface RenderRequest {
  id: string;
  state?: string;
  frame?: number;
  scale?: number;
}

/** The payload the watch bridge reads: bare base64 PNG plus its size. */
export interface PreviewPayload {
  object_id: string;
  label: string;
  png_base64: string;
  width_px: number;
  height_px: number;
  note: string;
}

export interface RenderResult extends PreviewPayload {
  state: string;
  frame: string;
  frameIndex: number;
  frameCount: number;
  states: string[];
  scale: number;
}

async function renderFrame(
  id: string,
  record: Character,
  sheet: Raster | null,
  frames: Record<string, FrameRect>,
  where: string,
  { state = "idle", frame = 0, scale = 1 }: Omit<RenderRequest, "id">,
): Promise<RenderResult> {
  const names = framesFor(record, state);
  if (!Number.isInteger(frame) || frame < 0 || frame >= names.length) {
    throw new ArtError(
      `${id} "${state}" has ${names.length} frame(s); frame ${frame} is out of range.`,
    );
  }
  const factor = Number.isInteger(scale) && scale >= 1 ? scale : 1;
  let raster = cutFrame(sheet, frames, names[frame], where);
  if (factor > 1) raster = scaleNearest(raster, factor);
  return {
    object_id: id,
    label: id,
    png_base64: await pngBase64(raster),
    width_px: raster.width,
    height_px: raster.height,
    note: `${state} ${frame + 1}/${names.length} · ${names[frame]}` +
      (factor > 1 ? ` · ${factor}x` : ""),
    state,
    frame: names[frame],
    frameIndex: frame,
    frameCount: names.length,
    states: [
      ...statesOf(record),
      ...(mainProjectileSlot(record) ? ["projectile"] : []),
      ...(backdropFrame(record) ? ["backdrop"] : []),
    ],
    scale: factor,
  };
}

/** Render one frame of an object as it is in the catalog right now. */
export async function renderObject(req: RenderRequest): Promise<RenderResult> {
  const entry = await loadEntry(req.id);
  if (!entry.atlas) {
    const key = entry.record.textureKey ?? req.id;
    throw new ArtError(
      `${req.id} names atlases/${key}, which could not be read.`,
    );
  }
  return renderFrame(
    req.id,
    entry.record,
    entry.atlas.sheet,
    entry.atlas.frames,
    `atlases/${entry.atlas.name}`,
    req,
  );
}

/** ─── editing ──────────────────────────────────────────────────────────── */

export interface FieldChange {
  field: string;
  before: unknown;
  after: unknown;
}

/** How far a dial at ±1 moves a number: ±50%. */
export const DIAL_RANGE = 0.5;

/** The runtime's zako cadence when the record carries none (game.bundle.js:9016). */
export const ZAKO_INTERVAL_DEFAULT = 300;

const clamp = (v: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, v));

/**
 * Turn the aggression dial on a record, in place.
 *
 * Aggression is whatever about the shots the runtime will actually read for
 * this object, scaled by 1 ± 0.5a:
 *
 *   - every projectile slot's `damage`, for everyone (bullets carry it,
 *     5733 / 9146 / 12432);
 *   - every slot's `speed`, for everyone but a Dezaemon zako, whose
 *     dezaVolley sets the speed from the level's bullet bank after the spawn
 *     (5155-5187);
 *   - `interval`, for a stock zako only — `enemy.getData("interval") || 300`
 *     (10979) is the ticks between its shots. A Dezaemon zako fires on its
 *     behaviour table (zakoReload, 4472) and a boss on its pattern script:
 *     bossAdd copies `bossData.interval` into scene.bossInterval (12082) and
 *     nothing reads it back.
 *
 * What the runtime would not read is left alone and said so, rather than
 * moved into a number that changes nothing visible. hp is not aggression. A
 * stock zako with no interval starts from the runtime's default so the first
 * turn is visible; one below zero means "never fires" and is reported rather
 * than turned into a cadence.
 */
export function applyAggression(
  record: Character,
  amount: number,
  role: Role,
): { changes: FieldChange[]; warnings: string[] } {
  const changes: FieldChange[] = [];
  const warnings: string[] = [];
  const a = clamp(amount, -1, 1);
  if (a === 0) return { changes, warnings };
  const sparser = 1 - DIAL_RANGE * a;
  const harder = 1 + DIAL_RANGE * a;
  const cadence = cadenceIsRead(record, role);
  const shots = shotsAreRead(record, role);

  const current = record.interval;
  if (cadence) {
    if (typeof current === "number" && current < 0) {
      warnings.push(
        `interval ${current} means it never fires; left alone. Set stats.interval to give it a cadence first.`,
      );
    } else {
      const base = typeof current === "number"
        ? current
        : ZAKO_INTERVAL_DEFAULT;
      let next = Math.max(1, Math.round(base * sparser));
      if (next === base && a > 0 && base > 1) next = base - 1;
      if (next === base && a < 0) next = base + 1;
      if (typeof current !== "number") {
        warnings.push(
          `interval was unset — the runtime's default for a zako is ${base}, which is where the dial started from.`,
        );
      }
      if (next !== current) {
        changes.push({
          field: "interval",
          before: current ?? null,
          after: next,
        });
        record.interval = next;
      }
    }
  } else if (typeof current === "number") {
    warnings.push(
      `interval ${current} is left alone: the runtime never reads it for this ${role} — ` +
        (role === "enemy"
          ? "a Dezaemon zako fires on the cart's fire table (dezaemon.behavior.fire)"
          : "a boss fires on its pattern script's clock") +
        " — so aggression moved its shots only.",
    );
  }

  let speedSkipped = false;
  for (const key of PROJECTILE_KEYS) {
    const slot = record[key] as Record<string, unknown> | undefined;
    if (!slot || typeof slot !== "object") continue;
    if (typeof slot.speed === "number") {
      if (shots) {
        const next = Math.max(
          0.1,
          Math.round(slot.speed * harder * 100) / 100,
        );
        if (next !== slot.speed) {
          changes.push({
            field: `${key}.speed`,
            before: slot.speed,
            after: next,
          });
          slot.speed = next;
        }
      } else {
        speedSkipped = true;
      }
    }
    if (typeof slot.damage === "number") {
      const next = Math.max(1, Math.round(slot.damage * harder));
      if (next !== slot.damage) {
        changes.push({
          field: `${key}.damage`,
          before: slot.damage,
          after: next,
        });
        slot.damage = next;
      }
    }
  }
  if (speedSkipped) {
    warnings.push(
      "Shot speed left alone: a Dezaemon zako's shots take their speed and art from the level's " +
        "bullet bank (dezaVolley), not from its own slot; only the slot's damage is its own.",
    );
  }
  if (!changes.length) {
    warnings.push(
      `Nothing for aggression to move on this ${role}: ` +
        (role === "enemy"
          ? "no projectile slot carries a damage to raise."
          : "no projectile slot carries a speed or damage, and its cadence is not a record field. " +
            "Give it a slot with shmupx_create_character."),
    );
  }
  return { changes, warnings };
}

export interface UpdateRequest {
  id: string;
  /** -1..1: shot damage and speed, and a stock zako's fire cadence. */
  aggression?: number;
  /** -1..1: body art resampled to 1 + 0.5 × this — 1 is half again as big. */
  silhouette?: number;
  palette?: PaletteEdit;
  scope?: EditScope;
  /** Exact field values, applied after the dials. */
  stats?: Record<string, number | boolean>;
  /** Write the result under this new name and leave the original untouched. */
  saveAs?: string;
  apply?: boolean;
}

export interface UpdateResult extends PreviewPayload {
  applied: boolean;
  written: string[];
  source: string;
  role: Role;
  changes: FieldChange[];
  art: {
    scope: EditScope;
    scale: number | null;
    palette: PaletteEdit | null;
    /** Frames whose pixels changed. */
    transformed: string[];
    /** Dezaemon part frames the silhouette dial left at their size. */
    partsKeptAtSize: string[];
  };
  atlas: {
    /** The atlas the record will name after this edit. */
    name: string;
    /** How the atlas is (or would be) written: rewritten in place, created new, or not touched. */
    write: "in place" | "new" | "untouched";
    frameCount: number;
    size: { w: number; h: number };
    dataUrlBytes: number;
  };
  unresolved: string[];
  warnings: string[];
}

const deepClone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function describeChanges(
  changes: FieldChange[],
  scale: number | null,
  palette: PaletteEdit | null,
  scaled: number,
  recolored: number,
): string {
  const parts = changes.map((c) => `${c.field} ${c.before}→${c.after}`);
  if (scale !== null && scaled) parts.push(`art ×${scale}`);
  if (palette && recolored) {
    const bits: string[] = [];
    if (palette.toward) {
      bits.push(
        `→ ${palette.toward}${
          palette.amount !== undefined && palette.amount !== 1
            ? ` ${Math.round(palette.amount * 100)}%`
            : ""
        }`,
      );
    }
    if (palette.hue) {
      bits.push(`hue ${palette.hue > 0 ? "+" : ""}${palette.hue}°`);
    }
    if (palette.saturation) {
      bits.push(
        `sat ${palette.saturation > 0 ? "+" : ""}${palette.saturation}`,
      );
    }
    if (palette.lightness) {
      bits.push(
        `light ${palette.lightness > 0 ? "+" : ""}${palette.lightness}`,
      );
    }
    parts.push(bits.join(" "));
  }
  return parts.join(" · ") || "no change";
}

/** The six watch fields, and nothing else, out of a render. */
function previewOf(rendered: PreviewPayload, note: string): PreviewPayload {
  return {
    object_id: rendered.object_id,
    label: rendered.label,
    png_base64: rendered.png_base64,
    width_px: rendered.width_px,
    height_px: rendered.height_px,
    note,
  };
}

/**
 * Edit an object with the dials, and write it back if asked.
 *
 * The record edits are arithmetic on what is there, so a second "more
 * aggressive" compounds on the first. The art edits cut every frame out of
 * the object's atlas, transform the ones in scope, and repack — and what gets
 * written depends on what changed and whose atlas it is:
 *
 *   - Nothing but numbers changed: only the record is written. The atlas is
 *     not touched, whoever owns it.
 *   - Pixels changed on a character whose textureKey is its own name
 *     (everything this server creates, every cart import): the atlas is
 *     rewritten in place with EVERY frame it held, edited or not, under the
 *     key spellings it already had, and conditionally on the ETag it was
 *     read with — so nothing another record names disappears, and a write
 *     that raced spriteX or the editor is refused rather than winning.
 *   - Pixels changed on a character whose textureKey points elsewhere
 *     (dukeNukem's duke_atlas): that sheet is shared with who knows what and
 *     is never touched. The edited frames go to a new atlases/<id> and the
 *     record is repointed, exactly as a freshly created character is laid out.
 *   - `saveAs`: a new record and a new atlas under that name, which must not
 *     already exist; the original is left alone.
 *
 * Nothing is written unless `apply`. That is the contract every write in this
 * server keeps, and it matters more here than elsewhere: a hands-free session
 * spawns a fresh server per utterance, so an edit that is not applied is an
 * edit that never happened by the next sentence — which is the caller's cue
 * to pass apply, not this module's cue to write on its own.
 */
export async function updateObject(req: UpdateRequest): Promise<UpdateResult> {
  assertSafeKey("Object id", req.id);
  if (req.saveAs !== undefined) {
    assertSafeKey("saveAs", req.saveAs);
    if (req.saveAs === req.id) {
      throw new ArtError(
        `saveAs "${req.saveAs}" is the object's own name. Omit saveAs to edit it in place, ` +
          `or pick a new name for a copy.`,
      );
    }
  }
  // A bad colour should fail before any pixel is read, whatever the scope
  // ends up selecting.
  if (req.palette?.toward !== undefined) parseColor(req.palette.toward);

  const source = await getCharacter(req.id);
  const role = classify(source);
  const record = deepClone(source);
  const target = req.saveAs ?? req.id;
  const atlasName = typeof source.textureKey === "string"
    ? source.textureKey
    : req.id;
  const own = atlasName === req.id && !req.saveAs;

  const warnings: string[] = [];
  const changes: FieldChange[] = [];

  if (req.apply && req.saveAs !== undefined) {
    const taken = await get<unknown>(`characters/${target}`);
    if (taken !== null) {
      throw new ArtError(
        `characters/${target} already exists. saveAs writes a NEW character — pick another ` +
          `name, or edit ${target} directly by id.`,
      );
    }
  }
  // A write starts from what the database holds now, not from whatever this
  // process read earlier; the atlas is then written conditionally on the
  // ETag of that fresh read.
  if (req.apply) invalidateAtlas(atlasName);
  const atlas = await loadAtlas(atlasName).catch((err) => {
    warnings.push(
      `atlases/${atlasName} could not be read (${
        err instanceof Error ? err.message : String(err)
      }); every frame the record names is unresolved.`,
    );
    return null;
  });

  // --- the record ----------------------------------------------------------
  if (req.aggression !== undefined) {
    const turned = applyAggression(record, req.aggression, role);
    changes.push(...turned.changes);
    warnings.push(...turned.warnings);
  }
  for (const [field, value] of Object.entries(req.stats ?? {})) {
    if (record[field] !== value) {
      changes.push({ field, before: record[field] ?? null, after: value });
    }
    record[field] = value;
    if (field === "interval" && !cadenceIsRead(record, role)) {
      warnings.push(
        `stats.interval was written, but the runtime never reads a ${role}'s interval` +
          (role === "enemy" ? " when the cart's fire table drives it" : "") +
          "; it changes nothing visible.",
      );
    }
  }

  // --- the art -------------------------------------------------------------
  const scope = req.scope ?? "body";
  const selected = new Set(
    [...framesInScope(record, scope)].map(decodeFrameName),
  );
  const parts = new Set(partFrames(record).map(decodeFrameName));
  const factor = req.silhouette !== undefined
    ? 1 + DIAL_RANGE * clamp(req.silhouette, -1, 1)
    : 1;
  const palette = req.palette && !paletteEditIsEmpty(req.palette)
    ? req.palette
    : null;
  const editingArt = factor !== 1 || palette !== null;
  if (
    editingArt && scope !== "body" && role === "enemy" &&
    hasDezaBehavior(record)
  ) {
    warnings.push(
      "This enemy's shots are drawn from the level's bullet bank (dezaemon.behavior.fire), " +
        "not from its slot's texture, so an edit to its projectile frames will not be seen in play.",
    );
  }

  const referenced = referencedFrames(record).map(decodeFrameName);
  const wanted = atlas
    ? [
      ...new Set(
        own ? [...Object.keys(atlas.frames), ...referenced] : referenced,
      ),
    ]
    : [];
  const pulled: ResolvedFrame[] = [];
  const scaled: string[] = [];
  const recolored: string[] = [];
  const partsKept: string[] = [];
  const unresolved: string[] = atlas ? [] : [...new Set(referenced)];
  for (const name of wanted) {
    const rect = atlas ? lookupRect(atlas.frames, name) : null;
    if (!rect) {
      unresolved.push(name);
      continue;
    }
    if (!atlas!.sheet) {
      throw new ArtError(`atlases/${atlasName} has no png sheet to cut from.`);
    }
    let raster = cut(atlas!.sheet, rect.frame);
    if (editingArt && selected.has(name)) {
      if (factor !== 1) {
        // A Dezaemon boss's parts sit at the cart's fixed offsets from the
        // core, so scaling them only grows turrets in place; the core is
        // the body the dial means.
        if (parts.has(name)) partsKept.push(name);
        else {
          raster = scaleNearest(raster, factor);
          scaled.push(name);
        }
      }
      if (palette) {
        raster = recolor(raster, palette);
        recolored.push(name);
      }
    }
    pulled.push({
      name,
      raster,
      source: `atlases/${atlasName}#${name}`,
      scope: atlasName,
    });
  }
  const transformed = [...new Set([...scaled, ...recolored])];
  if (editingArt && !transformed.length) {
    warnings.push(`Scope "${scope}" selected no frames; the art is unchanged.`);
  }
  if (partsKept.length) {
    warnings.push(
      `${partsKept.length} Dezaemon part frame(s) kept at their size — the runtime anchors parts ` +
        `at the cart's fixed offsets from the core, so only the core was resampled.`,
    );
  }

  // --- where the atlas goes ------------------------------------------------
  const artChanged = transformed.length > 0;
  const forking = !own && (artChanged || req.saveAs !== undefined);
  const atlasWrite: UpdateResult["atlas"]["write"] = own && artChanged
    ? "in place"
    : forking
    ? "new"
    : "untouched";
  if (atlasWrite === "new" && req.saveAs === undefined) {
    warnings.push(
      `textureKey "${atlasName}" is an atlas other records may share, so it is left alone: ` +
        `the edited art is packed into atlases/${target} and the record now points there.`,
    );
  }
  record.name = target;
  record.textureKey = atlasWrite === "untouched" ? atlasName : target;

  const { sheet, json } = packFrames(pulled);
  const built: CreateResult = {
    name: target,
    clonedFrom: req.saveAs ? req.id : null,
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

  // --- the write -----------------------------------------------------------
  let written: string[] = [];
  if (req.apply) {
    if (unresolved.length) {
      throw new ArtError(
        `Refusing to write "${target}": ${unresolved.length} frame name(s) have no pixels ` +
          `behind them — ${
            unresolved.join(", ")
          }. The runtime filters unknown frames ` +
          `out silently, so this would publish an object that renders wrong with no error ` +
          `anywhere. Supply those frames with shmupx_create_character, or drop the fields ` +
          `that name them.`,
      );
    }
    if (atlasWrite !== "untouched") {
      // In place, every frame keeps the key spelling it had (bar the
      // one-dot-leader this server once wrote, which nothing else reads).
      const frameKeys: Record<string, string> = {};
      if (atlasWrite === "in place" && atlas) {
        for (const [name, stored] of Object.entries(atlas.storedKeys)) {
          frameKeys[name] = storedFrameKey(stored);
        }
      }
      written = await publishCharacter(built, {
        frameKeys,
        atlasIfMatch: atlasWrite === "in place" ? atlas?.etag ?? null : null,
      });
    } else if (changes.length) {
      written = await publishRecord(target, record);
    } else {
      warnings.push("Nothing changed, so nothing was written.");
    }
  }

  // --- the picture ---------------------------------------------------------
  // The watch shows one frame; make it the one the edit touched.
  const previewState = scope === "projectiles" ? "projectile" : "idle";
  const scale = factor !== 1 ? Math.round(factor * 100) / 100 : null;
  const note = describeChanges(
    changes,
    scale,
    palette,
    scaled.length,
    recolored.length,
  );
  let preview: PreviewPayload;
  try {
    preview = previewOf(
      await renderFrame(
        target,
        record,
        sheet,
        json.frames,
        `the repacked atlas for ${target}`,
        { state: previewState },
      ),
      note,
    );
  } catch (err) {
    warnings.push(
      `No preview: ${err instanceof Error ? err.message : String(err)}`,
    );
    preview = {
      object_id: target,
      label: target,
      png_base64: "",
      width_px: 0,
      height_px: 0,
      note,
    };
  }

  return {
    ...preview,
    applied: written.length > 0,
    written,
    source: req.id,
    role,
    changes,
    art: { scope, scale, palette, transformed, partsKeptAtSize: partsKept },
    atlas: {
      name: atlasWrite === "untouched" ? atlasName : target,
      write: atlasWrite,
      frameCount: built.atlas.frameCount,
      size: built.atlas.size,
      dataUrlBytes: built.atlas.dataUrl.length,
    },
    unresolved,
    warnings,
  };
}
