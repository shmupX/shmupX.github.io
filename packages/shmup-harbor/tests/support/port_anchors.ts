// The lines of the port that lib/ps2/runtime-patches.ts anchors its enemy
// patches on, for the stand-in ports the patch tests build. Every patch's
// anchor has to be in a port for any of them to go on, so each stand-in
// carries these.

export const ENEMY_ANCHORS: readonly string[] = [
  // A Dezaemon zako (tests/ps2_deza_zako_test.ts).
  "function createEnemy(ctx2, data) {",
  "  return { name: data.name };",
  "}",
  "function enemyLoop(ctx2, e, player) {",
  "  return 1;",
  "}",
  // The ship's blink after a hit (tests/ps2_enemy_contact_test.ts).
  "function playerBlink(p) {",
  "  if (p.damageAnimTimer % 4 < 2) {",
  "  }",
  "  if (p.damageAnimTimer > 30) {",
  "  }",
  "}",
  // An enemy's shadow (tests/ps2_enemy_contact_test.ts).
  "function enemyShadow(ctx2, e) {",
  "  const shadowColor = ctx2.rt.Color.new(60, 60, 60, 60);",
  "  const shadowY = e.shadowReverse ? e.y - e.shadowOffsetY : e.y + e.shadowOffsetY;",
  "}",
  // An enemy the ship runs into (tests/ps2_enemy_contact_test.ts).
  "function enemyContact(ctx2, e, p) {",
  "  if (p.barrierFlg) {",
  "    if (hitTestAABB(e.x, e.y, e.hitW, e.hitH, p.x, p.y, p.hitW, p.hitH)) {",
  "      enemyDead(ctx2, e);",
  "      hudOnEnemyKill(ctx2.hud, e.score, e.spgage);",
  '      ctx2.sound.playSfx("se_guard");',
  "    }",
  "  } else if (hitTestAABB(e.x + e.hitX, e.y + e.hitY, e.hitW, e.hitH, p.x + p.hitX, p.y + p.hitY, p.hitW, p.hitH)) {",
  "    gamePlayerDamage(1);",
  "  }",
  "}",
];

/**
 * The port's atlas manager, cut down to what the pinpoint patches anchor on
 * and enough around it to run (ps2_pinpoint_test.ts): a sheet loads its
 * frames, and drawFrame crops, sizes and draws one about its centre.
 */
export const ATLAS_ANCHORS: readonly string[] = [
  "var AtlasManager = class {",
  "  #rt;",
  "  #atlases = {};",
  "  constructor(rt) {",
  "    this.#rt = rt;",
  "  }",
  "  loadAtlas(name, pngPath, jsonPath) {",
  "    const jsonText = this.#rt.std.loadFile(jsonPath);",
  "    const data = JSON.parse(jsonText);",
  "    const img = new this.#rt.Image(pngPath);",
  "    const ds = data.meta && data.meta.ps2DisplayScale ? data.meta.ps2DisplayScale : 1;",
  "    const frames = {};",
  "    const keys = Object.keys(data.frames);",
  "    for (let k = 0; k < keys.length; k++) {",
  "      const key = keys[k];",
  "      const fr = data.frames[key].frame;",
  "      frames[key] = { x: fr.x, y: fr.y, w: fr.w, h: fr.h, dw: fr.w * ds, dh: fr.h * ds };",
  "    }",
  "    this.#atlases[name] = { image: img, frames, displayScale: ds };",
  '    console.log("[Atlas] Loaded " + name + " with " + Object.keys(frames).length + " frames (displayScale=" + ds + ")");',
  "    return true;",
  "  }",
  "  drawFrame(name, frame2, x, y, scaleX, scaleY, alpha, tint) {",
  "    const atlas = this.#atlases[name];",
  "    if (!atlas) return;",
  "    const f = atlas.frames[frame2];",
  "    if (!f) return;",
  "    const img = atlas.image;",
  "    const sx = scaleX || 1;",
  "    const sy = scaleY || 1;",
  "    this.#setCrop(img, f, sx < 0, sy < 0);",
  "    const displayW = f.dw * Math.abs(sx);",
  "    const displayH = f.dh * Math.abs(sy);",
  "    img.width = displayW;",
  "    img.height = displayH;",
  "    img.color = tint || this.#rt.Color.new(255, 255, 255, 128);",
  "    img.draw(x - displayW / 2, y - displayH / 2);",
  "  }",
  "  #setCrop(img, f, flipX, flipY) {",
  "    img.startx = flipX ? f.x + f.w : f.x;",
  "    img.endx = flipX ? f.x : f.x + f.w;",
  "    img.starty = flipY ? f.y + f.h : f.y;",
  "    img.endy = flipY ? f.y : f.y + f.h;",
  "  }",
  "};",
];
