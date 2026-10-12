# The phone in Control mode: spending nothing on the canvas

FEATURE: While Control's transcript is up, or the phone is locked in a pocket
holding Control, the phone stops receiving, parsing and drawing the canvas, and
does only what talking to Control needs, while still showing agent spend and
mini stats.

CAVEATS:
- Coming back to the canvas costs a burst: one fresh snapshot per terminal
  card, about 25 × 11 KB here, plus whatever re-render the canvas needs. It
  should take well under a second, but it is not free.
- The phone's canvas is stale while paused, by design. Anything that reads
  canvas state while it is paused (tapping an agent's name in the transcript to
  fly to its card) has to un-pause first.
- The locked phone's own energy can't be measured with the tool we have
  (`energy.sh` needs the phone unlocked). The proof in the locked state would
  be counts the page reports about itself, not milliwatts.

Written October 2026 against `fc00775` as a proposal. **Steps 1, 2 and 4
are built** (see "Control mode" in `src/mobile/README.md`), with the canvas
paused rather than unmounted, and step 3's instruments gated. Still open: the
snapshot-subscription leak, `App` re-rendering on `node-updated` while paused,
unwatching mini stats while hidden, the `mobileEvents` storage write, the CSS
animations, and step 5.

## What the phone does today while you talk to Control

The transcript is an overlay. The whole desktop canvas (`App`) stays mounted
underneath it (`MobileApp.tsx:143`), and the page keeps running with the
screen locked, because the iPhone app keeps itself awake while it holds Control.

### Measured: what the server sends a phone

A passive client connected to the gateway for 60 seconds, once with no
subscriptions and once with every terminal in snapshot mode. Snapshot mode is
what the phone's canvas asks for, one card per terminal. This Mac had
25 terminals.

| Message | Per second | Per minute |
|---|---|---|
| `snapshot` (a terminal's full screen, as styled spans) | 9.2 | **6.0 MB** raw, about 1.2 MB compressed |
| `node-updated` | 0.6 | 6 KB |
| `receptionist-*` (everything the transcript uses) | 0.9 | 8 KB |
| everything else | rare | negligible |

**Snapshots are 99.8% of everything the phone receives**, and the transcript
uses none of them. They arrive at up to ten a second, which is the server's
snapshot tick (`snapshot-manager.ts:9`). Busy agents keep their terminals
dirty, so the tick almost always has something to send. With the screen off
they are still received, decompressed and parsed (`JSON.parse` of about
100 KB a second), then put aside unpainted (`TerminalCard.tsx:959-969`).

That works out to about 70 MB an hour over the radio, about 360 MB an hour of
JSON parsed, and a radio that never gets to idle.

There is a second-order cost too. A phone that falls behind piles snapshots
into the gateway's send buffer. Past 16 MB the server drops the socket
(`web-gateway.ts:27`). The phone reconnects, reloads the page and fetches
`sync-state` again, about 1.4 MB, a megabyte of which is `archivedChildren`.

### Found in the code: what the page does with nobody looking

Ranked by how much each costs, as best as reading the code can tell:

1. **Snapshots**, above. The server only stops sending a terminal's snapshots
   when that terminal goes live. Unmounting a card does not tell it
   (`TerminalCard.tsx:953-975` cleans up the listener, not the subscription).
   So nothing on the phone can currently turn them off, short of a reload.
2. **Two debugging instruments, four times a second each, forever.**
   - `memory-probe.ts:31` walks the DOM and calls `getBoundingClientRect` on
     every card, which forces a layout.
   - `diagnostics.ts:116` runs two `querySelectorAll` calls.
   - Both write to `localStorage` on every tick.
   - `diagnostics.ts:105` also keeps a `requestAnimationFrame` loop alive
     whenever the page is visible.

   These were added to catch the zoom-out memory kills, and nothing gates
   them.
3. **The whole `App` re-renders every second**, from `useCoarseClock`
   (`App.tsx:175`), screen on or off. Every `node-updated` does the same: it
   rebuilds the derived node arrays and lays out every label and edge again.
   That's 3,000 lines of component and 25 cards, for a clock nobody can see.
4. **The canvas thinks it is visible under the transcript.**
   `setCanvasCovered` already pauses the WebGL background, snapshot painting
   and camera animation (`browser-platform.ts:54`, `frame-policy.ts:146`). But
   only an open terminal sets it (`MobileApp.tsx:116`), not the transcript. So
   with the screen on, the background shader and card repaints run behind an
   opaque panel. An animated theme never lets the shader rest.
5. **`camera-follow`** flies the hidden canvas's camera to whichever agent
   Control is talking about (`App.tsx:1486`), at 60 fps, under the transcript.
6. **`mobileEvents.record()` rewrites its whole queue** (up to 3,000 events)
   to `localStorage` on every event (`mobile-events.ts:91,142`). Hands-free
   records a lot of events.
7. **Infinite CSS animations outside the canvas** (the rocket's unread ring,
   the mic's pulses, `mobile.css:986`, `:283`, `:362`). The canvas-only
   `animation: none` rule doesn't cover them.

### What Control actually needs

- The transcript needs only `receptionist-*` messages
  (`ControlTranscript.tsx:115-165`), and node state only to fly to an agent
  when you tap its name (`:439`).
- The two buttons need the dictation, wake-word, speech and hands-free
  messages.
- **Agent spend** (`UsageReadout.tsx`) is one query, then a `usage-report`
  push only when the reading changes. That's roughly every five minutes and
  costs nothing. Keep it as it is.
- **Mini stats** (`SystemStatsReadout.tsx`) is an opt-in watch. The server
  reads `~/.mini-stats/menubar.json` every 2 s and pushes only changes, which
  are small. Keep it while the screen is on. Stop watching while the page is
  hidden, and watch again on return; the server already re-sends a reading
  when a watch starts.

### What stays and costs real energy

- **The audio engine.** The iPhone app has to run it to stay awake at all, and
  the README already counts it as the price of hearing Control locked.
- **Hands-free, when it is on.**
  - The app hands the page base64 PCM every 100 ms over `evaluateJavaScript`.
  - The page decodes it and runs Silero VAD in WebAssembly, about 31 times a
    second (`speech-detector.ts`), allocating new tensors each frame.

  This is the floor once everything above is gone, and the only part that a
  native app would do fundamentally cheaper.

## Proposal: a Control mode in the existing app

**Control mode** is on when the transcript is open, or when the page is
hidden while this phone holds Control. It is off whenever the canvas is
actually on screen.

### 1. Server: a paused client gets no snapshots (drop, don't queue)

Add one per-client flag, `canvas-paused`, on the pattern of
`system-stats-watch` (`index.ts:256`, `:1672`).

- **While paused**, the snapshot fan-out (`index.ts:3016-3022`) skips that
  client.
- **On un-pause**, the server sends `snapshotNow` for each of its snapshot
  subscriptions. That path already exists, for `set-terminal-mode`
  (`index.ts:2537`).

Snapshots are latest-wins, so there is nothing worth queuing: the freshest
one on return is the whole queue.

Also fix the leak in item 1 above. A card that unmounts should end its
snapshot subscription, and a new `set-terminal-mode: 'none'` (or a `detach`)
would do it. Without that, subscriptions only ever accumulate. Leaving it
alone is what made the pause flag necessary in the first place, and it is the
same class of bug.

`node-updated` and the rest stay as they are. At 6 KB a minute their bytes
don't matter. What matters is what the page does with them, which is
step 2's job.

### 2. Phone: pause the canvas, keep the stores

While in Control mode:

- `setCanvasCovered(true)`. The WebGL loop, card painting and camera flights
  stop, using the existing switch.
- Send `canvas-paused`.
- Stop `useCoarseClock` (no visible elapsed labels).
- Take `camera-follow` into a "latest wanted" ref instead of flying. Apply it
  once on return.
- Keep applying `node-*` messages to the node store, which is cheap. That
  makes the store the queue: nothing replays on return, the canvas renders
  what the store already holds.
- But **stop `App` re-rendering from them.** The simplest way is to unmount
  the canvas while in Control mode and remount it on return. The node store
  and camera store outlive it.

  If remounting turns out to be slow or loses state (the camera restore and
  the start-up fly-out are mount effects), the fallback is memoising `App`'s
  body behind a `paused` flag. Try unmounting first and measure.

### 3. Phone: gate the instruments and the chatter

- **`memory-probe.ts` and `diagnostics.ts`**: run only while the canvas is on
  screen, which is the only time they detect anything. Better still, only
  while zoomed out, which is the case they were written for.
- **`mobileEvents`**: debounce the `localStorage` write to once a second.
  Writing on every event buys nothing over that.
- **Mini stats**: unwatch while hidden.
- **CSS**: pause the infinite animations while hidden (`body[data-hidden]`).

### 4. Prove it

`energy.sh` can't record a locked phone, so the page should report its own
work. While hidden, emit a `page-work` event every 60 s:

- messages and bytes received, by type;
- how long the page was busy, from timer lateness.

That shows directly whether Control mode is holding.

Separately, run `energy.sh` with the screen on and the transcript open, before
and after. That case it can measure.

### 5. Later, and only if `page-work` says hands-free dominates

Move the audio front-end into `NativeMicrophone.swift`:

- the ring buffer and the VAD (Silero runs on Core ML), so silence never
  crosses into the page;
- the page gets woken only for a wake-word candidate or a dictation.

The hands-free *logic* (the wake listener's rules, the conversation window,
Smart Turn checks) stays in `hands-free.ts`. What moves is only the per-frame
arithmetic.

## The alternative: a separate native app, "Spaceterm Control"

A Swift app with no web view and no canvas: the transcript, the microphone
button and the hands-free lock. Control is always held, so the Control button
goes.

**What it would win:**
- No WebKit content process: its baseline memory and wake-ups, gone.
- Audio stays native end to end: no base64 bridge, and VAD on Core ML.
- It can't regress because someone made the canvas heavier.

**What it would cost:**
- **A second client for everything Control touches:**
  - the protocol handshake and reconnect;
  - the transcript: paging, Concise / Detailed, agent colours and names,
    catch-up, replay, read marks;
  - dictation and its 200 ms batching, cues, haptics;
  - and the hands-free state machine (`hands-free.ts`, `wake-listener.ts`, the
    conversation window, turn checks).

  Hands-free is the most actively changed code in the repo; the last five
  commits all touch it. Every change would be made twice, or the two would
  drift.
- **A fork of shared code.** `ControlTranscript.tsx` is shared with the Mac
  today, and would stop being.
- **Two apps holding one Control.** They'd need different device ids, both
  would want the microphone, and swapping between them is a hand-off rather
  than closing a panel. Tapping an agent's name to see its terminal would
  leave the app.
- **Two installs to sign and keep alive.** On a free Apple ID that's twice the
  seven-day re-signing.

**What it would not win.** Once steps 1–3 are in, an idle page in Control mode
receives under 0.1 KB a second and runs almost nothing. The one remaining
real difference is the hands-free audio path, and step 5 takes that into
native code inside the existing app.

## Recommendation

1. **Make the existing app efficient, in this order:** the server-side
   snapshot pause plus the subscription leak (the bulk of the waste), then
   covering and unmounting the canvas, then gating the debug instruments.
   Agent spend stays exactly as it is, and mini stats while the screen is on.
2. **Measure with `page-work`.**
3. **Do step 5 only if hands-free still dominates.**
4. **Don't build Spaceterm Control now.** Revisit it only if, after all that,
   the web view's own baseline is shown to matter, which nothing here
   suggests.

If the appeal of Spaceterm Control is partly the *layout* — the transcript as
home, no canvas — that's cheap to have in the existing app: an option that
opens into Control mode and mounts the canvas only when asked.
