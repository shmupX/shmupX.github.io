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
DENO_VERSION="${DENO_VERSION:-v2.5.3}"
export DENO_INSTALL="${DENO_INSTALL:-$HOME/.deno}"
DENO_BIN="$DENO_INSTALL/bin/deno"

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"

# Idempotent: the container state is snapshotted after a successful hook run, so
# a resumed session finds the binary already here and skips straight to the
# dependency warm-up.
if [ -x "$DENO_BIN" ]; then
  echo "deno already installed: $("$DENO_BIN" --version | head -1)"
else
  echo "Installing Deno $DENO_VERSION ..."
  # -s keeps curl's progress bar out of the hook's stdout; the installer itself
  # needs unzip, which the base image has.
  curl -fsSL https://deno.land/install.sh -o /tmp/deno-install.sh
  # DENO_NO_MODIFY_PATH: the installer would otherwise append to ~/.bashrc,
  # which a non-interactive hook shell never reads. PATH is handled below.
  DENO_NO_MODIFY_PATH=1 sh /tmp/deno-install.sh "$DENO_VERSION" >/dev/null 2>&1
  rm -f /tmp/deno-install.sh
  echo "Installed $("$DENO_BIN" --version | head -1)"
fi

export PATH="$DENO_INSTALL/bin:$PATH"

# MCP servers are spawned by the CLI, not by this shell, and they do not read
# $CLAUDE_ENV_FILE -- so a PATH export alone still leaves .mcp.json's
# shmupx-character server unable to find deno. /usr/local/bin is already on the
# default PATH, so a link there reaches every child process regardless of how
# it was started, and of whether it started before this hook finished.
if [ -w /usr/local/bin ] && [ ! -e /usr/local/bin/deno ]; then
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
