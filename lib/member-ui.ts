// What a member pack may say about the launcher's own screen, and how it is
// read.
//
// A member pack carries files the Steam build left out (lib/member-content.ts).
// Some of those files are a whole console: the Nintendo Switch pack holds the
// player page, its emulator core, the keys and the cartridges, and none of it
// is any use without a tile in the launcher's strip to open it from. So a
// pack's member.json may carry `ui`: the strip sections it adds, each in the
// shape of a static/emulators.json core entry — which is what the dashboard
// already renders for an installed emulator. The dashboard reads them off
// /api/members with the rest of the pack and adds the sections the moment a
// pack is imported, with no rebuild, and with nothing in the launcher that
// knows the console by name (svelte-src/Dashboard.svelte, packSections).
//
// Read, never trusted. readMemberUi keeps only the fields below, only as
// strings of a sane length, and only sections whose player — and shelf
// manifest, and tile icon — the pack itself carries: a pack's UI can open what
// the pack brought and nothing else, so no pack can put a tile in the strip
// that opens one of the launcher's own pages, or another pack's. A
// declaration that does not read is dropped, never refused: the pack's files
// still serve. The rule that writes a pack (lib/member-build.ts) reads its
// own declaration the same way, so a pack never carries a section it cannot
// honour.

/** One strip section a pack adds: the shape of a static/emulators.json core. */
export interface MemberSection {
  /** A slug. The dashboard keys the section's cursor and shelf on it, and a catalogue core of the same id is this section's. */
  id: string;
  /** The strip tile's label. */
  name: string;
  /** The type-mark in the tile's glass disc, when the section has no icon. */
  mark: string;
  /** The section header. */
  title: string;
  /** The disc panel's TYPE readout. */
  metaType: string;
  /** The disc panel's DATE readout. */
  date: string;
  /** The first half of the credits line in the strip's header. */
  coreA: string;
  /** The second half. */
  coreB: string;
  /** The player page, a URL path the pack carries. A shelf row opens it with ?rom=<file>. */
  player: string;
  /**
   * The shelf: a JSON list of `{ file, name, size, date }` rows the pack
   * carries (scripts/build-switch-manifest.ts writes the Switch's). Without
   * one the section has only what the picker brings.
   */
  manifest?: string;
  /** The tile's icon, a URL path the pack carries. */
  icon?: string;
  /**
   * The player needs a cross-origin-isolated document (SharedArrayBuffer),
   * which only a top-level page gets, so a row leaves the launcher's frame
   * the way a PS2 disc does.
   */
  isolated?: boolean;
  /**
   * A bring-your-own picker: the file types it takes, and the label of the
   * header button that opens it. The picked file reaches the player through
   * the BYO handoff — parked in IndexedDB, database BYO_DATABASE, object
   * store BYO_STORE, key BYO_KEY, and the player opened with ?byo=1 — because
   * an isolated player is a top-level page and no File can be posted into
   * it. static/switch/play.html reads that handoff.
   */
  picker?: { accept: string; multiple?: boolean; label?: string };
  /**
   * The empty shelf's note: a title, the sentence around `path` (set in
   * code), the picker button's label, and hint lines of plain text and
   * `{ code }` tokens.
   */
  byod?: {
    title: string;
    pre: string;
    path: string;
    post: string;
    btn: string;
    hint: Array<Array<string | { code: string }>>;
  };
}

export interface MemberUi {
  sections: MemberSection[];
}

/** The BYO handoff: where a picked file waits for an isolated player (see MemberSection.picker). */
export const BYO_DATABASE = "shmupx-byo";
export const BYO_STORE = "files";
export const BYO_KEY = "file";

const MAX_SECTIONS = 8;
const MAX_HINT_LINES = 6;
const SLUG = /^[a-z0-9][a-z0-9-]{0,31}$/;
/** A URL path as a pack's file list spells it: decoded, one leading slash, no query. */
const URL_PATH = /^\/[^?#]*$/;

function text(v: unknown, max: number): string | null {
  return typeof v === "string" && v.length > 0 && v.length <= max ? v : null;
}

function carried(
  v: unknown,
  carries: (path: string) => boolean,
): string | null {
  return typeof v === "string" && v.length <= 512 && URL_PATH.test(v) &&
      !v.split("/").includes("..") && carries(v)
    ? v
    : null;
}

function readPicker(raw: unknown): MemberSection["picker"] | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const accept = text(r.accept, 200);
  if (!accept) return null;
  const picker: NonNullable<MemberSection["picker"]> = { accept };
  if (r.multiple === true) picker.multiple = true;
  const label = text(r.label, 40);
  if (label) picker.label = label;
  return picker;
}

type HintLines = Array<Array<string | { code: string }>>;

function readHint(raw: unknown): HintLines {
  const lines: HintLines = [];
  if (!Array.isArray(raw)) return lines;
  for (const line of raw.slice(0, MAX_HINT_LINES)) {
    if (!Array.isArray(line)) continue;
    const tokens: Array<string | { code: string }> = [];
    for (const tok of line) {
      if (typeof tok === "string") {
        if (tok.length <= 300) tokens.push(tok);
      } else if (tok && typeof tok === "object") {
        const code = text((tok as { code?: unknown }).code, 120);
        if (code) tokens.push({ code });
      }
    }
    if (tokens.length) lines.push(tokens);
  }
  return lines;
}

function readByod(raw: unknown): MemberSection["byod"] | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const title = text(r.title, 80);
  const btn = text(r.btn, 40);
  if (!title || !btn) return null;
  return {
    title,
    pre: text(r.pre, 300) ?? "",
    path: text(r.path, 120) ?? "",
    post: text(r.post, 300) ?? "",
    btn,
    hint: readHint(r.hint),
  };
}

function readSection(
  raw: unknown,
  carries: (path: string) => boolean,
): MemberSection | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === "string" && SLUG.test(r.id) ? r.id : null;
  const name = text(r.name, 40);
  const mark = text(r.mark, 6);
  const title = text(r.title, 60);
  const metaType = text(r.metaType, 40);
  const date = text(r.date, 12);
  const coreA = text(r.coreA, 60);
  const coreB = text(r.coreB, 60);
  const player = carried(r.player, carries);
  if (
    !id || !name || !mark || !title || !metaType || !date || !coreA ||
    !coreB || !player
  ) return null;
  const s: MemberSection = {
    id,
    name,
    mark,
    title,
    metaType,
    date,
    coreA,
    coreB,
    player,
  };
  const manifest = carried(r.manifest, carries);
  if (manifest) s.manifest = manifest;
  const icon = carried(r.icon, carries);
  if (icon) s.icon = icon;
  if (r.isolated === true) s.isolated = true;
  const picker = readPicker(r.picker);
  if (picker) s.picker = picker;
  const byod = readByod(r.byod);
  if (byod) s.byod = byod;
  return s;
}

/**
 * The UI a pack declares, as far as it reads: `raw` is member.json's `ui`,
 * and `carries` says whether the pack holds a URL path. Sections that do
 * not read are left out, and null means the pack adds nothing.
 */
export function readMemberUi(
  raw: unknown,
  carries: (path: string) => boolean,
): MemberUi | null {
  if (!raw || typeof raw !== "object") return null;
  const list = (raw as { sections?: unknown }).sections;
  if (!Array.isArray(list)) return null;
  const sections: MemberSection[] = [];
  const seen = new Set<string>();
  for (const item of list.slice(0, MAX_SECTIONS)) {
    const s = readSection(item, carries);
    if (!s || seen.has(s.id)) continue;
    seen.add(s.id);
    sections.push(s);
  }
  return sections.length ? { sections } : null;
}

/** What a pack's UI adds, for a build log or a toast: "the NINTENDO SWITCH section". */
export function describeMemberUi(ui: MemberUi | null | undefined): string {
  if (!ui?.sections.length) return "";
  const titles = ui.sections.map((s) => s.title);
  return titles.length === 1
    ? `the ${titles[0]} section`
    : `the ${titles.join(", ")} sections`;
}
