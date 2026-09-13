;; Song and Sound Effect ca65 enums for example-project.terrificaudio.
;;
;; Automatically generated using `tad-compiler ca65-enums` or `tad-compiler ca65-export`.
;;
;; This file MUST BE recreated if song list or sound effect export order changes.
;;


LAST_SONG_ID = 2
N_SOUND_EFFECTS = 17

;; Song enum.
;; Input argument for `Tad_LoadSong`
.enum Song
  BLANK = 0 ; blank (silent) song
  gimo_297 = 1
  ode_to_joy = 2
.endenum


;; Sound Effects enum.
;; Input argument for `Tad_QueueSoundEffect` and `Tad_QueuePannedSoundEffect`
.enum SFX
  ; normal-priority sound effects
  menu_cursor = 0
  menu_select = 1
  menu_incorrect = 2
  player_hurt = 3
  player_hurt_low_health = 4
  jump = 5
  vibrato_alarm = 6
  play_samples_bytecode = 7
  spawn_item = 8
  collect_coin = 9
  robot_notices_player = 10
  robot_ascend = 11
  robot_fires_laser = 12
  fire_arrow = 13
  spring = 14
  collect_item = 15
  brick_break = 16
.endenum
