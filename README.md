# Spaceterm

Multiple terminals on a zoomable canvas. Built with Electron, React, and xterm.js.

## Requirements

- **macOS** (Apple Silicon or Intel) — native modules (`audiotee`, `node-pty`, `macos-native-tts`) are macOS-only
- **Node.js 18+** (tested on v22)
- **npm**

## Setup

```bash
git clone <repo-url>
cd spaceterm
npm install
```

`npm install` triggers `electron-rebuild` via `postinstall`, which compiles native modules (`node-pty`, `audiotee`, `@echogarden/macos-native-tts`) against Electron's Node version. If this step fails, ensure you have Xcode Command Line Tools installed:

```bash
xcode-select --install
```

## Running

```bash
npm run dev
```

This starts two processes concurrently:
- The spaceterm server (`tsx src/server/index.ts`)
- The Electron client (`electron-vite dev`)

App data lives in `~/.spaceterm/` (state, logs, hooks).

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

## Optional: Local image generation

Generates images locally using [mflux](https://github.com/filipstrand/mflux), an Apple Silicon-native tool built on MLX.

### Prerequisites

- macOS with Apple Silicon (M1 or later)
- [Homebrew](https://brew.sh)

### Install

```bash
brew install uv
uv tool install mflux
uv tool install "rembg[cpu,cli]"
```

First run of each tool downloads model weights (~6GB for mflux, ~176MB for rembg). Subsequent runs use cached models.


## Architecture overview

```
Electron main process
  ├─ BrowserWindow (React renderer)
  ├─ Audio capture + beat detection
  ├─ TTS
  └─ IPC to server via Unix socket

Standalone server (src/server/)
  ├─ Unix socket (~/.spaceterm/spaceterm.sock)
  ├─ PTY session management (node-pty)
  ├─ Canvas state persistence (~/.spaceterm/state.json)
  └─ Git status polling per directory
```

## Key scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Start server + Electron in dev mode |
| `npm run client:package` | Build + package as .dmg |
| `npm run lint` | ESLint check (catches use-before-define bugs) |
| `npm run et` | Emergency terminal (tmux-based fallback CLI) |
