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

Just the terminal, at a grid that fits the screen above the bottom bar. That grid is *borrowed*
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
A long press on the bare background is the desktop's right-button drag: a
dot marks the press, and moving the finger away from it zooms out about it
(`useZoomDrag`), back toward it zooms back in.
The server rebuilds the bundle a couple of seconds after its sources stop
changing (`MobileBuildKeeper` in `src/server/mobile-build.ts`) and tells the
phone. While anything is waiting — a server restart an agent flagged, a newer
native app, a newer page — sparks run round the rocket (`RocketButton.tsx`),
and in the toolbar sheet the button for each marches its ants: **↻** (restart
the server), **Install the app** (the Mac builds and installs it:
`src/server/mobile-install.ts`, the same `install.sh`) and **Reload client**.
These two sit after Help, where the desktop has fit-to-monitor, and only on the
phone (`mobileOnly` in `toolbar/registry.tsx`). A reload is not asked for while
a restart is, which reloads the page anyway, or while the app is behind, whose
replacement loads the new page (`clientStalenessStore.ts`). The build writes
`build.json` (its id and the native fingerprint from `ios/native-version.mjs`),
which `install.sh` also stamps into the app — see `update-check.ts`.

The bottom bar (`BottomBar.tsx`) is a solid band the canvas stops above: AI usage on the left, Control and the talk buttons in the middle, the toolbar's rocket on the right. It stays up over the toolbar sheet, where the rocket closes the sheet again, and over the terminal view, which stops above it (costing a few rows); it goes while the composer is open, which has its own microphone. Its left shows AI usage as AI Spend Tracker's menu-bar bars,
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

## Control's transcript

A long press on Control — the headset on the bottom bar, or its button in the
toolbar sheet — opens the whole conversation with Control above the bottom
bar, with a box to type to it (`ControlTranscript.tsx`, shared with the
desktop, where it is a dialog). It reads Control's full record
(`~/.spaceterm/receptionist/conversation.jsonl`), not its session, so
compaction never shortens it: it opens at the newest and loads older pages as
you scroll up. A tap on Control still brings it here or lets it go.

While it is open the bar stays up: the headset is a down arrow that closes it,
and the talk button talks to Control, whatever the voice target, with what it
heard appearing at the bottom. It and the toolbar sheet are screens, not
layers — opening one closes the other — and a one-finger sideways drag
dismisses either, as it leaves the terminal view (`swipe-dismiss.ts`), except
from the sheet's button strip, which scrolls sideways, a row's reorder handle,
or the transcript's text box. Agents Control quoted by handle alone
are named from the record and log (`transcript-names.ts`), since the name
registry forgets archived agents; one never named shows its title.

What you cut Control off in the middle of is struck out once you interrupt:
the words you never heard, and — as dashed pills, "not done, cut off" — the
actions that were waiting on them and so never ran. Both are recorded as
transcript-only lines the model never sees (`amendHeard`, `notDone` in
`real-deps.ts`). The view follows new content while you are near the bottom,
including the circle that turns while Control thinks; a button takes you back
down when you are not.

## Hands-free: "Control … over and out"

The hold-mic button (the microphone with a lock, right of the talk button) is
the always-listen switch. While it holds the microphone, start talking with
**"Control"** — "Control, what's Kevin doing?" — and just keep going. The
phone taps (a haptic) and the button turns green; nothing waits on that, since
the dictation is fed everything from your first syllable out of the
listener's buffer. End with **"over and out"**, or just stop: at each pause
the Mac's turn model (Smart Turn, `src/server/turn-detector.ts`) judges from
your words and intonation whether you sound finished, and if it is sure, the
dictation ends there. If it is not, a pause still ends it once it outlasts a
patience that grows with how long you have been talking — a second and a half
for a quick request, up to twenty seconds five minutes into a monologue. The
end tone means it was heard and sent: "Control" comes off the
front, "over and out" off the end, and the rest goes to Control, which comes
to this phone. The dictation itself is ordinary Wispr, as the talk button's.

- **Only "Control" said first counts**, with nobody talking just before it;
  the word anywhere else in a sentence never triggers. "Talking" is judged by
  a voice-activity model on the phone (Silero VAD, `speech-detector.ts`,
  1.3 MB, run in ONNX Runtime web at about 0.3 ms per 32 ms frame), so music,
  a fan or a noisy room never count as talk and never block it; without the
  model, loudness stands in.
- **"Control." on its own, then a breath** is fine: that first pause is not
  put to the turn model (which would call "Control." finished), and it waits
  five seconds (`afterWakeWordMs`) for the rest.
- **In the app** the microphone is the app's own (`NativeMicrophone.swift`,
  `native-microphone.ts`), so no AirPods are needed: it plays through the
  speaker, keeps listening with the screen locked, and comes back by itself
  after Siri, a call, a relaunch, or AirPods coming and going. In a browser
  the page holds it, and only with a headset (`held-microphone.ts`).
- **Nothing leaves the phone** until you start talking with nobody talking
  just before (`wake-listener.ts`). Only the first second of that goes to the Mac, where
  Voice Operator checks whether it starts with "control", with Apple's
  on-device model (`POST /v1/wake-word?match=start`) — never Wispr. Audio is
  otherwise only ever in an eight-second buffer in memory. "Over and out" is
  listened for by the same on-device model on the Mac, alongside Wispr, only
  during a dictation.
- It does not listen while the phone is playing anything, or for a moment
  after, so Control never wakes itself; nor during a dictation it did not
  start.
- **The turn model** is fetched once (8 MB, pinned and hash-checked) into
  `~/.spaceterm/models`, loaded when the first hands-free dictation starts, and
  kept: about 130 MB of the server's memory, about 45 ms a check. Without it,
  pauses end dictations on silence alone.
- **Thresholds** are in `~/.spaceterm/hands-free.json` on the Mac, read again
  whenever it changes — any of `noSpeechBeforeMs` (700), `onsetWindowMs`
  (1000), `wordMinMs` (250), `pauseCheckMs` (300), `turnThreshold` (0.5, a
  probability), `wakeWordOnlyMs` (1500), `afterWakeWordMs` (5000),
  `endSilenceMinMs` (1500), `endSilenceMaxMs` (20000), `endSilenceRampMs`
  (300000), `maxUtteranceMs` (600000), `playbackTailMs` (400).
- **Why it did or did not trigger** is in `~/.spaceterm/mobile-events.jsonl`:
  a `hands-free-speech` event for every burst of speech the listener noticed —
  how long, how long without speech before it, how loud, and its verdict
  (`checked`, `after-speech`, `too-short`) — then `wake-word` with the Mac's
  answer; `hands-free-levels` every 30 s with the room's level and how much of
  it was speech; `hands-free-detector` with which speech detector is in use;
  `hands-free-pause` for the pause after the wake word alone. Never what was
  said. The server log's `[turn]` lines give each pause's verdict.

## Notifications: approving opProxy from the phone

The bell left of the rocket (`NotificationsButton.tsx`) is the phone's
notifications, which today are opProxy's pending 1Password approvals. Dim with
none; lit in the loudest request's tone with some; pulsing while any is unread,
which ends when the list has shown it. The list (`NotificationsSheet.tsx`) is a
screen like Control's transcript; a row opens the request (`ApprovalView.tsx`).
A request vanishes when it is answered anywhere or times out.

Spaceterm does not know what it is approving. The server only relays
opProxy's feed (`src/server/approval-feed.ts`), and the phone draws the
provider's document from a few generic blocks — see `APPROVAL_FEED.md` at the
repo root, which is the contract. New options, colours or buttons are
opProxy's to add.

Answers are signed by a Secure Enclave key in the iPhone app
(`ios/SpacetermMobile/NativeApprovals.swift`, `native-approvals.ts`), which
opProxy pairs once, confirmed with Touch ID at the Mac. Deny is signed at a tap.
Approve is the app's own slide panel, docked where the bottom bar would be: the
page arms it with the chosen options, and it shows the document's confirm line
and those options itself, and signs only once slid all the way across. That
panel is the part a modified web page cannot fake. No Face ID, by choice. In
Safari the phone can look but not answer.

## The audio and lifecycle record

Every microphone, dictation, playback and app-switching event the phone sees
is appended, one JSON object per line, to `~/.spaceterm/mobile-events.jsonl`
on the Mac — forever, outside git — for tracing a microphone that did not come
back, or an answer that talked over a dictation. `mobile-events.ts` keeps
events in the page's storage until the server acknowledges them, so a dropped
socket, a suspended page or one iOS killed loses nothing; the server
(`src/server/mobile-events.ts`) skips a resent batch's duplicates.

Each line has `kind`, `t` (the phone's clock), `detail`, and `ctx` — the
hold, hands-free phase, dictation, audio session and whether anything was
playing at that moment. `src: "native"` lines come from the iPhone app
(`NativeEvents.swift`), which keeps running in the background while iOS
suspends the page: launches (and whether the last run ended in the
background — killed — or terminated), background and foreground, screen lock,
calls, audio interruptions, route changes with the inputs and outputs before
and after (AirPods coming and going), the input muted from the AirPods stem,
another app wanting quiet, WebKit taking the microphone, Low Power Mode and
heat, page loads, and a `native-heartbeat` every minute with the audio
session, the microphone's seconds heard and peak level, how long an
interruption has gone unended, and whether the page answers a ping.
`src: "server"` lines are what the server saw: the phone connecting and
disconnecting, and speech jobs sent to it and how each ended.

Nothing is fired into the void. The app numbers its events (`nativeSeq`) and
keeps them in a file until the server has written them: the page records
them, the server acknowledges the batch, and only then does the page tell the
app it may forget them. Every new page is handed all the app still holds; the
page skips what it already has, and the server skips any `nativeSeq` it has
written, across restarts too.

A page has no event for being put to sleep; a `woke` line with `asleepMs`
says it was, and `heartbeat` lines say it was still running while hidden.
Nothing said is recorded — only lengths.

    jq -c 'select(.kind | test("interruption|route|hold|native-mic"))' ~/.spaceterm/mobile-events.jsonl

While a dictation is sending your voice to be transcribed, an orange **MIC**
sits above the Dynamic Island (`MicIndicator.tsx`); it pulses while the words
are waited for. The microphone merely held open for hands-free shows nothing
there. It uses only the strip above the island — iOS widens the island for Now
Playing and the like, and a page cannot see that — so the island's top (an
iPhone 17's) is the one measurement, in `mobile.css`.

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

A phone that moves between tailnets — home and work, say — needs every Mac's
address, and the app tries them all at launch and keeps whichever answers
first. `ios/macs` (committed) names each Mac by tailnet host name;
`~/.spaceterm/other-macs` (private, since it carries tokens) holds the other
Macs' pairing URLs, one `npm run mobile:link -- --url` line each. The build
refuses, saying what to fill in, when this Mac is not in `ios/macs` or a listed
Mac has no line in `other-macs` (`src/cli/mobile-macs.ts`).

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
