#!/bin/bash
# SessionStart hook — installs node dependencies so a cloud session can run
# `npm run typecheck`, `npm run lint`, and `npm test` immediately.
#
# Without this, Claude Code on the web starts from a fresh clone with no
# node_modules, and every verification command fails with a confusing
# "Cannot find type definition file for 'node'" instead of "deps missing".
set -euo pipefail

# Local (macOS) developers already run `npm install` themselves via the README,
# and that path needs the electron-rebuild postinstall we deliberately skip
# below. Only set up the remote/web environment here.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

# CLAUDE_PROJECT_DIR is set by the hook runtime, but fall back to the repo root
# derived from this script's own location so the hook can also be run by hand
# (`.claude/hooks/session-start.sh`) to verify it still works.
cd "${CLAUDE_PROJECT_DIR:-"$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"}"

# --ignore-scripts skips the `electron-rebuild` postinstall and Electron's
# ~100MB binary download. Neither is needed to typecheck, lint, or test:
# the repo has no native dependencies (the PTY layer is a separate Go daemon,
# and @echogarden/macos-native-tts is an optional macOS-only module).
# A headless agent cannot launch the GUI anyway.
#
# `npm install` rather than `npm ci` on purpose: the container image is cached
# after this hook completes, so a resumed session finds node_modules already
# current and install becomes a no-op. `npm ci` would wipe and reinstall every
# time.
npm install --ignore-scripts --no-audit --no-fund

echo "[session-start] dependencies ready — npm run typecheck / lint / test are available"
