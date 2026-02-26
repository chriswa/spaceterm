# Spaceterm

Multiple terminals on a zoomable canvas. Built with Electron, React, and xterm.js.

## Requirements

- **macOS** (Apple Silicon or Intel)
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

Optional native modules (`audiotee` for audio capture, `@echogarden/macos-native-tts` for TTS) are in `optionalDependencies` — if they fail to compile, `npm install` still succeeds and those features are silently disabled.

## Running

```bash
npm run dev
```

This starts two processes concurrently:
- The spaceterm server (`tsx src/server/index.ts`) — auto-starts the PTY daemon if not already running
- The Electron client (`electron-vite dev`)

The PTY daemon is a separate long-lived process that manages terminal sessions. It starts automatically and persists across server restarts so terminal sessions are never lost. If you modify the Go code in `pty-daemon/`, use `npm run daemon:dev` to rebuild and restart the daemon.

App data lives in `~/.spaceterm/` (state, logs, hooks). The PTY daemon socket, PID file, and log are also in `~/.spaceterm/`.

## Optional: System audio capture (beat detection)

Spaceterm can capture system audio for real-time beat detection and visual effects. This uses the `audiotee` native module.

### macOS permissions

The terminal app you run `npm run dev` from (e.g. Terminal.app, iTerm2, Kitty) needs **Screen & System Audio Recording** permission:

1. Open **System Settings** → **Privacy & Security** → **Screen & System Audio Recording**
2. Enable the toggle for your terminal app
3. Restart the terminal app after granting permission

Audio capture auto-starts when the Electron window opens. If the permission hasn't been granted, it will silently fail (check `~/.spaceterm/electron.log` for `[audio-tap]` messages).

## Optional: Text-to-speech

Select text in a terminal and press **Cmd+Shift+S** to read it aloud. Works out of the box with the default macOS voice, but sounds better with a premium voice installed.

### Installing a premium voice

1. **System Settings** → **Accessibility** → **Spoken Content**
2. Click **System Voice** → **Manage Voices...**
3. Find **English (US)** → **Zoe** → download **Zoe (Premium)** (~300-500 MB)
4. Restart Spaceterm

The app auto-detects and prefers premium > enhanced > compact voices.

## Architecture overview

```
Electron main process
  ├─ BrowserWindow (React renderer)
  ├─ Audio capture + beat detection
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
| `npm run lint` | ESLint check (catches use-before-define bugs) |
| `npm run daemon:build` | Build the PTY daemon binary |
| `npm run daemon:dev` | Build + restart the daemon (use after modifying Go code) |
| `npm run et` | Emergency terminal (tmux-based fallback CLI) |
| `npm run et -- --daemon` | Emergency terminal direct to daemon (works without server) |
