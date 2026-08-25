// Shelf packer producing TexturePacker JSON-hash frames — a faithful port of
// the geometry in level-editor.html's buildAtlasWithReplacements() (sort by
// height desc, row fill, 2048 max width, 4px padding, no rotation, no trim)
// so CLI-emitted atlases match editor repacks byte-for-byte on the JSON side.

export function packShelf(items, { maxWidth = 2048, pad = 4 } = {}) {
    const sorted = items.slice().sort((a, b) => b.h - a.h);
    let cx = pad;
    let cy = pad;
    let rowH = 0;
    let fullH = 0;
    const placements = {};
    const frames = {};
    for (const s of sorted) {
        if (cx + s.w + pad > maxWidth) {
            cy += rowH + pad;
            cx = pad;
            rowH = 0;
        }
        placements[s.key] = { x: cx, y: cy };
        cx += s.w + pad;
        rowH = Math.max(rowH, s.h);
        fullH = Math.max(fullH, cy + s.h + pad);
    }
    for (const s of sorted) {
        const p = placements[s.key];
        frames[s.key] = {
            frame: { x: p.x, y: p.y, w: s.w, h: s.h },
            rotated: false,
            trimmed: false,
            spriteSourceSize: { x: 0, y: 0, w: s.w, h: s.h },
            sourceSize: { w: s.w, h: s.h },
        };
    }
    return {
        width: maxWidth,
        height: fullH,
        placements,
        frames,
        order: sorted.map((s) => s.key),
    };
}
