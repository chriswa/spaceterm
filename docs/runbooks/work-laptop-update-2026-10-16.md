# Updating the work laptop: 9 Oct → 16 Oct 2026

How to bring a checkout last run on Fri 9 Oct 2026 up to `main` as of
Fri 16 Oct 2026 (148 commits, `5f329a5`…`88c8668`).

**Summary:** No migration is needed for persisted state, config, data files or
the database. There is one manual cleanup, and only for a machine that has
launched Cursor or Codex inside Spaceterm. Node must also be new enough.

## What was checked

All 148 commits in the range, plus the repo's docs, looking for migrations.
The only migration note in the repo is MODDING.md's "State migrations — Done",
which refers to `src/server/state-migrations.ts`. No commit in the range
changed that file.

### Persisted state: safe, nothing to convert

- **New files:** Control (the receptionist) now keeps four new files under
  `~/.spaceterm/receptionist/`: `ended.json` (7c9b896), `pending-news.json`
  (7c9b896, e215552), `deferred-reads.json` (c8eaf5a) and `back-burner.json`.
  Each is created on first use, and a missing file loads as empty.
- **Changed files:**
  - `backlog.json` gained an optional `out` field (e215552). The old `{items}`
    shape still loads.
  - `state.json` (`ServerState`) only gained an optional `receptionistMuted`
    (4d15066).
- **Browser storage:** the transcript's "Reasoning" toggle is now "Activity"
  (d98c6f9). It reads the old localStorage key as a fallback.

### Client and server must be updated together

The client protocol went to v16 (4d15066). Restart both after pulling, which
the steps below do.

### PTY daemon: unchanged

Nothing under `pty-daemon/` changed. Leave it running and the terminals
survive the update.

### The one real catch: a dropped migration (19edab4)

Before 10 Oct, Spaceterm wrote its own entries into the user's agent config:

- hook entries in `~/.cursor/hooks.json` and `~/.codex/hooks.json`
- the profile file `~/.codex/spaceterm.config.toml`
- a `statusLine` in `~/.cursor/cli-config.json`

Commit 48f631b (10 Oct) switched to passing the hooks with each launch
(`--plugin-dir` for Cursor, `-c` overrides for Codex). It also added a one-time
cleanup that removed the old entries. Commit 19edab4 deleted that cleanup later
the same day.

A machine that ran the code between those two commits got cleaned up. A
machine that jumps from 9 Oct straight to `main`, as the work laptop will,
never runs the cleanup. Any old entries left behind make Cursor and Codex hooks
fire twice, so they have to be removed by hand (step 5).

The `statusLine` in `~/.cursor/cli-config.json` was never part of that cleanup.
Leave it alone: the handler it points to is still copied to
`~/.spaceterm/cursor-agent-plugin/scripts/`, and the README ("Cursor's status
line") now asks you to set it up yourself anyway.

### Node version

`package.json` now requires `"node": "^22.22.2 || >=24.15.0"` (6d9d0ec), and
`.npmrc` sets `engine-strict=true`. On an older Node, `npm install` refuses to
run. The server's new restart-in-place (0788fd8) also uses `process.execve`,
which these versions have.

### Dependencies

The only change in `package-lock.json` is that the optional
`@echogarden/macos-native-tts` package was removed (6d9d0ec). `postinstall`
now runs `electron-rebuild && npm run electron:install`, so it also checks
Electron's binary and registers the URL scheme.

### SpacetermBar

Its Swift sources changed (e.g. `Shell.swift`). It now also finds `node` when
only `.zshrc` puts it on PATH (nvm, fnm, volta), by asking an interactive shell
when a login shell finds none. It needs a rebuild to pick this up.

## Steps at work

### 1. Check Node first

```sh
node -v    # need >= 22.22.2 (on 22.x) or >= 24.15.0
```

If it's older, upgrade Node before anything else.

### 2. Shut down the client, then the server

Leave the pty-daemon running.

- With SpacetermBar: menu → Stop client, then Stop server.
- With `npm run dev` in a terminal: Ctrl-C it.

Why stop them:

- `electron-vite dev` hot-reloads the renderer when the pull changes files.
  That would put a v16 renderer against the old server.
- `npm install` rewrites `node_modules` under the running processes.

### 3. Pull

```sh
cd ~/spaceterm
git status    # should be clean
git pull
```

### 4. Install dependencies

```sh
npm install
```

### 5. Clean old Cursor/Codex hook entries (only if they exist)

Check first:

```sh
grep -l 'agent-plugin/scripts/hook-handler.sh' ~/.cursor/hooks.json ~/.codex/hooks.json 2>/dev/null
head -1 ~/.codex/spaceterm.config.toml 2>/dev/null
```

For each `hooks.json` the `grep` lists, back it up and strip only Spaceterm's
entries. These filters do what the deleted cleanup did: your own entries stay,
and an event left empty is dropped.

```sh
cp ~/.cursor/hooks.json ~/.cursor/hooks.json.bak
jq '.hooks |= with_entries(.value |= map(select((.command // "") | contains("/cursor-agent-plugin/scripts/hook-handler.sh") | not))) | .hooks |= with_entries(select(.value | length > 0))' ~/.cursor/hooks.json.bak > ~/.cursor/hooks.json

cp ~/.codex/hooks.json ~/.codex/hooks.json.bak
jq '.hooks |= with_entries(.value |= map(select([.hooks[]?.command // ""] | any(contains("/codex-agent-plugin/scripts/hook-handler.sh")) | not))) | .hooks |= with_entries(select(.value | length > 0))' ~/.codex/hooks.json.bak > ~/.codex/hooks.json
```

If the first line of `~/.codex/spaceterm.config.toml` is
`# Managed by Spaceterm`, delete the file:

```sh
rm ~/.codex/spaceterm.config.toml
```

Do not touch `~/.cursor/cli-config.json` (see above).

### 6. Rebuild SpacetermBar (if you use it)

```sh
cd ~/spaceterm/menubar && ./bundle.sh
```

This step is:

- **Required** if Node on that laptop comes from nvm, fnm or volta (`.zshrc`).
- **Optional** otherwise.

The script builds the app, installs it to `~/Applications` and relaunches it.
Quitting the bar leaves Spaceterm's services running.

### 7. Start the server, then the client

- With SpacetermBar: menu → Start server, then Start client.
- Without it:

  ```sh
  cd ~/spaceterm && npm run dev
  ```

  This starts both.

## Notes

- **Restarts are fixed after this update.** Before it, ↻ Restart ended in a
  SIGABRT crash that SpacetermBar and `npm run dev` treated as a crash. The
  server now relaunches itself in place (0788fd8).
- **The iPhone app's native code changed** (hands-free and AirPods work). If
  you install the phone app from the work laptop, run
  `src/mobile/ios/install.sh` at some point. The server doesn't need it to start.
- **Voice Operator** was treated as stateless and not reviewed.
