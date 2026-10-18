// A boss's second stage, for the console writers.
//
// The web runtime (static/games/2028-ai/game.bundle.js, bossStage2Record /
// bossStage2Due; README-Technical.md "A boss can have a second stage") lays a
// boss record's `stage2` block over the record once its hp falls below
// `hpBelow` of the bar (half unless the block says otherwise): its `anim`
// sets and weapon slots (bulletData / bulletDataA-C, either spelling) replace
// the boss's own key by key, an `attackPattern` there changes the routine,
// and `anim.morph` plays once on the way in. The hp pool is the same one.
// The cloud game gs turns its second boss, Daltonius, into Liu Kang's dragon
// this way.
//
// None of the five console formats changes a boss's form on its hp, so each
// writer approximates it as its format allows (FORMAT-*.md "A boss's second
// stage") and says how in its report's `transform`:
//
//   "native"                 the format has the mechanism itself;
//   "approximated: <how>"    two chained bosses, or the weapons alone;
//   "none"                   nothing of the second stage reaches the save
//                            (also a level whose bosses have none).
//
// Environment-neutral ESM (Node + browser).

/** The share of the bar below which stage 2 begins when a block names none (or nonsense). */
export const BOSS_STAGE2_HP_BELOW = 0.5;
/** A boss record's weapon slots: bulletData, bulletDataA ... bulletDataC (or projectileData*). */
export const BOSS_WEAPON_SUFFIXES = Object.freeze(["", "A", "B", "C"]);

/**
 * The record stage 2 flies: the boss's own with its stage2 block laid over
 * it, or null for a boss with no second stage. The bundle's bossStage2Record,
 * kept to the letter (tests/boss_stage2_test.ts pins the bundle's; the
 * engine's test pins this one against the same cases).
 */
export function bossStage2Record(bossData) {
    const stage2 = bossData && bossData.stage2;
    if (!stage2 || typeof stage2 !== "object") return null;
    const merged = { ...bossData, ...stage2 };
    delete merged.stage2;
    merged.anim = { ...(bossData.anim || {}), ...(stage2.anim || {}) };
    for (const suffix of BOSS_WEAPON_SUFFIXES) {
        const bullet = `bulletData${suffix}`, projectile = `projectileData${suffix}`;
        if (stage2[bullet] && !stage2[projectile]) delete merged[projectile];
        if (stage2[projectile] && !stage2[bullet]) delete merged[bullet];
    }
    const below = Number(stage2.hpBelow);
    merged.hpBelow = below > 0 && below < 1 ? below : BOSS_STAGE2_HP_BELOW;
    return merged;
}

/**
 * A boss with a second stage as the two bosses a format without a form
 * change flies in its place, one after the other: {first, second, hpBelow}.
 * `first` is the boss without its stage2 block, holding the top of the bar
 * (1 - hpBelow of it: the hp the player takes off before the change), and
 * `second` the stage 2 record holding the rest, so the two add up to the
 * boss's hp. A boss of infinite or unstated hp keeps that on both halves.
 * Null for a boss with no second stage.
 */
export function splitBossStage2(bossData) {
    const second = bossStage2Record(bossData);
    if (!second) return null;
    const hpBelow = second.hpBelow;
    delete second.hpBelow;
    const first = { ...bossData };
    delete first.stage2;
    const hp = Number(bossData.hp);
    if (bossData.hp !== "infinity" && Number.isFinite(hp) && hp > 0) {
        const top = Math.max(1, Math.round(hp * (1 - hpBelow)));
        first.hp = top;
        second.hp = Math.max(1, Math.round(hp) - top);
    }
    return { first, second, hpBelow };
}

/**
 * A boss record's weapons, slot by slot as the runtime's bossWeaponSlots
 * reads them (bulletData* first, projectileData* when it has none):
 * [{slot, weapon}] for each slot that holds an object.
 */
export function bossWeapons(bossData) {
    const out = [];
    if (!bossData) return out;
    for (const suffix of BOSS_WEAPON_SUFFIXES) {
        const weapon = bossData[`bulletData${suffix}`] || bossData[`projectileData${suffix}`];
        if (weapon && typeof weapon === "object") out.push({ slot: suffix, weapon });
    }
    return out;
}

/** A weapon's texture frames as an array of names (a bare string is one frame). */
export function weaponTextures(weapon) {
    const t = weapon && weapon.texture;
    if (typeof t === "string" && t) return [t];
    return Array.isArray(t) ? t.filter((n) => typeof n === "string" && n) : [];
}

/**
 * Every distinct projectile a boss fires over both stages, in the order the
 * fight shows them: stage 1's slots, then the textures stage 2 brings.
 * [{form: 1 | 2, slot, weapon, textures}], one per distinct texture set —
 * gs's Daltonius gives RAM_0, laptop0/1, then deza1_52_0/1.
 */
export function bossProjectiles(bossData) {
    const seen = new Set();
    const out = [];
    const add = (form, rec) => {
        for (const { slot, weapon } of bossWeapons(rec)) {
            const textures = weaponTextures(weapon);
            const key = textures.join("\n");
            if (!textures.length || seen.has(key)) continue;
            seen.add(key);
            out.push({ form, slot, weapon, textures });
        }
    };
    if (!bossData) return out;
    const first = { ...bossData };
    delete first.stage2;
    add(1, first);
    const s2 = bossStage2Record(bossData);
    if (s2) add(2, s2);
    return out;
}

/** The frames a boss record's body is drawn from: its idle set, else its texture list. */
export function bossBodyFrames(bossData) {
    const anim = bossData && bossData.anim;
    if (anim && Array.isArray(anim.idle) && anim.idle.length) return anim.idle.slice();
    return Array.isArray(bossData && bossData.texture) ? bossData.texture.slice() : [];
}
