#!/bin/sh
# Put a level in one of Dezaemon 2's five save slots on Mednafen's cartridge —
# the Linux / WSL Ubuntu leg of `deno task sav:inject`, reached from
# scripts/sav-inject.ts. This file does the three things that differ per
# platform (find the cart, refuse while the emulator is running, start the game
# afterwards) and hands the merge itself to scripts/inject-openemu.sh through
# its --cart flag, which skips every OpenEmu-specific step: same flags, same
# guarantees, the same --help (with Mednafen named in it rather than OpenEmu —
# see SAV_INJECT_EMU below), and the same lib/cart-inject.ts underneath.
#
# Mednafen keeps Saturn battery saves in $MEDNAFEN_HOME/sav, i.e.
# ~/.mednafen/sav — the directory the user's own dezaemon2.sh points the
# emulator at:
#
#   ~/.mednafen/sav/Dezaemon 2 (Japan).bcr    the 512 KB cartridge, gzipped
#   ~/.mednafen/sav/Dezaemon 2 (Japan).bkr    the console's own 32 KB memory
#
# ...but only when filesys.fname_sav is a plain "%f.%x". Mednafen's stock
# default is "%f.%M%x", where %M is empty on the first try and the game's own
# md5 plus a dot on the second — so it opens "<disc>.bcr" when that file
# exists and "<disc>.<md5>.bcr" when it does not. The user's launcher forces
# neither. So the cart is found by GLOB, both names work, and when both are
# there the un-hashed one is the live cart. Only the .bcr is written; the .bkr
# (which holds Dezaemon 2's DEZA2___SYS options record) and the .smpc (the
# emulated clock) are never touched.
#
# From WSL you may be driving the *Windows* Mednafen over interop — the only one
# that sees a USB/Bluetooth pad. That one keeps its saves beside mednafen.exe:
#   MEDNAFEN_SAV=/mnt/c/Users/you/Dezaemon2/mednafen/sav deno task sav:inject foo
# ...and no Linux process list can see it, so quit it yourself first.
#
# When the injection has been verified this starts the game with the user's own
# launcher — $DEZAEMON_SH, else dezaemon2.sh in ~/saturn, ~, ~/bin or beside the
# checkout. --no-launch injects only, and so does naming a cart the launcher's
# own Mednafen would not open (--cart, MEDNAFEN_SAV, a Windows MEDNAFEN_BIN):
# starting the game on a different cart shows a LOAD screen without the level,
# which is worse than not starting it. The run says which happened.
set -eu

DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
CORE="$DIR/inject-openemu.sh"
[ -f "$CORE" ] || { echo "error: $CORE is missing; is the checkout complete?" >&2; exit 2; }

# The core script names an emulator in its usage text and in the closing
# "load it" line; these make both say Mednafen. Exported ABOVE the --help peek
# below, so that a WSL user reading --help is told about this leg rather than
# about OpenEmu, which is not what is installed here.
SAV_INJECT_EMU=Mednafen; export SAV_INJECT_EMU
SAV_INJECT_NOLAUNCH="inject only; do not start the game afterwards. It is not
                 started either when the cart written is not the one your own
                 launcher's Mednafen would open — --cart somewhere else,
                 \$MEDNAFEN_SAV, a Windows \$MEDNAFEN_BIN — because its LOAD
                 screen would not show the level. The run says which happened"
export SAV_INJECT_NOLAUNCH

# Peek, do not consume: every flag still goes on to the core script, which owns
# the argument grammar (--launch/--no-launch included). Stop at a bare --,
# after which nothing is ours. --cart's value is kept too: its directory is what
# decides whether the launcher below would open the file we are about to write.
CART=""; CARTPATH=""; WANT=""; FORCE=""; DRY=""; LAUNCH=1
for a in "$@"; do
    if [ -n "$WANT" ]; then CARTPATH=$a; WANT=""; continue; fi
    case $a in
        --) break ;;
        --cart) CART=1; WANT=1 ;;
        --cart=*) CART=1; CARTPATH=${a#--cart=} ;;
        --force) FORCE=1 ;;
        --dry-run) DRY=1 ;;
        --no-launch) LAUNCH="" ;;
        --launch) LAUNCH=1 ;;
        -h|--help) exec sh "$CORE" --help ;;
    esac
done

# --- where the launcher's own Mednafen keeps its saves ---------------------
# Mednafen's documented base-directory rule, which the user's dezaemon2.sh does
# not override: $MEDNAFEN_HOME, else $HOME/.mednafen. MEDNAFEN_SAV and
# MEDNAFEN_BIN are this repo's own overrides, not Mednafen's, so a cart found
# through either of them is NOT necessarily the one the launcher would open —
# which is what the launch block at the end compares against.
DEFAULT_SAVES=""
if [ -n "${MEDNAFEN_HOME:-}" ]; then
    DEFAULT_SAVES="$MEDNAFEN_HOME/sav"
elif [ -n "${HOME:-}" ]; then
    DEFAULT_SAVES="$HOME/.mednafen/sav"
fi

# --- find the cart --------------------------------------------------------
# An explicit --cart means the caller has already said which file to write, so
# there is nothing to find. Everything after this still applies to it: the core
# script owns the path, but the running-Mednafen guard and the launch decision
# are this leg's, and --cart is exactly how the note below tells you to reach
# Mednafen's OTHER name for the same cart, in the same directory.
WINEXE=""; STEM=""; NOTE=""
if [ -n "$CART" ]; then
    case $CARTPATH in
        "") SAVES="" ;;
        /*) SAVES=$(dirname "$CARTPATH") ;;
        *) SAVES=$(dirname "$PWD/$CARTPATH") ;;
    esac
elif [ -n "${MEDNAFEN_SAV:-}" ]; then
    SAVES=$MEDNAFEN_SAV
else
    case ${MEDNAFEN_BIN:-} in
        # A Windows mednafen.exe run from WSL keeps its saves beside itself, the
        # same as a native Windows install — the layout savDirFor() in
        # lib/mednafen.ts computes, so `sav:run` and `sav:inject` agree.
        *.exe|*.EXE) WINEXE=1; SAVES=$(dirname "$MEDNAFEN_BIN")/sav ;;
        *)
            [ -n "$DEFAULT_SAVES" ] || { echo "error: HOME is not set, so Mednafen's save directory cannot be found. Set MEDNAFEN_SAV, or pass --cart PATH." >&2; exit 2; }
            SAVES=$DEFAULT_SAVES ;;
    esac
fi
# ...and when it did not, find it. Only the .bcr is written; the .bkr and
# .smpc are never touched.
if [ -z "$CART" ]; then
    [ -d "$SAVES" ] || { echo "error: no Mednafen save directory at \"$SAVES\". Set MEDNAFEN_SAV to it, or pass --cart PATH." >&2; exit 2; }

    # A stem is "hashed" when its last dot-separated part is Mednafen's 32-hex game
    # md5 — <disc>.<md5> rather than plain <disc>.
    is_hashed() {
        h=${1##*.}
        [ "$h" != "$1" ] || return 1
        case $h in
            # 32 characters, all of them hex
            ????????????????????????????????) case $h in *[!0-9a-f]*) return 1 ;; *) return 0 ;; esac ;;
            *) return 1 ;;
        esac
    }

    # The .bcr only appears once the game first writes the cartridge, so fall back
    # to the .bkr and .smpc, which appear on the first quit; all three share a stem.
    # Sub-directories cannot match, so a backup/ folder beside the saves is fine.
    PLAIN=""; PLAIN_N=0; HASHED=""; HASHED_N=0; FOUND=""
    for ext in bcr bkr smpc; do
        for f in "$SAVES"/Dezaemon*."$ext"; do
            [ -f "$f" ] || continue
            s=${f%".$ext"}
            FOUND="$FOUND  $(basename "$s").bcr
"
            if is_hashed "$s"; then
                HASHED=$s; HASHED_N=$((HASHED_N + 1))
            else
                PLAIN=$s; PLAIN_N=$((PLAIN_N + 1))
            fi
        done
        [ $((PLAIN_N + HASHED_N)) -eq 0 ] || break
    done

    if [ $((PLAIN_N + HASHED_N)) -eq 0 ]; then
        echo "error: no Dezaemon 2 save in \"$SAVES\". Mednafen writes the cart the first time the game saves — start Dezaemon 2 with your own launcher once and quit it, then run this again. Or pass --cart PATH." >&2
        exit 2
    fi
    if [ "$PLAIN_N" -eq 1 ] && [ "$HASHED_N" -eq 1 ] && [ "${HASHED#"$PLAIN".}" != "$HASHED" ]; then
        # One disc under both of Mednafen's names. It opens the un-hashed one when
        # it exists (%M is empty on the first evaluation), so that is the live cart.
        STEM=$PLAIN
        NOTE="note     : $(basename "$HASHED").bcr is here too; Mednafen reads the un-hashed name when it exists, so that is the one written. Pass --cart to choose the other."
    elif [ "$PLAIN_N" -eq 1 ] && [ "$HASHED_N" -eq 0 ]; then
        STEM=$PLAIN
    elif [ "$PLAIN_N" -eq 0 ] && [ "$HASHED_N" -eq 1 ]; then
        STEM=$HASHED
    else
        echo "error: $((PLAIN_N + HASHED_N)) Dezaemon 2 saves in \"$SAVES\" — cannot tell which disc you mean:" >&2
        printf '%s' "$FOUND" >&2
        echo "  pass --cart with one of those." >&2
        exit 2
    fi
fi

# --- is Mednafen about to undo this? --------------------------------------
# Mednafen rewrites its battery saves when it exits, over whatever is on disk.
# pgrep is absent on a stripped container; no check is better than a false one.
# Unlike the macOS leg this does not exempt --cart: there --cart means "some
# other cart, not OpenEmu's", but here it is how you name Mednafen's own second
# save file, in Mednafen's own save directory. --force is the way past it.
if [ -n "$WINEXE" ]; then
    echo "note     : MEDNAFEN_BIN is a Windows .exe, so this cart belongs to the Windows Mednafen, which no Linux process list can see. Close it before injecting."
elif [ -z "$FORCE" ] && command -v pgrep >/dev/null 2>&1 && pgrep -x mednafen >/dev/null 2>&1; then
    if [ -n "$DRY" ]; then
        echo "note     : Mednafen is running, so a real run would refuse (see --force)."
    else
        echo "error: Mednafen is running. It rewrites its battery saves when it exits, so an injection made now would be thrown away. Quit it and run this again, or pass --force." >&2
        exit 2
    fi
elif [ -n "$FORCE" ] && command -v pgrep >/dev/null 2>&1 && pgrep -x mednafen >/dev/null 2>&1; then
    echo "note     : --force: Mednafen is running. If it has this disc, quitting it will overwrite this cart."
fi

# --- the build, the merge, the backup, the write, the read-back -----------
# The note is the ambiguity warning; it belongs above the line that says which
# cart was written, not below the line telling you to go and load it.
[ -z "$NOTE" ] || echo "$NOTE"
if [ -n "$CART" ]; then
    sh "$CORE" "$@"
else
    sh "$CORE" --cart "$STEM.bcr" "$@"
fi

# --- start the game -------------------------------------------------------
# The user's own launcher, because it is the one that knows the BIOS, the
# LD_LIBRARY_PATH of an extracted Mednafen and the disc. Nothing here passes
# -filesys.fname_sav: the cart just written is the one that emulator's own
# config resolves to, and forcing a name could point it at a different file.
[ -z "$DRY" ] || exit 0
[ -n "$LAUNCH" ] || exit 0
# The launcher starts a Mednafen that resolves its own save directory —
# $MEDNAFEN_HOME/sav, else ~/.mednafen/sav. If the cart just written is not in
# there, the game would come up with a LOAD screen that does not show this
# level, which is a worse outcome than not starting it. Say which it is.
if [ -n "$WINEXE" ]; then
    echo "note     : MEDNAFEN_BIN is a Windows .exe, so the cart just written is the Windows Mednafen's; dezaemon2.sh starts the Linux one, on a different cart. Start Dezaemon 2 yourself, then LOAD."
    exit 0
fi
if [ -z "$DEFAULT_SAVES" ] || [ "$SAVES" != "$DEFAULT_SAVES" ]; then
    echo "note     : that cart is not the one your launcher's Mednafen would open (${DEFAULT_SAVES:-no \$MEDNAFEN_HOME and no \$HOME}), so the game was not started. Start Dezaemon 2 yourself, then LOAD."
    exit 0
fi
if [ -n "${DEZAEMON_SH:-}" ]; then
    [ -f "$DEZAEMON_SH" ] || { echo "error: DEZAEMON_SH is \"$DEZAEMON_SH\", and there is no such file. The level is on the cart; start Dezaemon 2 yourself, or pass --no-launch." >&2; exit 2; }
    LAUNCHER=$DEZAEMON_SH
else
    LAUNCHER=""
    for c in "${HOME:-}/saturn/dezaemon2.sh" "${HOME:-}/dezaemon2.sh" "${HOME:-}/bin/dezaemon2.sh" "$DIR/../../../../dezaemon2.sh"; do
        if [ -f "$c" ]; then LAUNCHER=$c; break; fi
    done
    if [ -z "$LAUNCHER" ]; then
        echo "note     : no dezaemon2.sh found (\$DEZAEMON_SH, ~/saturn, ~, ~/bin, beside the repo), so the game was not started. Start it yourself, then LOAD."
        exit 0
    fi
fi
echo "launching: $LAUNCHER"
# Honour the launcher's own shebang when it is executable: the user's
# dezaemon2.sh says #!/usr/bin/env bash, and one array or one [[ ]] in a future
# revision would make `sh` — dash, on Ubuntu and WSL — fail on their file with
# this script's name on the error. The `sh` fallback is for a launcher checked
# out without +x, which is exactly what a /mnt/c checkout gives you.
if [ -x "$LAUNCHER" ]; then exec "$LAUNCHER"; fi
exec sh "$LAUNCHER"
