# Idea: browser cards

**Status: shelved after a design session (2026-08-03). No code was written.**
This is a handoff note, not a plan. It records the design we landed on, and —
more importantly — the alternatives we rejected and *why*, because most of them
look attractive until you check one specific fact.

Do your own research. But read the "Surprises" section first; several of those
facts cost an hour each and are not what you would guess.

---

## The idea

Browser cards on the canvas, alongside terminals. Our own chrome (address bar,
back/forward). Potentially hostile websites, so isolation matters. Must feel
like a real browser when focused — smooth scrolling, video, 60fps, no input lag.

The requirement that killed most designs: **a browser card's live state must
survive a client restart.** Not just the URL — the page, its JS heap, its scroll
position, its logged-in SPA. The client restarts constantly during development
(`electron-vite dev`, `app:restart-spaceterm`), and losing every page each time
makes the feature useless.

## Why the terminal architecture does not port

The obvious move is to copy what terminals do: server owns the session, client
attaches only when focused, everything else is a snapshot. See
`src/server/snapshot-manager.ts` and `TerminalCard.tsx`.

That works because a terminal decomposes into **a byte stream + a cheap
deterministic emulator**. The server keeps a headless xterm per session and
serializes it to attr-spans; the client can paint that or replay it into a live
xterm.

**A web page has no equivalent seam.** Its state *is* its renderer process —
DOM, JS heap, compositor layers, GPU textures, media pipelines. There is no
compact serialization you can replay into a fresh engine. So "run it on the
server, snapshot it to the client" only has two possible meanings, and both are
covered under rejected alternatives below.

Corollary: the daemon is not a candidate host. Its job is to own OS processes
that outlive clients and speak JSON-lines. A browser is not a byte stream, and
putting one there means shipping and supervising a second browser engine for a
durability benefit that the design below gets for free.

---

## The design we landed on

**A native macOS shell replaces Electron. It owns the window and hosts both the
spaceterm UI and the browser cards as sibling `NSView`s in one process.**

- The spaceterm renderer (React, xterm, CodeMirror — all of
  `src/client/renderer/`) runs in a full-window `WKWebView`, with a transparent
  background.
- Each browser card is a `WKWebView` sibling, placed *behind* the UI webview in
  subview order. Our DOM chrome, modals, toolbar, and overlays therefore render
  *above* live pages naturally.
- Clicks over a focused card's rect are routed to it by overriding
  `hitTest(_:)` on the container.
- The server (tsx) and the Go daemon are untouched.

### Why this is the answer

**The durability boundary moves from a process boundary to a view boundary.**
The shell is the long-lived thing; "the client" is a webview inside it.
Restarting the client is *reloading a page* — browser cards are siblings and do
not notice. No cross-process pixel transport, no IPC'd window positions, no
snapshot machinery, because the boundary that needed crossing doesn't exist.

It also collapses a pile of problems that every other design has to solve:

- Zero added latency — no capture, no encode, no copy. WindowServer composites
  the same surface it would for Safari.
- No position skew during pan/zoom — same process, same `CATransaction`.
- Real responder chain: native input, IME and marked text, trackpad momentum,
  drag-and-drop, accessibility. All free.
- One app, one window — no cross-app key focus, no activation flicker, no
  Mission Control or window-ordering hacks.
- No private API.
- **Security gets better, not worse.** `WKWebView` is the system engine, patched
  by Apple on Safari's cadence, and WebKit already runs each webview's content
  in its own sandboxed process. Per-card cookie jars via
  `WKWebsiteDataStore(forIdentifier:)`. Compare Electron 33 = Chromium 130,
  which is ~21 months stale and would be pointed at hostile sites.

### What it costs

- **The client becomes macOS-only.** The renderer stays portable, so it is not a
  dead end, but Electron's one-shell-everywhere property is gone. This is the
  only irreversible decision in the whole design; make it consciously.
- Rewrite `src/client/main/` (856 lines) and `src/client/preload/` (233 lines)
  in Swift. That is the real scope. The renderer, `src/shared/`, the server, and
  the daemon are untouched.
- The e2e layer is rebuilt — `playwright-core` drives Electron. Renderer-level
  tests are unaffected, which is the right way round.
- No CDP for agent-driving browser cards; WebKit offers Web Inspector protocol
  and WebDriver instead. If CDP turns out to matter more than patch cadence,
  CEF-in-the-native-shell is the fallback and the shell design is unchanged.
- `contentTracing` (used for perf traces) and other Electron-only APIs go away.
- A shell crash takes the cards with it. Mitigated by WebKit's content-process
  isolation plus session restore.

### The hedge

Ship both shells side by side for a while. Both load the same renderer bundle
against the same `Api` interface; browser cards light up only on the native one.
`FakeBridge` already proves the interface supports more than one implementation.
You do not have to bet the app on a single cutover.

### Staging (Stage 1 is the only real risk, and it comes first)

0. Audit for Electron leakage past the `Api` interface. Useful regardless.
1. **Go/no-go, and it involves no browser code at all.** A Swift shell that
   loads the *existing* renderer bundle in a `WKWebView` and implements enough
   of `Api` to boot (server socket, log, `pty.attach/write`). Does spaceterm run
   on WebKit? Do terminals feel right — WebGL renderer, font metrics, keys, IME?
   If this feels bad, stop. Nothing later fixes it.
2. Browser cards as native subviews: punchout, `hitTest` routing, chrome in DOM,
   per-card data stores.
3. Prove the payoff: reload the UI webview mid-session, watch cards survive.
4. Decide whether the Electron shell stays.

---

## Rejected alternatives, and why

These are in the order a fresh agent is likely to propose them.

### Run browsers on the server/daemon and stream pixels

Two variants, both rejected.

- **CDP `Page.startScreencast`** — base64 JPEG frames over a socket. ~10–25fps,
  visible latency, no smooth scroll, no video, no WebGL. Not close to good
  enough.
- **A proper video bus** — hardware encode → socket → hardware decode →
  `VideoFrame` → WebGL quad. This genuinely works, needs zero native code (both
  ends are Chromium; `VideoFrame` is a `CanvasImageSource` so `texImage2D` takes
  it directly), and elegantly turns the snapshot tiering into a per-card bitrate
  knob. **Rejected on latency:** realistic budget is 30–45ms glass-to-glass added
  over native. Fine for scrolling and video, perceptible when typing. The user
  ruled this unacceptable, and that ruling is the reason the design went native.

If you are tempted to revisit this, the cheap experiment is WebRTC over loopback
(~10 lines each side, `receiver.playoutDelayHint = 0`) — but the decision was a
product call about feel, not an open technical question.

### Shared GPU textures (IOSurface / DMA-BUF / D3D11 shared handles)

The theoretically correct zero-copy answer, and it is a dead end **for an
Electron renderer specifically**, for two independent reasons:

1. **JS cannot import an external texture.** WebGL has no such API, and
   `GPUExternalTexture` only accepts `HTMLVideoElement`. A shared texture can
   never reach the renderer's WebGL context, no matter what the main process
   does with it.
2. **It is Windows-first anyway.** Electron's `offscreen.useSharedTexture`
   (PR #42953) ships D3D11 with a Windows-specific Chromium patch; macOS is
   undocumented and untested (electron#45428). CEF's `OnAcceleratedPaint` is
   D3D11-only upstream, with macOS IOSurface living in patches and OBS's fork.

Only viable if the client is native — at which point the design above gets you
the same result with no texture plumbing at all.

### Shared memory + dirty rects, no codec

Lower latency than a video bus in principle. Blocked by our own (correct)
security posture: the renderer runs `contextIsolation: true` /
`nodeIntegration: false`, so it cannot `mmap` anything; the only path is
preload → `contextBridge`, which copies. `renderer-purity.test.ts` exists
specifically to keep Node out of the renderer's import graph.

### `<iframe>`

**Dead on arrival for a general browser.** X-Frame-Options and
`frame-ancestors` block Google, GitHub, and most of the real web. Electron
removed the header-stripping escape hatch. Fine for known-embeddable content
only.

### Electron `<webview>` tag

Officially discouraged ("undergoes dramatic architectural changes"). Its one big
advantage is real: it is an OOPIF, so it participates in DOM layout and would sit
*inside* the camera's CSS transform, which no other Electron option does. The old
CSS-scale double-scaling bugs (electron#3749, #4562) predate the OOPIF rewrite
and may no longer apply — nobody tested. Reasonable fallback if you end up
staying on Electron; not the direction we chose.

### Electron `WebContentsView` overlay

Stable and supported, strongest isolation of the Electron options, and it was the
leading candidate for a while. Problems: it **always paints above the entire
renderer DOM** (so every modal, toolbar, and overlay is buried), it cannot be CSS
transformed (you drive bounds in window pixels and `setZoomFactor`, which
reflows), and it does not survive a client restart — which is the requirement
that started all this.

### Daemon-owned host app with overlay `NSWindow`s

This was the second-to-last design and it is *good*: a faceless (`LSUIElement`)
host app owns the webviews, positions a borderless window over the focused
card's rect, and survives client restarts. Zero-copy output, native input.

Superseded rather than refuted. The native-shell inversion gets the same result
without: cross-process window ordering, position IPC and its 1–2 frames of
"swimming" during pan/zoom, activation flicker as key focus leaves the client
app, Mission Control and screenshot suppression, and a snapshot-swap during
camera motion to hide the skew. If you ever need a *separate* process for
crash isolation, this is the design to come back to.

### `CALayerHost` / `CAContext` remote layer hosting

Real, and it is how Chromium composites on macOS; JxBrowser ships it to embed
out-of-process Chromium in a Java app. Would give perfect cross-process output
that inherits the host's transforms and clipping.

**Rejected because it is pixels-only.** No hit testing, no responder chain — you
forward every event yourself, including key repeat, modifier state, IME and
marked text, and scroll momentum. Hand-rolled IME is where this goes to die.
Also private API, which blocks App Store distribution.

### "Keep Electron, host its UI inside the native shell"

**This does not exist and it is the most seductive wrong idea here.** `NSView`
reparenting is same-process; Electron cannot be embedded in another process's
view hierarchy. The only cross-process option is exporting Electron's layer via
`CAContext` and hosting it with `CALayerHost` — which puts your *primary UI*
behind the pixels-only wall described above. You would be hand-forwarding every
keystroke and IME composition to CodeMirror and xterm. Strictly worse than what
we have.

The phrase "Electron as guest" is shorthand for *replacing* Electron with a
native shell + `WKWebView`. Be precise about this with the user.

---

## Surprises

Facts that cost research and are not what you would guess.

- **`NSWindow.addChildWindow` is same-process, but `orderWindow(_:relativeTo:)`
  is not.** It takes a *window number*, which is a system-global `CGWindowID`.
  So cross-process relative window ordering is possible with public API. This
  matters for any overlay design.
- **macOS hit testing uses subview order; `zPosition` affects visual
  compositing only.** Hence the "punchout" arrangement: transparent UI webview
  in front, native views behind, `hitTest` overridden to route.
- **You only get two compositing layers** (native behind, DOM in front). A
  browser card cannot sit *between* two DOM cards in z-order. Express this in
  `CARD_TYPE_SPECS.zIndexTier` — which already has a tier system
  (`TIER = { base, directory, title }`) — by giving browser cards a tier below
  `base`, so the constraint is a compile-time fact rather than a bug someone
  finds later.
- **Focusing a card fits it axis-aligned to the viewport** with 10% padding and
  then stops (`cameraToFitBounds` in `lib/camera.ts`). Focused zoom lands near
  0.8, not 1. Any overlay-style design is fine *in the focused, settled state* —
  which is the only state that has to be interactive — and only needs a fallback
  during camera motion.
- **`renderer-purity.test.ts` is the thing that makes an engine swap possible.**
  It was written to keep jsdom tests viable; what it actually bought is a
  renderer that runs on any engine. Do not weaken it.
- **`Api` + `FakeBridge` is the shell seam.** The bridge is an explicit
  interface with a fake that must compile against it, so replacing Electron's
  preload with `WKScriptMessageHandler` + injected JS is *implementing an
  existing interface*, and the renderer test suite comes along unchanged.
- **`src/client/main/index.ts` has ~60 `ipcMain` handlers and not one validates
  the sender** (every one is `(_event, ...)`). Harmless today — one webContents,
  and it is ours. Any design that introduces a second webContents retires that
  invariant. Do not port this pattern into a new bridge; design the sender check
  in from the start.
- **Adding a card type is compile-error-driven.** Add `'browser'` to `CardType`
  and the union in `state.ts`, and `CARD_TYPE_SPECS`, `measureCard`'s
  `assertNever`, and the two `Assignable` guards in `state.ts` will each fail
  until handled. Follow the errors.
- **Font metrics will differ on WebKit.** `src/client/renderer/src/lib/cell-metrics.ts`
  is where that re-tuning would land.

## Two features worth designing for whichever way this goes

- **`window.open` → a child browser node.** Deny the popup, create a sibling card
  placed by the existing placement logic. "Open in new tab" becoming a spatial
  tree is the thing that would make this *spaceterm's* browser rather than a
  browser inside spaceterm.
- **Session restore, built properly regardless.** URL, history, scroll, form
  values, cookies in a persisted store. Hosts crash and machines reboot, so you
  want it even in the perfect-world architecture — and it is the honest cheap
  answer if the whole idea gets descoped. Chrome throws away every renderer on
  restart and nobody minds, because restore is good.

## Open questions

- Multi-client: the server supports several connected clients
  (`clients` set, `src/server/index.ts`). Browser cards would be visible to one
  of them. Local-only in every design considered. Decide consciously.
- Do browser cards need to be agent-drivable? If yes, weigh CDP (Chromium/CEF)
  against patch cadence (WebKit) before Stage 1.
- Whether the Electron shell stays permanently as the cross-platform option.
