; This is automatically generated. Edit "actors.txt" instead
.include "snes.inc"
.include "global.inc"
.include "graphicsenum.s"
.include "paletteenum.s"
.export ActorBank, ActorRun, ActorDraw, ActorWidthTable, ActorHeightTable
.export ParticleRun, ParticleDraw
.import RunWalker, DrawWalker, RunLedgeWalker, DrawLedgeWalker, RunShooter, DrawShooter, RunJumper, DrawJumper, RunEnemyBullet, DrawEnemyBullet, RunMovingPlatformHorizontal, DrawMovingPlatform, RunMovingPlatformVertical, DrawMovingPlatform, RunPlayerProjectile, DrawPlayerProjectile, RunPoofParticle, DrawPoofParticle, RunPrizeParticle, DrawPrizeParticle

.segment "ActorData"

.pushseg
.segment "C_ActorCommon"
.proc ActorNothing
  rtl
.endproc
.popseg

.proc ActorDraw
  .addr .loword(ActorNothing)
  .addr .loword(DrawWalker)
  .addr .loword(DrawLedgeWalker)
  .addr .loword(DrawShooter)
  .addr .loword(DrawJumper)
  .addr .loword(DrawEnemyBullet)
  .addr .loword(DrawMovingPlatform)
  .addr .loword(DrawMovingPlatform)
  .addr .loword(DrawPlayerProjectile)
.endproc

.proc ActorRun
  .addr .loword(ActorNothing)
  .addr .loword(RunWalker)
  .addr .loword(RunLedgeWalker)
  .addr .loword(RunShooter)
  .addr .loword(RunJumper)
  .addr .loword(RunEnemyBullet)
  .addr .loword(RunMovingPlatformHorizontal)
  .addr .loword(RunMovingPlatformVertical)
  .addr .loword(RunPlayerProjectile)
.endproc

.proc ActorBank
  .byt ^ActorNothing, ^ActorNothing
  .byt ^RunWalker, ^DrawWalker
  .byt ^RunLedgeWalker, ^DrawLedgeWalker
  .byt ^RunShooter, ^DrawShooter
  .byt ^RunJumper, ^DrawJumper
  .byt ^RunEnemyBullet, ^DrawEnemyBullet
  .byt ^RunMovingPlatformHorizontal, ^DrawMovingPlatform
  .byt ^RunMovingPlatformVertical, ^DrawMovingPlatform
  .byt ^RunPlayerProjectile, ^DrawPlayerProjectile
.endproc

.proc ActorWidthTable
  .word 0
  .word 16<<4 ; Walker
  .word 16<<4 ; LedgeWalker
  .word 16<<4 ; Shooter
  .word 16<<4 ; Jumper
  .word 8<<4 ; EnemyBullet
  .word 32<<4 ; MovingPlatformHorizontal
  .word 32<<4 ; MovingPlatformVertical
  .word 8<<4 ; PlayerProjectile
.endproc

.proc ActorHeightTable
  .word 0
  .word 16<<4 ; Walker
  .word 16<<4 ; LedgeWalker
  .word 16<<4 ; Shooter
  .word 16<<4 ; Jumper
  .word 8<<4 ; EnemyBullet
  .word 12<<4 ; MovingPlatformHorizontal
  .word 12<<4 ; MovingPlatformVertical
  .word 8<<4 ; PlayerProjectile
.endproc

.segment "C_ParticleCode"
.proc ParticleNothing
  rts
.endproc

.proc ParticleDraw
  .addr .loword(ParticleNothing-1)
  .addr .loword(DrawPoofParticle-1)
  .addr .loword(DrawPrizeParticle-1)
.endproc

.proc ParticleRun
  .addr .loword(ParticleNothing-1)
  .addr .loword(RunPoofParticle-1)
  .addr .loword(RunPrizeParticle-1)
.endproc

.segment "C_ActorCommon"
.proc SharedNone
  rts
.endproc
