// The directory indexes under static/, and the redirect that canonicalises
// them.
//
// Fresh's staticFiles() registers each static/<dir>/index.html under two
// pathnames — <dir>/index.html and the bare <dir> — and answers either without
// redirecting. The bare form serves the page but resolves every relative URL in
// it one level too high: /tilemap-editor asks for /tilemap-editor.js instead of
// /tilemap-editor/tilemap-editor.js, so the editor 404s its own module and
// never boots. The srcs are absolute now, but the trap is reset by the next
// relative URL anyone writes, so the URL is fixed rather than each page.
//
// A list rather than a probe because Deploy can serve static/ but can't list it
// at runtime — the same reason games.manifest.json is committed. The copy is
// checked instead of trusted: tests/static_index_test.ts walks static/ and
// fails if a directory index is missing here or listed without one.
export const STATIC_INDEXES = [
  "/desktop",
  "/editor",
  "/pixel-composer",
  "/pixel-editor",
  "/tilemap-editor",
];

/**
 * Where `url` — a pathname with an optional query, as `req.url` gives it —
 * should be redirected to, or null if it is already canonical.
 */
export function dirIndexRedirect(url: string): string | null {
  const query = url.indexOf("?");
  const pathname = query === -1 ? url : url.slice(0, query);
  if (!STATIC_INDEXES.includes(pathname)) return null;
  return `${pathname}/${query === -1 ? "" : url.slice(query)}`;
}
