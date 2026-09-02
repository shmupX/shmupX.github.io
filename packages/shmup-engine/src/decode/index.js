// Aggregation seam for the Dezaemon 2 payload decoders.
//
// The editor and the CLI only ever call decodeSave(); individual section
// decoders (decode-title.js, decode-sprite.js, …) register their output here
// as the reverse-engineering lands, and both front-ends light up
// automatically.
//
// Every field carries a confidence level:
//   'confirmed'  — backed by a controlled-delta capture or Ghidra-traced offset
//   'heuristic'  — plausible decode, unverified
//   (absent)     — not decoded yet
//
// decodeSave() never throws on undecodable content — it aggregates partials
// so the UI can render "title: confirmed / sprites: heuristic / stages: not
// yet decoded" plus a raw-region fallback.

import { parseSectionTable } from "../payload-table.js";
import { decompress, SECTION_SIZES, SECTION_HINTS } from "../decompress.js";
import { decodeCg } from "./decode-cg.js";
import { decodeStages, sec5Regions, projectForEditor } from "./decode-stage.js";
import { decodeSongs } from "./decode-song.js";
import { decodeSettings } from "./decode-settings.js";
import { extractEnemySprites, extractBossSprites, extractBossPartSprites, extractBackgroundCells, extractGlobalArt, extractTitleArt } from "./decode-sprites.js";
import { readBossTrailer } from "./decode-boss.js";
import { decodeModels } from "./decode-model.js";

export function decodeSave(payload) {
    const result = {
        title: null,
        confidence: {},
        cg: null,      // {palettes, pages} from decode-cg.js (art pages + palette bank)
        cgError: null,
        backgrounds: null, // per-stage background tilemaps from decode-stage.js
        backgroundError: null,
        stageCount: 0,
        songs: null,   // 24 BGM slots from decode-song.js
        songError: null,
        songCount: 0,
        sprites: [],   // {key, w, h, rgba: Uint8ClampedArray}
        enemies: [],   // {name, stage, record, bytes, placements, spriteKeys?}
        stages: [],    // {rows, waveRows, cols, boss, items} in spawn order
        bosses: [],    // {stage, sizeClass, row, col, spriteKeys?}
        bgCells: [],   // distinct background tiles: {key, w, h, rgba}
        bgStages: [],  // per stage: {rows, cols, words: Uint16Array} | null
        regions: [],   // {name, offset, length, decoded, decompressedSize?}
        sections: null,
        tableError: null,
    };
    try {
        const table = parseSectionTable(payload);
        result.sections = table.sections.map((s) => {
            const compressed = payload.subarray(s.offset, s.offset + s.size);
            let decompressed = null;
            let decompressError = null;
            try {
                decompressed = decompress(compressed);
            } catch (err) {
                decompressError = err.message;
            }
            return {
                index: s.index,
                size: s.size,
                checksum: s.checksum,
                addr: s.addr,
                offset: s.offset,
                decompressedSize: decompressed ? decompressed.length : null,
                sizeMatchesKnown: decompressed ? decompressed.length === SECTION_SIZES[s.index] : false,
                hint: SECTION_HINTS[s.index],
                decompressed,
                decompressError,
            };
        });
        result.confidence.decompression = result.sections.every((s) => s.sizeMatchesKnown)
            ? "confirmed"
            : "heuristic";
        // CG layer (art pages sec0-3 + palette bank sec4) — layout confirmed
        // by cross-corpus + disc analysis (FORMAT.md "Section semantics").
        const cgSections = [0, 1, 2, 3].map((i) => result.sections[i]);
        const palSection = result.sections[4];
        if (cgSections.every((s) => s?.sizeMatchesKnown) && palSection?.sizeMatchesKnown) {
            try {
                result.cg = decodeCg(cgSections.map((s) => s.decompressed), palSection.decompressed);
                result.confidence.cg = "confirmed";
            } catch (err) {
                result.cgError = err.message;
            }
        }
        // Stage backgrounds (sec5 stage banks) — layout confirmed from engine
        // code and by rendering coherent level art in every sample game.
        const assembly = result.sections[5];
        if (assembly?.sizeMatchesKnown) {
            try {
                const { stages, stageCount } = decodeStages(assembly.decompressed);
                result.backgrounds = stages;
                result.stageCount = stageCount;
                result.confidence.backgrounds = "confirmed";
                result.sec5Regions = sec5Regions(assembly.decompressed);
                // Global settings: game mode, the two ship configs (main
                // weapon -> per-save shot damage), BGM table, SFX set.
                try {
                    result.settings = decodeSettings(assembly.decompressed);
                    result.confidence.settings = result.settings.confidence.mainWeapon;
                } catch (err) {
                    result.settingsError = err.message;
                }
                // Editor-facing projection: the enemy roster (one entry per
                // placed (stage, record) pair) and per-stage spawn rows the
                // level editor renders. Each roster entry carries its decoded
                // 18-byte attribute record (decode-enemy.js — hp, score,
                // speed, fire config and the four change channels), traced
                // from the play engine's own field reads.
                const projected = projectForEditor(stages.slice(0, stageCount), {
                    itemSlots: result.settings ? result.settings.itemSlots : null,
                });
                result.enemies = projected.enemies;
                result.stages = projected.stages;
                // Each boss carries its decoded 64-byte record (decode-boss
                // .js — HP, score, HP-stage playlist, patterns with fire
                // points and part spawns), traced from the play engine's
                // boss routines.
                result.bosses = projected.stages
                    .map((st, stage) => (st.boss ? {
                        stage,
                        sizeClass: st.boss.sizeClass,
                        row: st.boss.row,
                        col: st.boss.col,
                        behavior: readBossTrailer(assembly.decompressed, stage),
                    } : null))
                    .filter(Boolean);
                result.confidence.enemies = "confirmed";
                result.confidence.attributes = "confirmed";
                result.confidence.stages = "confirmed";
                // Art: each enemy's 4 animation frames out of its own stage's
                // sprite composition bank, plus the boss art of every stage
                // that places one.
                if (result.cg) {
                    try {
                        const cgPages = result.sections.slice(0, 4).map((s) => s.decompressed);
                        const { sprites, spriteKeysByEnemy } = extractEnemySprites(
                            assembly.decompressed,
                            cgPages,
                            result.cg.palettes,
                            result.enemies,
                            projected.stagesUsing,
                        );
                        for (const e of result.enemies) {
                            const keys = spriteKeysByEnemy.get(e.key);
                            if (keys) e.spriteKeys = keys;
                        }
                        const boss = extractBossSprites(
                            assembly.decompressed,
                            cgPages,
                            result.cg.palettes,
                            result.bosses,
                        );
                        // Boss frames are appended, so their indices shift past
                        // the enemy sprites they follow in the shared list.
                        // `core` says whether the frames are the boss's own
                        // animated core or fallback figure pieces (which must
                        // not be played as one animation).
                        for (const b of result.bosses) {
                            const entry = boss.spriteKeysByStage.get(b.stage);
                            if (entry) {
                                b.spriteKeys = entry.keys.map((i) => i + sprites.length);
                                b.coreArt = entry.core;
                            }
                        }
                        // Part art for the trailer's type-3/4 fire points:
                        // pieces the roster already extracted are referenced
                        // in place, the rest render from the boss's own stage
                        // bank and append after the boss frames.
                        const parts = extractBossPartSprites(
                            assembly.decompressed,
                            cgPages,
                            result.cg.palettes,
                            result.bosses,
                            result.enemies,
                            sprites.length + boss.sprites.length,
                        );
                        for (const b of result.bosses) {
                            const partArt = parts.partKeysByStage.get(b.stage);
                            if (partArt) b.partArt = partArt;
                        }
                        // The drawn title screen (TITLE 1/2 compositions and
                        // the credit strips from the global sprite bank),
                        // appended after the parts.
                        const titleArt = extractTitleArt(
                            assembly.decompressed,
                            cgPages,
                            result.cg.palettes,
                            sprites.length + boss.sprites.length + parts.sprites.length,
                        );
                        if (Object.keys(titleArt.roles).length) {
                            result.titleArt = titleArt.roles;
                            // Where each trimmed piece sits inside its
                            // 128x64 / 64x16 slot, for the title scene.
                            result.titleLayout = titleArt.layout;
                        }
                        // The bank's head: the save's own player ship, item
                        // icons, blast anims and the 3 global bullet types
                        // (decode-sprites.js `extractGlobalArt`).
                        const globalArt = extractGlobalArt(
                            assembly.decompressed,
                            cgPages,
                            result.cg.palettes,
                            sprites.length + boss.sprites.length + parts.sprites.length + titleArt.sprites.length,
                        );
                        if (Object.keys(globalArt.roles).length) {
                            result.globalArt = globalArt.roles;
                        }
                        result.sprites = sprites.concat(boss.sprites, parts.sprites, titleArt.sprites, globalArt.sprites);
                        if (result.sprites.length) result.confidence.sprites = "heuristic";
                        // Stage backgrounds as art: one sprite per distinct
                        // tile plus a compact per-stage grid, so the game can
                        // scroll the save's own scenery.
                        const bg = extractBackgroundCells(
                            result.backgrounds,
                            cgPages,
                            result.cg.palettes,
                            stageCount,
                        );
                        result.bgCells = bg.cells;
                        result.bgStages = bg.stages;
                    } catch (err) {
                        result.spriteError = err.message;
                    }
                }
            } catch (err) {
                result.backgroundError = err.message;
            }
        }
        // BGM (sec6): 24 song slots of 4228 bytes.
        const bgm = result.sections[6];
        if (bgm?.sizeMatchesKnown) {
            try {
                const { songs, usedCount } = decodeSongs(bgm.decompressed);
                result.songs = songs;
                result.songCount = usedCount;
                result.confidence.songs = "confirmed";
            } catch (err) {
                result.songError = err.message;
            }
        }
        // 3D models (sec7): the ポリ吉 part compositions. null when the save
        // never opened the 3D editor (no magic) — that is data, not an error.
        const modelSection = result.sections[7];
        if (modelSection?.sizeMatchesKnown) {
            try {
                result.models = decodeModels(modelSection.decompressed);
                if (result.models) result.confidence.models = "confirmed";
            } catch (err) {
                result.modelError = err.message;
            }
        }
        result.regions = result.sections.map((s) => ({
            name: `sec${s.index}: ${s.hint}`,
            offset: s.offset,
            length: s.size,
            decoded:
                (Boolean(result.cg) && s.index <= 4) ||
                (Boolean(result.backgrounds) && s.index === 5) ||
                (Boolean(result.songs) && s.index === 6) ||
                (Boolean(result.models) && s.index === 7),
            decompressedSize: s.decompressedSize,
        }));
    } catch (err) {
        result.tableError = err.message;
        result.regions = [{ name: "payload", offset: 0, length: payload.length, decoded: false }];
    }
    return result;
}
