// music-maker-icons.js — the MUSIC mode's instrument families and their icons.
//
// 音まろ's bank has no names (README-Technical: "pick by the catalogue's
// ear"), so the 60 instruments the composed parts can use (0-59) are sorted
// into eight families by what the tone bank itself says about them — the
// analysed voices' noisiness, attack and sustain (BGM_VOICE_ROWS) and the
// sample layers' loop lengths and loop modes (layerAt / instrumentAt). Each
// family has an icon, drawn here in code on a 16x16 grid and outlined
// automatically; every instrument wears its family's icon in its own shade,
// so on the staff a note IS its instrument. The art is original — the
// console editor's own sprites are not used.
//
//   MusicMakerIcons.families(engine) -> [{ inst, family, n, name, hue, light }] x 60
//   MusicMakerIcons.FAMILIES          -> [{ id, label, hue }] in palette order
//   MusicMakerIcons.icon(kind, shade) -> a 16x16 canvas ('keys', …, 'band', 'tape')
//   MusicMakerIcons.instrumentIcon(entry) -> that instrument's canvas (cached)
(function () {
    'use strict';

    const FAMILIES = [
        { id: 'keys', label: 'KEYS', hue: 205 },
        { id: 'pluck', label: 'PLUCK', hue: 28 },
        { id: 'bleep', label: 'BLEEP', hue: 120 },
        { id: 'wind', label: 'WIND', hue: 48 },
        { id: 'strings', label: 'STRINGS', hue: 330 },
        { id: 'pads', label: 'PADS', hue: 265 },
        { id: 'drums', label: 'DRUMS', hue: 0 },
        { id: 'fx', label: 'FX', hue: 180 },
    ];
    const COMPOSED = 60;

    // The sorting rules, in order. Signals per instrument: the first analysed
    // layer's noisiness n, attack a and decay d (8 = sustained), and across
    // its sample layers the shortest loop and any reverse / ping-pong loop.
    function familyOf(sig) {
        if (sig.reverseLoop) return 'fx';
        if (sig.n >= 0.75) return 'drums';
        if (sig.a >= 0.1) return 'pads';
        if (sig.d >= 8) {
            if (sig.n >= 0.45) return 'strings';
            if (sig.shortestLoop <= 45) return 'bleep';
            return 'wind';
        }
        if (sig.shortestLoop <= 45) return 'bleep';
        if (sig.d <= 0.18) return 'pluck';
        return 'keys';
    }

    function signals(engine, inst) {
        const rows = engine.BGM_VOICE_ROWS[inst] || [];
        const r = rows[0] || [0, 127, 0, 0, 0.2, 0.84, 0.02, 0];
        const sig = { a: r[3], d: r[4], s: r[5], n: r[7], shortestLoop: Infinity, reverseLoop: false };
        const info = engine.instrumentAt ? engine.instrumentAt(inst) : null;
        if (info) {
            for (let k = 0; k < info.layerCount; k++) {
                const l = engine.layerAt(info.firstLayer + k);
                if (!l) continue;
                if (l.loopMode === 2 || l.loopMode === 3) sig.reverseLoop = true;
                if (l.loopMode) sig.shortestLoop = Math.min(sig.shortestLoop, l.lengthSamples - l.loopStart);
            }
        }
        return sig;
    }

    let cachedFamilies = null;
    function families(engine) {
        if (cachedFamilies) return cachedFamilies;
        const out = [];
        const count = {};
        for (let inst = 0; inst < COMPOSED; inst++) {
            const family = familyOf(signals(engine, inst));
            count[family] = (count[family] || 0) + 1;
            const fam = FAMILIES.find((f) => f.id === family);
            out.push({ inst, family, n: count[family], name: fam.label + ' ' + String(count[family]).padStart(2, '0'), hue: fam.hue });
        }
        // Spread the shades within each family, light to dark.
        for (const fam of FAMILIES) {
            const members = out.filter((e) => e.family === fam.id);
            members.forEach((e, k) => { e.light = members.length > 1 ? 70 - (k * 30) / (members.length - 1) : 58; });
        }
        cachedFamilies = out;
        return out;
    }

    // ---- drawing ----------------------------------------------------------
    // A 16x16 grid of palette letters: m main, l light, d dark, w white; the
    // outline (o) is added around whatever was drawn.
    function grid() { return Array.from({ length: 16 }, () => new Array(16).fill(null)); }
    function px(g, x, y, c) { if (x >= 0 && y >= 0 && x < 16 && y < 16) g[y][x] = c; }
    function rect(g, x0, y0, w, h, c) { for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) px(g, x, y, c); }
    function disk(g, cx, cy, r, c) {
        for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
            if ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= r * r) px(g, x, y, c);
        }
    }
    function line(g, x0, y0, x1, y1, c) {
        const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
        let err = dx + dy;
        for (;;) {
            px(g, x0, y0, c);
            if (x0 === x1 && y0 === y1) break;
            const e2 = 2 * err;
            if (e2 >= dy) { err += dy; x0 += sx; }
            if (e2 <= dx) { err += dx; y0 += sy; }
        }
    }
    function outline(g) {
        const out = g.map((row) => row.slice());
        for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
            if (g[y][x]) continue;
            for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                const v = g[y + dy] && g[y + dy][x + dx];
                if (v && v !== 'o') { out[y][x] = 'o'; break; }
            }
        }
        return out;
    }

    const SHAPES = {
        keys(g) {
            rect(g, 1, 4, 14, 9, 'w');
            for (let x = 3; x < 15; x += 2) rect(g, x, 4, 1, 9, 'l');
            for (const x of [2, 4, 8, 10, 12]) rect(g, x, 4, 2, 5, 'd');
            rect(g, 1, 3, 14, 1, 'm');
        },
        pluck(g) {
            disk(g, 5.5, 11, 4.2, 'm');
            disk(g, 7.5, 7.5, 2.8, 'm');
            disk(g, 5.5, 11, 1.3, 'd');
            line(g, 8, 7, 13, 2, 'l');
            line(g, 9, 7, 14, 2, 'l');
            rect(g, 13, 1, 2, 2, 'd');
        },
        bleep(g) {
            rect(g, 1, 2, 14, 12, 'd');
            rect(g, 2, 3, 12, 10, 'm');
            const wave = [9, 9, 5, 5, 5, 9, 9, 9, 5, 5, 5, 9];
            wave.forEach((y, i) => px(g, 2 + i, y, 'w'));
            for (const x of [4, 7, 9, 12]) { px(g, x, 6, 'w'); px(g, x, 7, 'w'); px(g, x, 8, 'w'); }
        },
        wind(g) {
            rect(g, 1, 7, 9, 3, 'm');
            rect(g, 1, 8, 9, 1, 'l');
            for (let i = 0; i < 5; i++) rect(g, 10 + i, 7 - i, 1, 3 + i * 2, 'm');
            rect(g, 14, 2, 1, 13, 'l');
            rect(g, 4, 5, 1, 2, 'd'); rect(g, 6, 5, 1, 2, 'd');
        },
        strings(g) {
            disk(g, 8, 11.5, 3.6, 'm');
            disk(g, 8, 6.5, 2.8, 'm');
            rect(g, 7, 1, 2, 5, 'd');
            rect(g, 6, 9, 1, 2, 'd'); rect(g, 9, 9, 1, 2, 'd');
            line(g, 2, 14, 14, 3, 'l');
        },
        pads(g) {
            disk(g, 5, 9, 3.6, 'l');
            disk(g, 9, 7, 4.2, 'l');
            disk(g, 12, 10, 3, 'l');
            rect(g, 3, 10, 11, 3, 'l');
            disk(g, 9, 7, 2, 'w');
            rect(g, 3, 12, 11, 1, 'm');
        },
        drums(g) {
            rect(g, 2, 7, 12, 7, 'm');
            for (let x = 3; x < 14; x += 3) line(g, x, 8, x + 1, 13, 'd');
            disk(g, 8, 7, 6.2, 'l');
            rect(g, 2, 7, 12, 1, 'w');
            line(g, 3, 1, 7, 6, 'd'); line(g, 13, 1, 9, 6, 'd');
            rect(g, 2, 0, 2, 2, 'w'); rect(g, 12, 0, 2, 2, 'w');
            for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) if (y < 5 && g[y][x] === 'l') g[y][x] = null;
        },
        fx(g) {
            line(g, 8, 1, 8, 14, 'm'); line(g, 1, 8, 14, 8, 'm');
            line(g, 3, 3, 13, 13, 'l'); line(g, 13, 3, 3, 13, 'l');
            disk(g, 8.5, 8.5, 2.4, 'w');
            px(g, 13, 2, 'w'); px(g, 2, 13, 'w');
        },
        // The accompaniment's band: a small robot drummer.
        band(g) {
            rect(g, 3, 4, 10, 8, 'm');
            rect(g, 7, 1, 2, 3, 'd'); rect(g, 6, 0, 4, 1, 'w');
            rect(g, 5, 6, 2, 2, 'w'); rect(g, 9, 6, 2, 2, 'w');
            px(g, 6, 7, 'd'); px(g, 10, 7, 'd');
            rect(g, 6, 10, 4, 1, 'd');
            rect(g, 4, 12, 8, 3, 'l');
            rect(g, 1, 6, 2, 4, 'l'); rect(g, 13, 6, 2, 4, 'l');
        },
        tape(g) {
            rect(g, 1, 3, 14, 10, 'm');
            rect(g, 3, 5, 10, 4, 'w');
            disk(g, 5.5, 7, 1.3, 'd'); disk(g, 10.5, 7, 1.3, 'd');
            rect(g, 4, 10, 8, 3, 'l');
        },
    };

    function colors(hue, light) {
        return {
            m: `hsl(${hue},70%,${light}%)`,
            l: `hsl(${hue},80%,${Math.min(90, light + 18)}%)`,
            d: `hsl(${hue},60%,${Math.max(12, light - 26)}%)`,
            w: '#fff',
            o: 'rgba(0,0,0,.85)',
        };
    }

    const cache = {};
    function icon(kind, hue = 120, light = 55) {
        const key = kind + ':' + hue + ':' + light;
        if (cache[key]) return cache[key];
        const g = grid();
        (SHAPES[kind] || SHAPES.fx)(g);
        const og = outline(g);
        const pal = colors(hue, light);
        const cv = document.createElement('canvas');
        cv.width = 16; cv.height = 16;
        const ctx = cv.getContext('2d');
        for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
            const c = og[y][x];
            if (!c) continue;
            ctx.fillStyle = pal[c];
            ctx.fillRect(x, y, 1, 1);
        }
        cache[key] = cv;
        return cv;
    }

    function instrumentIcon(entry) {
        return icon(entry.family, entry.hue, Math.round(entry.light));
    }

    window.MusicMakerIcons = { FAMILIES, COMPOSED, families, familyOf, icon, instrumentIcon, SHAPES };
})();
