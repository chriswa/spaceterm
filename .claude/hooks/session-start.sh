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

# --ignore-scripts skips the `electron-rebuild` postinstall, which compiles
# native modules against Electron's headers and needs a toolchain we do not
# have. The repo has no native dependencies of its own (the PTY layer is a
# separate Go daemon, and @echogarden/macos-native-tts is an optional
# macOS-only module), so skipping it costs nothing.
#
# `npm install` rather than `npm ci` on purpose: the container image is cached
# after this hook completes, so a resumed session finds node_modules already
# current and install becomes a no-op. `npm ci` would wipe and reinstall every
# time.
npm install --ignore-scripts --no-audit --no-fund

# --ignore-scripts ALSO skips electron's own postinstall, which is unrelated to
# electron-rebuild: it is a zip download, not a native compile. Skipping both
# together is what made "a headless agent cannot launch the GUI" true, and it
# was never actually necessary — the binary downloads fine here, Xvfb is
# present, and `npm run test:e2e` drives the real app. Idempotent, cached in
# ~/.cache/electron (~3s warm), and never fatal: a machine without network
# still typechecks, lints and runs every unit test.
node scripts/ensure-electron-binary.mjs || true

echo "[session-start] dependencies ready — npm run typecheck / lint / test are available"
echo "[session-start] GUI tests: npm run test:e2e (needs xvfb-run on Linux)"
