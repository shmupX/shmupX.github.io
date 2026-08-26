// icons.js — Lucide icons for the CMG Desktop.
//
// Path data is copied from Lucide (lucide.dev, ISC licence) so the desktop
// carries no icon-font or CDN dependency, and the shell chrome renders
// identically everywhere — emoji would fall back to tofu on a Linux browser
// with no colour-emoji font.
//
// Lucide's drawing contract: 24×24 viewBox, no fill, 2px currentColor stroke,
// round caps and joins. Two presentations are built on that:
//   glyphIcon()  a bare stroke glyph that inherits colour — file rows, trees,
//                tab strips, taskbar buttons.
//   tileIcon()   the glyph (or a monogram) knocked out in white on a hue-tinted
//                rounded-square tile — desktop icons, start menu, title bars.

const LUCIDE = {
  folder:
    `<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>`,
  "folder-open":
    `<path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/>`,
  "hard-drive":
    `<line x1="22" x2="2" y1="12" y2="12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/><line x1="6" x2="6.01" y1="16" y2="16"/><line x1="10" x2="10.01" y1="16" y2="16"/>`,
  "code-xml": `<path d="m18 16 4-4-4-4"/><path d="m6 8-4 4 4 4"/><path d="m14.5 4-5 16"/>`,
  globe:
    `<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>`,
  "book-open":
    `<path d="M12 7v14"/><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/>`,
  "file-text":
    `<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>`,
  image:
    `<rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>`,
  music:
    `<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>`,
  package:
    `<path d="m7.5 4.27 9 5.15"/><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>`,
  search: `<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>`,
  "layout-grid":
    `<rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/>`,
  "app-window":
    `<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M10 4v4"/><path d="M2 8h20"/><path d="M6 4v4"/>`,
  play: `<polygon points="6 3 20 12 6 21 6 3"/>`,
};

function svgMarkup(name) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${
    LUCIDE[name] ?? LUCIDE["file-text"]
  }</svg>`;
}

/** A bare Lucide glyph that takes its colour from the surrounding text. */
export function glyphIcon(name, cls = "") {
  const span = document.createElement("span");
  span.className = `app-svg ${cls}`.trim();
  span.innerHTML = svgMarkup(name);
  return span;
}

/**
 * An app tile: a hue-tinted rounded square with the Lucide glyph (or a
 * monogram, for the workbench apps) knocked out in white.
 * @param {{lucide?: string, monogram?: string, hue?: number}} icon
 */
export function tileIcon(icon, cls = "") {
  const span = document.createElement("span");
  span.className = `app-tile ${cls}`.trim();
  span.style.setProperty("--tile-hue", icon.hue ?? 260);
  if (icon.lucide) span.innerHTML = svgMarkup(icon.lucide);
  else span.textContent = icon.monogram ?? "?";
  return span;
}
