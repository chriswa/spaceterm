# Potential optimizations

Findings from a profiling session on 2026-09-22 that were **not** acted on, with
the evidence behind each so the next person does not have to re-derive it.

Everything here was measured on a 120 Hz display with ~74 cards mounted, 22
canvases, 2761 DOM nodes, and 253 terminal nodes in `state.json`.

## How to measure

The app runs with the Chrome DevTools Protocol on `127.0.0.1:9222` (see
`CLAUDE.md` — an agent needs the operator's approval for each use). A trace:

```
Tracing.start { includedCategories: [
  "disabled-by-default-devtools.timeline", "devtools.timeline",
  "cc", "gpu", "viz", "toplevel", "blink" ] }
```

Then compute **self time** per event name, per thread — nested `X` events
double-count, so a naive sum reports >100% and means nothing. The threads that
matter are `CrRendererMain` and `CrGpuMain`.

**The measurement trap:** an agent running in a Spaceterm terminal *is* load.
Every command streams output into xterm, which rasters. Two traces taken 40
minutes apart under different agent activity are not comparable, and one such
comparison in this session produced a confident, wrong conclusion that the GPU
had regressed. Prefer a back-to-back A/B seconds apart, toggling one thing.

Process-level CPU deltas (all threads, not just main):

```bash
G=$(pgrep -f "Electron Helper \(GPU\)"|head -1); R=$(pgrep -f "Electron Helper \(Renderer\)"|head -1)
a=$(ps -o time= -p $G,$R); sleep 60; ps -o time= -p $G,$R; echo "$a"
```

## Baseline after this session's work

Focused, idle, my own load present (so read these as a ceiling, not a floor):

| | renderer | gpu |
|---|---|---|
| main-thread self time | 19.7% | 35.4% |
| layout / paint per 5s | 16 / 19 | |
| frames presented | 120/s | |

Unfocused but **visible** (not occluded): gpu halves to ~18%, renderer does not
move, frames stay at 120/s.

---

## 1. `recalcStyle` runs every frame — unexplained

**The biggest open question, and now the dominant renderer cost.**

`Document::recalcStyle` fires ~118 times a second — every frame — while layout
and paint sit near zero. It does this whether the window is focused or
backgrounded. Something invalidates style continuously without triggering
layout.

Suspects, none confirmed:

- The CSS animations ticking on the main thread. Blink still ticks a composited
  animation's timing; with two glowing shells plus the toolbar's dance loop
  that could account for it.
- `CrabGroup`'s loop writing `style.filter` / `translate` / `rotate` at
  `DANCE_HZ`, though that is rated and should not be per-frame.
- Something in the xterm layer.

Worth a clean-room trace with no agent running before spending time on it.

## 2. Does cost grow with uptime?

Focused-idle renderer+GPU measured **71% of a core** on a freshly restarted app
and **136%** on one that had been up ~1.5 days. Not a controlled comparison —
different cards were mounted — but if it reproduces it is worth more than
everything else in this document combined, because it is a leak rather than a
steady-state cost.

To test: restart, record the baseline above, leave it running a couple of days,
re-record under the same conditions.

## 3. Nothing enforces the frame-policy contract

`frame-policy.ts` reads as though limiter gating is universal. It is not, and
was not for a long time: `crab-dance.ts` held three ungated `requestAnimationFrame`
loops *per card*, each writing inline styles every frame, driving ~294 style
writes and ~114 full layout/paint cycles a second for an animation the source
itself documents as ~0.5 Hz.

The instance is fixed. The class is not. Options:

- A lint rule banning bare `requestAnimationFrame` in `src/client/renderer`.
- A `useAnimationFrame(cb, limiter)` wrapper that cannot be constructed without
  a rate, so the decision is forced at the call site.

Note that a limiter is not always the right answer — see item 6.

## 4. The dance keyframes are a copy

`terminal-card-crab-dance` in `index.css` was generated from the arithmetic in
`CrabDance.tick()`, sampled every 2.5%. Nothing enforces that the two agree, and
a change to one will silently desynchronise the toolbar crabs from the card
crabs. Both files carry a comment saying so.

A test could sample the class at the keyframe offsets and assert the CSS values
match within a tolerance.

## 5. A visible-but-unfocused window never reaches 0 Hz

By design — `frame-policy.ts` argues a window on a second display should keep
drawing, and that is right. But it means `REDUCED_HZ` is the floor in practice,
and the 0 Hz hidden path only engages on true occlusion, which is reported via
`document.visibilityState`.

**Never verified that occlusion actually fires for this window on macOS.**
During testing the app reported `visibilityState: "visible", hasFocus: false`
with another app in front of it. If occlusion never fires, the 0 Hz path is
dead code and a fully-covered window keeps compositing at 120 Hz.

Worth testing explicitly: cover the window completely, or send it to another
Space, and check whether `visibilityState` flips to `hidden`.

## 6. Do NOT "optimize" `useEdgeHover`

It looks like an ungated per-frame loop and it is not worth gating. It already
carries an input-equality guard on mouse and camera, so a still cursor costs a
few ref reads and an early return — measured at 2.2ms per 5s, the same as the
rated `useFps`. Gating it would make edge hover laggier while unfocused in
exchange for nothing measurable. The guard is the better pattern here: instant
response when input changes, ~free when it does not.

Recorded so the next reader does not "fix" it.

## 7. GPU raster cost is unattributed

`CrGpuMain` self time is dominated by:

```
IOSurfaceImageBacking::WaitForANGLECommandsToBeScheduled   ~800ms / 5s
RasterDecoderImpl::DoEndRasterCHROMIUM::Flush              ~390ms / 5s
SkiaOutputSurfaceImplOnGpu::FinishPaintRenderPass          ~200ms / 5s
```

Some of this is inherent — 22 live canvases, an opaque card per node, a
compositor running at 120 Hz. How much is *avoidable* was never established,
and it is confounded by agent output driving xterm raster. Related open
question: what keeps the compositor producing 120 frames a second when nothing
is animating? Disabling every CSS animation only saved ~5%.

---

## Gotcha worth remembering

`.terminal-card` carries `content-visibility: auto`, which implies
`contain: paint` — **paint containment clips descendants to the padding box**.
A pseudo-element glow on the card computes every property correctly and is
entirely invisible, because its shadow spill is clipped away. An element's own
`box-shadow` is *not* clipped by its own containment, which is why the previous
JS implementation worked without anyone knowing this was load-bearing.

Chrome that must escape a card belongs on `.card-shell` (same box, no
containment) or in `behindContent`.
