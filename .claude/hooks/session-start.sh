#!/bin/bash
# SessionStart hook: put a Deno toolchain in front of a Claude Code on the web
# session.
#
# The remote image ships node and bun but no deno, and this repo is a Deno
# project end to end -- `deno task check`, `deno task test`, every `deno run`
# task in deno.json, and the shmupx-character MCP server in .mcp.json, which
# is spawned as `deno run -A mcp/server.ts` and dies with "Executable not found
# in $PATH: deno" without this. So the hook installs deno, puts it somewhere
# every child process can see, and warms the dependency cache.
set -euo pipefail

# Local checkouts already have a deno (and their own version of it, which is
# not ours to move); only the disposable remote container needs building up.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

# Pinned rather than "latest" so a session a month from now resolves the same
# toolchain a session today did. .github/workflows/eshop.yml asks for v2.x and
# deno.json's tasks assume Deno 2, so this tracks that line.
#
# Never below v2.8, which is where this was fixed (2.7.0 still hangs, 2.8.0 is
# clean on the same tree): before it, `deno fmt`/`deno lint` walking
# from the workspace root ignored a member's own fmt.exclude and lint.exclude.
# packages/shmup-engine excludes src/**, FORMAT.md, games-db.json and
# data/*.json for good reason: five of those files carry a single line of
# 12K-258K characters and a sixth is 448K of generated JSON, and deno fmt
# costs roughly the square of a line's length (4x the time per 2x the
# characters, measured). `deno task check` walked straight into them from the
# repo root and never came back.
DENO_VERSION="${DENO_VERSION:-v2.9.7}"
export DENO_INSTALL="${DENO_INSTALL:-$HOME/.deno}"
DENO_BIN="$DENO_INSTALL/bin/deno"

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"

want="${DENO_VERSION#v}"

installed_deno_version() {
  [ -x "$DENO_BIN" ] || return 1
  "$DENO_BIN" --version 2>/dev/null | head -1 | awk '{print $2}'
}

# Two sources for the same pinned binary, because the canonical one is not
# always reachable. install.sh comes from deno.land and redirects the actual
# download to dl.deno.land, and a session behind a policy-enforcing egress
# proxy can have both denied -- they answer 403 to CONNECT -- while github.com
# stays allowed, since that is where the repo itself lives. That is how this
# hook died on a bare `curl: (22)` and left .mcp.json's shmupx-character
# server with no interpreter to spawn, which reads at the other end as the MCP
# server being broken rather than the toolchain being absent. The GitHub
# release is denoland's own publication of the identical artifact, so the
# fallback changes the transport and nothing else.
#
# Both helpers judge themselves by the binary they were supposed to leave
# behind rather than by an exit code: the official installer fetches its own
# payload after the script has already been retrieved successfully, so its
# status says nothing about whether the download that matters landed.
install_from_deno_land() {
  # -s keeps curl's progress bar out of the hook's stdout; the installer itself
  # needs unzip, which the base image has.
  curl -fsSL --retry 2 https://deno.land/install.sh -o /tmp/deno-install.sh || return 1
  # DENO_NO_MODIFY_PATH: the installer would otherwise append to ~/.bashrc,
  # which a non-interactive hook shell never reads. PATH is handled below.
  DENO_NO_MODIFY_PATH=1 sh /tmp/deno-install.sh "$DENO_VERSION" >/dev/null 2>&1 || true
  rm -f /tmp/deno-install.sh
  [ "$(installed_deno_version || true)" = "$want" ]
}

install_from_github() {
  local triple
  case "$(uname -s)-$(uname -m)" in
    Linux-x86_64) triple="x86_64-unknown-linux-gnu" ;;
    Linux-aarch64 | Linux-arm64) triple="aarch64-unknown-linux-gnu" ;;
    *)
      # Only the remote container reaches this far, and it is Linux; anything
      # else is a surprise worth naming rather than guessing an asset for.
      echo "  no Deno release asset for $(uname -s)-$(uname -m)" >&2
      return 1
      ;;
  esac
  local tmp
  tmp="$(mktemp -d)"
  if curl -fsSL --retry 2 -o "$tmp/deno.zip" \
    "https://github.com/denoland/deno/releases/download/$DENO_VERSION/deno-$triple.zip"; then
    mkdir -p "$DENO_INSTALL/bin"
    # The archive is a single top-level `deno`. -o because replacing an old pin
    # would otherwise stop on an overwrite prompt this shell cannot answer.
    unzip -oq "$tmp/deno.zip" -d "$DENO_INSTALL/bin" || true
    chmod +x "$DENO_BIN" 2>/dev/null || true
  fi
  rm -rf "$tmp"
  [ "$(installed_deno_version || true)" = "$want" ]
}

# Idempotent, but on the VERSION rather than on the mere presence of a binary.
# The container state is snapshotted after a successful hook run, so a resumed
# session finds whatever the last one installed -- and a `[ -x "$DENO_BIN" ]`
# test alone would then keep that copy forever, which makes raising the pin
# above a no-op on exactly the containers that already carry the old, broken
# one. Compare and replace instead.
have="$(installed_deno_version || true)"

if [ "$have" = "$want" ]; then
  echo "deno $have already installed"
else
  if [ -n "$have" ]; then
    echo "deno $have is installed but this repo pins $want; replacing it."
  fi
  echo "Installing Deno $DENO_VERSION ..."
  if ! install_from_deno_land; then
    echo "  deno.land did not yield $want; trying the GitHub release ..." >&2
    if ! install_from_github; then
      echo "ERROR: could not install Deno $DENO_VERSION from deno.land or github.com." >&2
      echo "       Behind an egress policy, this needs deno.land and dl.deno.land," >&2
      echo "       or github.com and release-assets.githubusercontent.com, reachable." >&2
      echo "       Without deno, 'deno task' and the shmupx-character MCP server in" >&2
      echo "       .mcp.json cannot run at all." >&2
      exit 1
    fi
  fi
  echo "Installed $("$DENO_BIN" --version | head -1)"
fi

export PATH="$DENO_INSTALL/bin:$PATH"

# MCP servers are spawned by the CLI, not by this shell, and they do not read
# $CLAUDE_ENV_FILE -- so a PATH export alone still leaves .mcp.json's
# shmupx-character server unable to find deno. /usr/local/bin is already on the
# default PATH, so a link there reaches every child process regardless of how
# it was started, and of whether it started before this hook finished.
if [ -w /usr/local/bin ] && [ "$(readlink -f /usr/local/bin/deno 2>/dev/null)" != "$(readlink -f "$DENO_BIN")" ]; then
  ln -sf "$DENO_BIN" /usr/local/bin/deno
fi

# Persist for the agent's own shells. SessionStart fires on resume, clear and
# compact as well as startup, so guard the append: an unguarded one would stack
# another copy of the same two exports onto the env file every time.
if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  if ! grep -qs "DENO_INSTALL=\"$DENO_INSTALL\"" "$CLAUDE_ENV_FILE"; then
    {
      echo "export DENO_INSTALL=\"$DENO_INSTALL\""
      echo "export PATH=\"$DENO_INSTALL/bin:\$PATH\""
    } >> "$CLAUDE_ENV_FILE"
  fi
fi

# deno.json sets nodeModulesDir: "manual", so node_modules is not materialised
# on demand -- vite, esbuild and svelte are missing until something asks for
# them explicitly. `deno install` (not a lockfile-frozen equivalent) is the
# right call here: it both writes node_modules and fills the module cache, and
# the container snapshot keeps both for the next session.
cd "$PROJECT_DIR"
echo "Caching project dependencies ..."
for attempt in 1 2 3; do
  if deno install; then
    echo "Dependencies ready."
    break
  fi
  if [ "$attempt" -eq 3 ]; then
    # Deliberately not fatal. deno itself is installed and every task is
    # runnable; a registry blip should cost a re-run of one command, not the
    # whole session.
    echo "WARNING: 'deno install' failed after 3 attempts. Re-run it manually." >&2
    break
  fi
  echo "  attempt $attempt failed, retrying ..." >&2
  sleep $((attempt * 5))
done
