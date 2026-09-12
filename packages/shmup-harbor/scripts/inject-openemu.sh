#!/bin/sh
# Put a level in one of Dezaemon 2's five save slots on OpenEmu's cartridge —
# the macOS counterpart of `deno task sav:run`, which does the same for a
# standalone Mednafen. OpenEmu runs Saturn on the Mednafen core and keeps its
# battery saves in ~/Library/Application Support/OpenEmu/Mednafen/Battery Saves
# as <disc>.<md5>.bcr (the 512 KB cartridge, gzipped) + .bkr (the console's own
# 32 KB memory) + .smpc (the SMPC clock).
#
# This is the macOS leg of `deno task sav:inject` (scripts/sav-inject.ts picks
# the leg); the merge itself is lib/cart-inject.ts, reached through
# scripts/inject-cart.ts and shared with the Linux and Windows legs, which
# reach the same cartridge through Mednafen.
#
#   deno task sav:inject foo               # the cloud level "foo" -> the first free slot
#   deno task sav:inject foo --slot 3      # ...into slot 3, replacing what is there
#   deno task sav:inject                   # the bundled base game (foo.json), offline
#   deno task sav:inject foo --dry-run     # say what would happen, write nothing
#   deno task sav:inject --sav build/sav/'Dez 2 - foo.sav'   # an already-built .sav
#   deno task sav:inject foo --palette snes --comment ARENA  # extra flags go to build:sav
#
# Only the .bcr is written, and it is MERGED: the level goes into one slot and
# every other save on the cart is left byte-identical. The .bkr holds Dezaemon
# 2's own DEZA2___SYS options record and a built .sav's internal partition is
# empty, so writing it could only ever destroy something — it is never opened.
# The .smpc is the emulated RTC and is never touched. The previous cart is
# copied to backup/ first (restore it with
# `cp backup/<name>.<timestamp>.bcr <name>.bcr`), and the new one is read back
# — every save that was already there is compared byte for
# byte — before the task reports success.
#
# The md5 in the file name is Mednafen's own game hash, computed inside the
# core: it is not the md5 of the .cue or the .bin, it is not in OpenEmu's
# library database, and it cannot be worked out here — so the save set is found
# by globbing, which means Dezaemon 2 must have been launched in OpenEmu once.
# Quit the game before running: OpenEmu rewrites its battery saves on close.
#
# One more thing can undo an injection, and it is not this script's to fix: a
# save state carries its own copy of the cartridge. Resume one and the console
# sees the cart as it was when the state was made, then writes that back over
# the .bcr on quit. So the run ends by naming the disc's Auto Save State when
# there is one. It is left alone rather than moved aside — OpenEmu tracks save
# states in its Core Data library (Game Library/Library.storedata, ZSAVESTATE),
# and a folder moved out from under it leaves a dangling row.
set -eu

# The emulator this leg drives, and what --no-launch does on it. The Mednafen
# legs export both before delegating here, so one usage text serves all three
# platforms instead of telling a WSL user about OpenEmu three times. (Setting
# SAV_INJECT_EMU by hand therefore renames the emulator in the report; that is
# what it is for.)
EMU=${SAV_INJECT_EMU:-OpenEmu}
NOLAUNCH=${SAV_INJECT_NOLAUNCH:-"inject only, do not start the game — OpenEmu is a library and
                 is never started from here, so on macOS this flag only keeps
                 one command line working on all three platforms"}

usage() {
    # Unquoted heredoc: $EMU and $NOLAUNCH are substituted, which is the point.
    # The two literal backticks below are escaped for the same reason.
    cat <<USAGE
usage: deno task sav:inject [level] [--slot 1-5] [--sav FILE] [--cart FILE]
                            [--dry-run] [--force] [--no-launch]
                            [--] [build:sav flags...]

  level          a cloud level name, a path to a level .json, or nothing for the
                 bundled base game — whatever \`deno task build:sav\` accepts
  --slot 1-5     the Dezaemon 2 save slot (DEZA2____NN). Default: the slot whose
                 comment already matches this level, else the lowest free one
  --sav FILE     inject a .sav that already exists instead of building one
  --cart FILE    write this .bcr instead of finding $EMU's
  --dry-run      report the slot, the size and the backup — write nothing
  --force        write even while a game is running in $EMU
  --no-launch    $NOLAUNCH
  --             everything after this goes to build:sav, flags above included
  anything else  passed straight to scripts/build-sav.ts (--palette, --comment,
                 --horizontal, --two-player, ...)

The cart it replaces is kept: restore one with
  cp <saves>/backup/<name>.<timestamp>.bcr <saves>/<name>.bcr
USAGE
}
fail() { echo "error: $1" >&2; exit 2; }

# A path as the caller meant it, before this script moves to the repo root.
abspath() {
    case $1 in
        /*) printf '%s\n' "$1" ;;
        *) printf '%s\n' "$PWD/$1" ;;
    esac
}

SLOT=""; SLOT_SET=""; SAV=""; CART=""; FORCE=""; DRY=""
# POSIX arg rotation: our own flags are consumed, everything else is pushed to
# the end of "$@" and ends up as the build:sav argument list.
n=$#
while [ $n -gt 0 ]; do
    a=$1; shift; n=$((n - 1))
    case $a in
        --slot) [ $n -gt 0 ] || fail "--slot needs a number 1-5"; SLOT=$1; SLOT_SET=1; shift; n=$((n - 1)) ;;
        --slot=*) SLOT=${a#--slot=}; SLOT_SET=1 ;;
        --sav) [ $n -gt 0 ] || fail "--sav needs a path"; SAV=$1; shift; n=$((n - 1)) ;;
        --sav=*) SAV=${a#--sav=} ;;
        --cart) [ $n -gt 0 ] || fail "--cart needs a path"; CART=$1; shift; n=$((n - 1)) ;;
        --cart=*) CART=${a#--cart=} ;;
        --dry-run) DRY=1 ;;
        --force) FORCE=1 ;;
        # build:sav's --out would send the .sav somewhere this script then would
        # not read; it owns that path. Say so rather than build into the void.
        --out|--out=*) fail "--out belongs to build:sav, which this task drives; sav:inject writes the cart, not a .sav. Build it yourself (deno task build:sav --out FILE) and pass it back with --sav FILE." ;;
        # The Mednafen legs start the game after injecting; OpenEmu has no
        # launcher of that kind, so both flags are taken and do nothing here
        # rather than being passed on to build:sav, which would reject them.
        --launch|--no-launch) ;;
        -h|--help) usage; exit 0 ;;
        # Everything after -- is build:sav's, even if it looks like one of ours.
        --) while [ $n -gt 0 ]; do set -- "$@" "$1"; shift; n=$((n - 1)); done ;;
        *) set -- "$@" "$a" ;;
    esac
done

if [ -n "$SLOT_SET" ]; then
    case $SLOT in
        [1-5]) ;;
        *) fail "--slot must be 1-5 (Dezaemon 2 has five game slots), got \"$SLOT\"" ;;
    esac
fi
if [ -n "$SAV" ] && [ $# -gt 0 ]; then
    fail "--sav takes an existing .sav; drop $1 (nothing is built)"
fi

# Resolve the caller's paths against the caller's directory, then work from the
# repo root — the Deno step below imports ./lib and ./packages by relative path,
# and `deno task` is not the only way this gets run.
[ -z "$SAV" ] || SAV=$(abspath "$SAV")
[ -z "$CART" ] || CART=$(abspath "$CART")
[ -z "$SAV" ] || [ -f "$SAV" ] || fail "no such .sav: $SAV"
cd "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
[ -f lib/mednafen.ts ] || fail "cannot find the repo from $0 — run this as: deno task sav:inject"
# The merge lives in a file of its own now, so a checkout missing it would fail
# as a module-resolution stack trace some way into the run. Say it here instead.
[ -f scripts/inject-cart.ts ] || fail "scripts/inject-cart.ts is missing — that is this leg's command line onto the merge in lib/cart-inject.ts. Is the checkout complete?"
[ -f lib/cart-inject.ts ] || fail "lib/cart-inject.ts is missing — that is the merge itself, shared by every leg and by sav:run. Is the checkout complete?"

# --- the cart file ---------------------------------------------------------
AUTOSTATE=""
if [ -n "$CART" ]; then
    if [ ! -f "$CART" ]; then
        # A save set whose cart has never been written is fine — the .bcr only
        # appears once the game saves — but a typo is not.
        STEM=${CART%.bcr}
        [ -f "$STEM.bkr" ] || [ -f "$STEM.smpc" ] ||
            fail "no such cart save: $CART"
    fi
    BCR=$CART
else
    [ "$(uname -s)" = Darwin ] || fail "OpenEmu is macOS only. Pass --cart PATH to write a .bcr somewhere else."
    [ -n "${HOME:-}" ] || fail "HOME is not set, so OpenEmu's save directory cannot be found. Pass --cart PATH."
    SAVES="$HOME/Library/Application Support/OpenEmu/Mednafen/Battery Saves"
    [ -d "$SAVES" ] || fail "no OpenEmu battery-saves directory at \"$SAVES\". Is OpenEmu installed, and has it run at least once?"
    # The .bcr is absent until the game first writes the cart, so fall back to
    # the .bkr and .smpc, which appear on the first quit; all three carry the
    # same <disc>.<md5> stem. Sub-directories (a hand-made deza-orig/) cannot
    # match, so a backup folder beside the saves is harmless.
    STEM=""; MATCHES=0; FOUND=""
    for ext in bcr bkr smpc; do
        for f in "$SAVES"/Dezaemon*."$ext"; do
            [ -e "$f" ] || continue
            MATCHES=$((MATCHES + 1)); STEM=${f%".$ext"}
            FOUND="$FOUND  $(basename "$STEM").bcr
"
        done
        [ $MATCHES -eq 0 ] || break
    done
    [ $MATCHES -gt 0 ] || fail "no Dezaemon 2 save in \"$SAVES\". OpenEmu names Mednafen saves <disc>.<md5>.bcr and only the core can work that md5 out — launch Dezaemon 2 in OpenEmu once and quit it, then run this again."
    if [ $MATCHES -gt 1 ]; then
        echo "error: $MATCHES Dezaemon 2 saves in \"$SAVES\" — cannot tell which disc you mean:" >&2
        printf '%s' "$FOUND" >&2
        echo "  pass --cart with one of those." >&2
        exit 2
    fi
    BCR="$STEM.bcr"
    # A save state holds its own copy of the cartridge, so resuming one both
    # hides this injection and writes the old cart back on quit. Name it.
    DISC=$(basename "$STEM"); DISC=${DISC%.*}
    STATE="$HOME/Library/Application Support/OpenEmu/Save States/Saturn/$DISC/Auto Save State.oesavestate"
    if [ -d "$STATE" ]; then AUTOSTATE=$STATE; fi
fi

# --- is OpenEmu about to undo this? ---------------------------------------
# A loaded game lives in a separate OpenEmuHelperApp process and flushes its
# battery saves when it closes, over whatever is on disk. Only OpenEmu's own
# cart is at risk from that, so --cart elsewhere is not held up by it.
if [ -z "$CART" ] && pgrep -x OpenEmuHelperApp >/dev/null 2>&1; then
    if [ -n "$FORCE" ]; then
        echo "note: --force: a game is running. If it is Dezaemon 2, quitting it will overwrite this cart."
    elif [ -n "$DRY" ]; then
        echo "note: a game is running in OpenEmu, so a real run would refuse (see --force)."
    else
        fail "a game is running in OpenEmu. It rewrites its battery saves when the game closes, so an injection made now would be thrown away. Quit the game (Cmd-W) and run this again, or pass --force."
    fi
fi

# --- build ----------------------------------------------------------------
if [ -z "$SAV" ]; then
    SAV=build/sav/.inject.sav
    trap 'rm -f "$SAV"' EXIT INT TERM
    deno run -A scripts/build-sav.ts --out "$SAV" "$@"
fi

# --- merge, back up, write, verify ----------------------------------------
# The byte work is Deno's: the .sav is 0xFF-interleaved, the .bcr is gzip, and
# the placement is packages/shmup-engine's, already unit-tested. It lives in
# lib/cart-inject.ts rather than in this file so the Windows leg, which has no
# `sh` to run this script with, imports the very same merge, and so the
# editor's route — which may not import a script — can too. The same four
# arguments the heredoc it replaced took, plus the emulator name: SAV_INJECT_EMU
# only names the emulator in the closing "load it" line, for the legs that
# delegate here.
deno run -A scripts/inject-cart.ts "$SAV" "$BCR" "$SLOT" "${DRY:-}" "${SAV_INJECT_EMU:-OpenEmu}"

if [ -n "$AUTOSTATE" ]; then
    echo "warning  : this disc has an Auto Save State" >&2
    echo "           $AUTOSTATE" >&2
    echo "           It holds its own copy of the cartridge, so resuming it hides this" >&2
    echo "           injection and writes the old cart back when the game closes. Start" >&2
    echo "           the game from the beginning, or delete that state in OpenEmu first." >&2
fi
