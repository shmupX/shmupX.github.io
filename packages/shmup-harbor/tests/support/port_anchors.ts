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
