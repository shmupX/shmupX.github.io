// static/steam-favorites.js — the dashboard's half of favorites in Steam.
//
// A row starred in the launcher (F, L3, or its ★) is written to
// GAME_FAVS_KEY as { id, title, icon }, its id the section and the row's own
// key. In a packaged launcher that key is kept on disk and every change to it
// reaches the server (lib/kept-storage.ts), which gives each favorite an entry
// of its own in Steam (lib/steam-favorites.ts) — so starring is all the page
// does. The shelf's own stars (SAV_FAVS_KEY) take the same road untouched.
//
// An entry made that way starts the launcher with --game <id> or --play
// <slug>; /api/launch hands that back, and launchTarget below finds the row
// to open once the sections it lives in have loaded.
//
// Pure, like steam-nudge.js beside it: the launcher has no DOM test harness,
// so what can be tested is functions that take data and answer
// (tests/steam_favorites_test.ts).

/** Same key lib/steam-favorites.ts reads. */
export const GAME_FAVS_KEY = 'cmg-game-favs';

/**
 * The favorite id of a row in a section, or '' when the row is not a game: a
 * submenu (the eShop, the LIBRARY), a pinned import row, or one without a key.
 */
export function favRowId(sectionId, row) {
  if (!sectionId || !row || row.submenu || row.pinned) return '';
  const key = row.key == null ? '' : String(row.key);
  if (!key || /\s|["']/.test(key) || /\s|["':]/.test(String(sectionId))) return '';
  return sectionId + ':' + key;
}

/** The stored favorites, or [] for anything unreadable. */
export function readGameFavs(raw) {
  try {
    const list = JSON.parse(raw || '[]');
    if (!Array.isArray(list)) return [];
    return list.filter((r) => r && typeof r.id === 'string' && r.id.includes(':'));
  } catch (_) {
    return [];
  }
}

/**
 * The list with `row` (in section `sectionId`) starred or unstarred. Returns
 * null when the row cannot be a favorite. The title is the row's own name, so
 * Steam lists it the way the launcher does; the icon only when it is a path on
 * this server or a data: URL, since that is what the server can turn into
 * artwork without asking anyone else.
 */
export function toggleGameFav(list, sectionId, row) {
  const id = favRowId(sectionId, row);
  if (!id) return null;
  if (list.some((r) => r.id === id)) return list.filter((r) => r.id !== id);
  const title = String(row.name || row.title || row.key).trim();
  const icon = typeof row.icon === 'string' && /^(\/[^/]|data:image\/)/.test(row.icon)
    ? row.icon
    : '';
  return [...list, icon ? { id, title, icon } : { id, title }];
}

/** Is `row` in section `sectionId` starred? */
export function isGameFav(list, sectionId, row) {
  const id = favRowId(sectionId, row);
  return !!id && list.some((r) => r.id === id);
}

/**
 * Where a --game id points among `sections` (the dashboard's SECTIONS: each
 * { id, rows }): { section, row } indices, or null while it is not there
 * (yet — a console's shelf loads after the strip does).
 */
export function launchTarget(sections, id) {
  const at = String(id || '').indexOf(':');
  if (at <= 0) return null;
  const sectionId = id.slice(0, at);
  const key = id.slice(at + 1);
  const section = (sections || []).findIndex((s) => s && s.id === sectionId);
  if (section < 0) return null;
  const row = (sections[section].rows || []).findIndex((r) => favRowId(sectionId, r) === id);
  return row < 0 ? null : { section, row, key };
}

/**
 * The shelf game's address: the shelf-owning game's own URL with play=<slug>,
 * the hand-off launchSavGame makes when a cover is picked.
 */
export function shelfPlayUrl(gameUrl, slug, origin) {
  if (!gameUrl || !/^[a-z0-9][a-z0-9-]*$/.test(String(slug || ''))) return '';
  try {
    const u = new URL(gameUrl, origin);
    u.searchParams.set('play', slug);
    return u.pathname + u.search + u.hash;
  } catch (_) {
    return '';
  }
}
