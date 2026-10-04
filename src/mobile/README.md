# Spaceterm mobile

A web app for the phone, served by the Spaceterm server and reached over
Tailscale. It is the desktop app with a different host underneath, not a
second client: as much as possible is literally the same code.

## What is shared, and how

| Piece | Desktop | Phone |
|---|---|---|
| Protocol client | `src/shared/server-client.ts` | same |
| `window.api` | `src/shared/client-api.ts` | same |
| Startup, resync, reconnect | `renderer/src/lib/install-api.ts` | same |
| Transport | Electron main's byte pipe to the Unix socket | WebSocket to `src/server/web-gateway.ts` |
| Host (window, perf, system) | preload | `browser-platform.ts` |
| Canvas | `App` | same `App`, plus touch (`useTouchCamera`) |
| A focused terminal | live in its card | the same `TerminalCard`, chromeless, full screen (`TerminalView.tsx`) |
| Ship it | `src/server/ship-it.ts` | same |

The one switch is `surfacePresenterStore`: with `external` set, `App` keeps
every canvas card on snapshots and publishes which terminal is focused, and
`MobileApp` draws it. Focus, unread handling and the camera stay `App`'s.

Phone-only: the gestures, the key row, the composer (dictate → edit → ship),
the surface list, dictation capture, and hands-free mode (below).

## The terminal view

Just the terminal, at a grid that fits the screen. That grid is *borrowed*
(`terminal-borrow-size`): the server keeps the surface's own size as a
persisted `homeSize` and gives it back when the view closes, when the phone
disconnects, or — if the server died mid-borrow — at its next start. A
deliberate resize on the desktop ends the borrow.

Touches never reach xterm (`terminal-gesture.ts`):

| Gesture | Does |
|---|---|
| drag up / down | scrolls — sent as wheel events, so the card's own routing picks the TUI's mouse protocol or the shell's scrollback, as on the desktop |
| swipe sideways, pinch in | back to the canvas the moment it goes far enough; the rest of the gesture pans or zooms the canvas (`handTouchToCanvas`) |
| tap | the composer, keyboard up |
| long press | a radial menu around the thumb: slide to **Keyboard** (the keyboard and extra-key row, typing straight into the terminal; *Hide keyboard* while it is up) or **Summarize** (Summary Chat), and let go. Letting go in the middle does nothing |

On the canvas, a long press on a card is the desktop's ⌘-click: the
quick-actions toolbar; moving on without lifting drags the card instead.
The server rebuilds the bundle a couple of seconds after its sources stop
changing (`MobileBuildKeeper` in `src/server/mobile-build.ts`) and tells the
phone. A yellow chip on the bottom bar, beside the rocket (`UpdatesButton.tsx`),
then lists what is waiting — a server restart an agent flagged, a newer native
app, a newer page — each with its own button: **Restart**, **Install** (the Mac
builds and installs the app: `src/server/mobile-install.ts`, the same
`install.sh`), **Reload**. The build writes `build.json` (its id and the native
fingerprint from `ios/native-version.mjs`), which `install.sh` also stamps into
the app — see `update-check.ts`.

The bottom bar (`BottomBar.tsx`) is a solid band the canvas stops above: AI usage on the left, Control and the talk buttons in the middle, the toolbar's rocket on the right. It stays up over the toolbar sheet, where the rocket closes the sheet again, and never shows over a terminal. Its left shows AI usage as AI Spend Tracker's menu-bar bars,
with the reading's age; the server reads the tracker's `--json` CLI
(`src/server/usage-tracker.ts`). Dictation streams 16 kHz PCM to the server, which
relays it through Voice Operator (`src/server/remote-dictation.ts`) — the only
process that may hold Wispr's rotating tokens.

Stacked over the AI usage on the bottom bar, against Control, is the Mac's
system monitor as mini-stats (`~/mini-stats`) draws it in the menu bar
(`SystemStatsReadout.tsx`), shrunk to fit and without the bars' letters.
mini-stats writes what its menu-bar item draws, colours and sizes decided, to
`~/.mini-stats/menubar.json`; the server reads it every 2 s, but only while a
phone is watching (`system-stats-watch`, `src/server/system-stats.ts`).

## Hands-free: "Control"

The hold-mic button (the microphone with a lock, right of the talk button) is
the always-listen switch. While it holds the microphone, saying **"Control"**
on its own — quiet before it, then a pause — plays the start tone and opens an
ordinary Wispr dictation on the microphone that is already open, exactly as
the talk button would. It ends when you stop talking, and the words go to
Control, which comes to this phone.

- **In the app** the microphone is the app's own (`NativeMicrophone.swift`,
  `native-microphone.ts`), so no AirPods are needed: it plays through the
  speaker, keeps listening with the screen locked, and comes back by itself
  after Siri, a call, a relaunch, or AirPods coming and going. In a browser
  the page holds it, and only with a headset (`held-microphone.ts`).
- **Nothing leaves the phone** until a burst of speech is one word long with
  quiet before it (`wake-listener.ts`). Only that clip, about a second, goes to
  the Mac, where Voice Operator checks it with Apple's on-device model
  (`POST /v1/wake-word`) — never Wispr. Audio is otherwise only ever in a
  three-second buffer in memory.
- It does not listen while the phone is playing anything, or for a moment
  after, so Control never wakes itself; nor during a dictation it did not
  start.
- **Thresholds** are in `~/.spaceterm/hands-free.json` on the Mac, read again
  whenever it changes — any of `silenceBeforeMs` (700), `silenceAfterMs` (400),
  `wordMinMs` (250), `wordMaxMs` (1000), `endSilenceMs` (1500),
  `noSpeechTimeoutMs` (6000), `maxUtteranceMs` (60000), `playbackTailMs` (400).
  The server log's `[hands-free]` lines say what each candidate measured and
  whether it was the word, never what was said.

## Running it

```
npm run mobile:build      # → out/mobile, served by the server on 127.0.0.1:7391
                          #   (the server also rebuilds it in the background on
                          #   startup whenever a source is newer than the build)
npm run mobile:link       # prints the pairing URL (and the tailscale serve step)
```

The gateway binds loopback only and requires the token from
`~/.spaceterm/web-token` on its socket. `tailscale serve --bg 7391` exposes it
to your tailnet with HTTPS, which Safari needs before it will open the
microphone. `SPACETERM_WEB_PORT=0` turns the gateway off.

## The iPhone app (`ios/`)

A native wrapper: one full-screen `WKWebView` on the gateway's tailnet URL,
which exists for what a browser tab cannot do — no browser chrome, a
microphone permission that sticks, and no form bar (AutoFill icons, ⌃ ⌄ Done)
above the keyboard (`FormAccessoryBar.swift`). It also reloads the page if iOS
kills its process. Everything else is the web app, so most changes need no
rebuild of this.

```
npm run mobile:ios        # build, sign, install on the paired iPhone, launch
```

Once only: accept Apple's latest Program License Agreement at
developer.apple.com (signing fails until you do); pair the phone in Xcode →
Devices and Simulators by cable and tick "Connect via network"; on the phone,
turn on Developer Mode. After that it installs over Wi-Fi. It builds against
the SDK rather than a device destination, so the multi-gigabyte iOS platform
download is not needed.

## Deliberately not done (yet)

- Text size is a hard-coded constant (`SCALE` in TerminalView.tsx, 0.94 —
  about 50 columns on a 393-pt phone); there is no control for it yet.
- No TTS on the phone and no push notifications.
- A reconnect reloads the page (as the desktop does); drafts and the open
  surface survive it.
