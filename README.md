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
- **Node.js 22.22+** (or 24.15+) — jsdom, which the tests run on, refuses anything older
- **npm**
- **Go 1.22+** — for the PTY daemon (`brew install go`)
- **Xcode Command Line Tools** — `xcode-select --install`; `npm install` compiles against them
- **git**
- **[Claude Code](https://docs.claude.com/en/docs/claude-code)** (`claude` on your PATH, signed in) — what most surfaces run. The [Cursor CLI](https://cursor.com/cli) (`agent`, 2026.08.11 or later — older ones ignore a plugin's hooks) and [Codex](https://github.com/openai/codex) (`codex`, 0.124.0 or later) are optional, for those surface types.

Everything else is optional; see [Optional companions](#optional-companions).

## Setup

```bash
git clone <repo-url>      # any directory works
cd spaceterm
npm install
npm run daemon:build      # initial build of the PTY daemon (Go)
```

`npm install`'s `postinstall` does two things. `electron-rebuild` compiles
native modules (if it fails, install the Xcode Command Line Tools). Then
`npm run electron:install` gives the development Electron its own bundle id, so
`spaceterm-surface://` links open this checkout rather than some other Electron
app — this has to be redone after every install, which is why it runs there.
It never fails the install; if links ever open the wrong app, run
`npm run electron:install` yourself.

The optional native module `@echogarden/macos-native-tts` (for TTS) is in `optionalDependencies` — if it fails to compile, `npm install` still succeeds and TTS is silently disabled.

## Before you run it

Spaceterm is built for one person supervising their own agents on their own
machine, and some defaults follow from that. Know these first:

- **Agents run with permission prompts and sandboxing off.** Every agent
  surface is launched with its CLI's bypass flag — Claude Code with
  `--dangerously-skip-permissions`, Cursor with `--yolo --trust --approve-mcps`,
  Codex with `--dangerously-bypass-approvals-and-sandbox`
  (`src/server/agent-drivers.ts`). An agent will run any command and edit any
  file without asking. There is no setting for this today; check your
  employer's policy before using it on a work machine.
- **The Chrome DevTools port is always open**, on `127.0.0.1:9222`, so a
  session that has misbehaved for hours can be profiled without a restart. It
  is not reachable from the network, but it has no authentication: any process
  on this machine can attach, read every terminal and run script in the app.
  `SPACETERM_DEBUG_PORT=<port>` moves it (for example when another Chromium app
  already holds 9222).
- **Claude Code surfaces replace your status line** with Spaceterm's, inside
  Spaceterm only.

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

## Optional companions

Each of these is found wherever it is installed — by PATH or by a file it
publishes — so any directory works. `npm run cli -- capabilities` reports
which of them this machine has.

| Companion | Used for | Without it | Get it |
|---|---|---|---|
| [Voice Operator](https://github.com/chriswa/voiceop) | Speech: Control, phone dictation and hands-free | Nothing is spoken; voice commands do nothing | Private repo — ask for access. Found through `~/Library/Application Support/VoiceOperator/speech-service.json`, which it writes when running. Needs a build with `/v1/subscribers` (October 2026 or later), or voice commands never reach Spaceterm. |
| `claude-print-daemon` ([chriswa-devkit](https://github.com/chriswa/chriswa-devkit), `tools/claude-print-daemon`) | Control (the receptionist), auto-stamp icons | Control reports an error on every turn; auto-stamps fail | Needs Go. Build it into the devkit's `bin/` (see its README), and put `bin/` on PATH or set `CLAUDE_PRINT_DAEMON_BIN`. Uses your own signed-in Claude Code. |
| `jev` ([chriswa-devkit](https://github.com/chriswa/chriswa-devkit), `tools/jev`) | Agent search; Control's judgement of interruptions and its backlog | Agent search fails with "could not run jev"; Control loses those judgements | Needs [Bun](https://bun.sh) and a paid `TYPESAFE_API_KEY` in your shell's rc files. Put `bin/jev` on PATH. |
| Tailscale | Reaching the phone app | No phone app | MagicDNS and HTTPS certificates on; see `npm run mobile:link` and `src/mobile/README.md` |
| Xcode, an Apple ID, an iPhone | The native iPhone app (`npm run mobile:ios`) | Use the phone web app in Safari instead | Signing is per person: `src/mobile/ios/Local.xcconfig`, which the build tells you how to write. See `src/mobile/README.md`. |
| [AI Spend Tracker](https://github.com/chriswa/ai-spend-tracker) | The usage bars on the phone's bottom bar (Claude, Codex, Cursor rate-limit windows) | Bars stay empty | Download the notarized app from its releases into `/Applications`. Found while it is running wherever it lives; when it isn't, in `/Applications`, `~/Applications` or a `~/ai-spend-tracker/build` checkout, or set `SPACETERM_AI_SPEND` to its binary. |
| tmux | `npm run et`, the emergency terminal | That command says tmux is required | `brew install tmux` |

### Cursor's status line

Cursor surfaces show their context remaining, model and effort only if Cursor's
status line reports to Spaceterm. Cursor reads `statusLine` from
`~/.cursor/cli-config.json` and nowhere else — there is no per-launch way to
pass it — so Spaceterm leaves it to you. Without it, Cursor surfaces work
normally and just don't show those three.

The handler is copied to `~/.spaceterm/cursor-agent-plugin/scripts/` the first
time a Cursor surface launches. Then set, in `~/.cursor/cli-config.json`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "/Users/<you>/.spaceterm/cursor-agent-plugin/scripts/statusline-handler.sh",
    "updateIntervalMs": 1000
  }
}
```

Use the absolute path, as above. Outside Spaceterm the
handler prints nothing, so if you already had a status line, move its
`statusLine` object into `~/.spaceterm/cursor-statusline-passthrough.json`
(as `{"statusLine": {…}}`) and the handler runs it for you, inside Spaceterm
and out.

The first use of hands-free downloads an 8 MB turn-detection model from
Hugging Face into `~/.spaceterm/models`.

## Platform support

Spaceterm runs on macOS today. The coupling is narrower than that sounds — four
dependencies, all of which degrade rather than crash:

| Depends on | Used for | Without it |
|---|---|---|
| claude-print-daemon | Control and auto-stamps reaching Claude | Those report an error |
| Voice Operator | Speaking aloud | Text only, nothing is said |
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
