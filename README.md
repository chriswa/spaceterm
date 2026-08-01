# Spaceterm

Multiple terminals on a zoomable canvas. Built with Electron, React, and xterm.js.

## What it is for

A terminal multiplexer arranges terminals in a grid and expects you to remember
which is which. Spaceterm puts them on an infinite canvas instead, so *where* a
terminal is carries meaning: a surface spawned from another sits below it, a
fork sits beside its source, and the shape of what you are working on is
visible at a glance rather than held in your head.

That matters most when the terminals are agents. Spaceterm knows when an agent
is working, waiting on you, or has gone quiet, and shows it — so a dozen
concurrent Claude Code, Cursor or Codex sessions become something you can
supervise rather than poll. Around that: markdown and file cards pinned to the
canvas, per-directory git status, session fork and resume, and a scripts socket
agents can drive.

If you want one terminal, use a terminal. If you routinely have ten agents
running and lose track of which is stuck, this is what it is for.

## Requirements

- **macOS** (Apple Silicon or Intel) — see [Platform support](#platform-support)
- **Node.js 18+** (tested on v22)
- **npm**
- **Go 1.22+** — for the PTY daemon (`brew install go`)

## Setup

```bash
git clone <repo-url>
cd spaceterm
npm install
npm run daemon:build   # initial build of the PTY daemon (Go)
```

`npm install` triggers `electron-rebuild` via `postinstall`. If this step fails, ensure you have Xcode Command Line Tools installed:

```bash
xcode-select --install
```

The optional native module `@echogarden/macos-native-tts` (for TTS) is in `optionalDependencies` — if it fails to compile, `npm install` still succeeds and TTS is silently disabled.

## Running

```bash
npm run dev
```

This starts two processes concurrently:
- The spaceterm server (`tsx src/server/index.ts`) — auto-starts the PTY daemon if not already running
- The Electron client (`electron-vite dev`)

The toolbar's ↻ button restarts both processes. The `server:dev` and
`client:dev` commands each supervise their process and relaunch only when it
exits with Spaceterm's dedicated restart code, so this works equally well when
they run in separate terminal tabs. Ctrl+C still stops either command normally.
PTY sessions remain alive in the daemon across this restart.

The PTY daemon is a separate long-lived process that manages terminal sessions. It starts automatically and persists across server restarts so terminal sessions are never lost. If you modify the Go code in `pty-daemon/`, use `npm run daemon:dev` to rebuild and restart the daemon.

App data lives in `~/.spaceterm/` (state, logs, hooks). The PTY daemon socket, PID file, and log are also in `~/.spaceterm/`.

## Optional: Text-to-speech

Select text in a terminal and press **Cmd+Shift+S** to read it aloud. Works out of the box with the default macOS voice, but sounds better with a premium voice installed.

### Installing a premium voice

1. **System Settings** → **Accessibility** → **Spoken Content**
2. Click **System Voice** → **Manage Voices...**
3. Find **English (US)** → **Zoe** → download **Zoe (Premium)** (~300-500 MB)
4. Restart Spaceterm

The app auto-detects and prefers premium > enhanced > compact voices.

## Diagnostics

Several features are optional and fail softly, which is right — but softly is
not the same as silently. To see what this machine has:

```bash
npm run cli -- capabilities          # human-readable
npm run cli -- capabilities --json   # for scripts
```

Each line says what was looked for, whether it was found, and — when it was not
— what stops working because of it. The same report is written to
`~/.spaceterm/electron.log` every time the server starts, so the answer to "why
did nothing happen when I clicked that?" is already on disk.

`npm run cli -- protocol` reports the scripts-socket protocol version and the
full set of subscribable events, which is the handshake a script should perform
before relying on anything else.

## Platform support

Spaceterm runs on macOS today. The coupling is narrower than that sounds — four
dependencies, all of which degrade rather than crash:

| Depends on | Used for | Without it |
|---|---|---|
| `/usr/bin/security` (Keychain) | Reusing Claude Code's OAuth credential | Summary Chat reports an error |
| Voice Operator | Speaking summaries aloud | Summary Chat produces text, says nothing |
| `/usr/bin/pgrep` | Detecting background work | A surface may not drain back to idle on its own |
| `/usr/sbin/lsof` | Detecting a finished background command | Same |

Terminals, the canvas, agent state tracking, git status, fork and resume have
no platform-specific dependency. Running usefully on Linux is therefore mostly
the two shell-outs; `capabilities` above will tell you exactly what is missing
on any given machine.

## Architecture overview

```
Electron main process
  ├─ BrowserWindow (React renderer)
  ├─ TTS
  └─ IPC to server via Unix socket

PTY daemon (pty-daemon/) — Go binary, long-lived
  ├─ Unix socket (~/.spaceterm/pty-daemon.sock)
  ├─ PTY lifecycle (create, write, resize, destroy)
  ├─ 1MB ring buffer per session (output replay on reconnect)
  └─ Sessions survive server restarts

Standalone server (src/server/)
  ├─ Unix socket (~/.spaceterm/spaceterm.sock)
  ├─ Talks to PTY daemon for terminal I/O
  ├─ Canvas state persistence (~/.spaceterm/state.json)
  └─ Git status polling per directory
```

## Key scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Start server + Electron in dev mode |
| `npm run client:package` | Build + package as .dmg |
| `npm run typecheck` | Type-check both projects — nothing else checks contracts between server, preload and renderer |
| `npm test` | Unit and component tests — node + jsdom projects, ~6s |
| `npm run test:e2e` | Launches the real app (Electron + server + Go daemon) and drives it, ~40s |
| `npm run test:all` | Both of the above |
| `npm run lint` | ESLint check (catches use-before-define bugs) |
| `npm run cli -- <cmd>` | The scripts CLI — see `npm run cli -- --help` |
| `npm run daemon:build` | Build the PTY daemon binary |
| `npm run daemon:dev` | Build + restart the daemon (use after modifying Go code) |
| `npm run et` | Emergency terminal (tmux-based fallback CLI) |
| `npm run et -- --daemon` | Emergency terminal direct to daemon (works without server) |

## Testing

Three layers, split by what they need rather than by where the files live:

| Project | Environment | Covers |
|---|---|---|
| `node` | node | Server, shared logic, the CLI. Dependency-injected classes and pure functions. |
| `renderer` | jsdom | React components and renderer libraries, against a fake preload bridge. |
| `e2e` | real Electron | The three processes actually talking to each other. |

`npm test` runs the first two. The third needs Electron's ~100 MB binary and a
display, so it is a separate command:

```bash
npm run test:e2e     # builds, fetches the binary if needed, runs under Xvfb on Linux
```

**On the Electron binary.** `npm install --ignore-scripts` — which CI and cloud
agent sessions use to skip the `electron-rebuild` postinstall — also skips
*electron's own* postinstall, which is unrelated: one compiles native modules,
the other downloads a zip. `npm run electron:install` fetches it, is idempotent,
and is cached in `~/.cache/electron` (about three seconds warm). The session
hook runs it automatically.

Writing a renderer test needs no Electron at all. The renderer's only
Electron-specific dependency is `window.api`, so
`src/client/renderer/src/testing/fake-bridge.ts` stands in for it —
`installFakeBridge()` and you can render any component. A test
(`renderer-purity.test.ts`) keeps that true by failing if anything reachable
from the renderer entry point imports a Node builtin.

## Contributing

- `CLAUDE.md` — conventions this repo holds itself to, including the testing
  rule that has found the most bugs: if a module cannot be tested without
  reaching into `fs`, `child_process` or a timer, **adding the seam is the
  deliverable**, not a mock.
- `NEXT_STEPS.md` — the prioritised backlog, what the last few sessions found,
  and the ideas worth picking up next.
- `MODDING.md` — how features become mods, and why the scripts socket is
  already most of an extension API.
