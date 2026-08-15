/**
 * How often anything in this app is allowed to draw.
 *
 * ## Why a rate and not a boolean
 *
 * Every render loop in the renderer used to answer one question — "is the
 * window visible?" — and then run flat out if it was. On a 120 Hz panel that
 * meant a full-screen shader pass, a wave simulation, a mask quad per card and
 * a per-frame DOM write, all 120 times a second, for a screen on which nothing
 * had changed. The boolean has no way to express the two things that were
 * actually wanted:
 *
 * - **A ceiling.** None of the decoration reads any differently at 60 than at
 *   120, so half the frames on a ProMotion display were bought and thrown away.
 * - **A reduced rate.** A window on a second monitor is not focused and is not
 *   hidden either. Pausing it is wrong — the point of having it over there is to
 *   see things change — but so is running it at full rate to show nothing.
 *
 * So visibility stays a boolean (a hidden window draws nothing, and that is
 * decided by `useWindowVisible`, which owns the two signals it takes to know),
 * and everything above zero becomes a target frequency.
 *
 * ## Focus is not the signal; change is
 *
 * Throttling on focus alone gets the second-monitor case backwards: the moment
 * something over there *does* change is exactly the moment focus says to draw
 * less. `pokeFrames()` is the fix — anything that constitutes a real change
 * calls it, and the policy runs at full rate for `ACTIVITY_TAIL_MS` afterwards
 * regardless of focus. An unfocused window therefore idles cheaply and animates
 * properly whenever there is something to animate, which is the behaviour
 * someone watching a second display actually wants.
 *
 * That makes `poke` load-bearing rather than an optimisation: a change that
 * forgets to poke is a change that takes up to `1 / REDUCED_HZ` seconds to
 * appear on an unfocused window. That is a tenth of a second, not a stall, and
 * `REDUCED_HZ` is set where it is so the failure mode of a missed poke stays
 * merely imperceptible instead of becoming a bug.
 *
 * ## What a loop does with this
 *
 * Keep the rAF loop; gate the *work*. `FrameLimiter` is per-loop state, so each
 * loop can also declare an intrinsic rate — the crab dance and the chevron
 * crawl do not need 60 either — and gets `min(intrinsic, policy)` without
 * having to know what the policy currently is.
 */

/** Target while unfocused and nothing has changed recently. */
export const REDUCED_HZ = 10

/**
 * The most any loop may draw, however fast the display offers frames.
 *
 * 60 because every animation in this app was authored against it and none of
 * them is a motion study; the second 60 frames a ProMotion panel offers cost
 * exactly as much as the first and are indistinguishable.
 */
export const DEFAULT_CEILING_HZ = 60

/** How long a `pokeFrames()` keeps the policy at full rate. */
export const ACTIVITY_TAIL_MS = 1_000

/**
 * What an unfocused-but-visible window does.
 *
 * `reduced` is the default and is deliberately not `paused`: a window that is
 * on screen and drawing nothing is a window showing stale pixels, and no signal
 * available to a renderer distinguishes "unfocused because it is behind
 * something" from "unfocused because it is on the other monitor being watched".
 * `full` is for someone who would rather spend the GPU than think about it.
 */
export type UnfocusedFrames = 'full' | 'reduced'

let visible = true
let focused = true
let unfocusedMode: UnfocusedFrames = 'reduced'
let ceilingHz = DEFAULT_CEILING_HZ
/** `performance.now()` up to which a recent change keeps us at full rate. */
let activeUntil = 0

/**
 * Window visibility, pushed in by `useWindowVisible` rather than read from it.
 *
 * One owner for the two signals it takes to know (main-process IPC and
 * `document.visibilityState`), and no import cycle: that module already has to
 * notify its own subscribers, so it notifies this too.
 */
export function setWindowVisible(next: boolean): void {
  visible = next
}

/** Whether the window has keyboard focus. Fed by `window:focus-changed`. */
export function setWindowFocused(next: boolean): void {
  focused = next
}

export function setUnfocusedFrames(mode: UnfocusedFrames): void {
  unfocusedMode = mode
}

export function unfocusedFrames(): UnfocusedFrames {
  return unfocusedMode
}

/** Clamped to something sane: a zero or negative ceiling would stop the app. */
export function setFrameCeilingHz(hz: number): void {
  ceilingHz = Math.max(1, Math.min(240, Math.round(hz)))
}

export function frameCeilingHz(): number {
  return ceilingHz
}

/**
 * Something changed that a viewer would want to see now.
 *
 * Call it from whatever *causes* a visible change — an arriving snapshot, a
 * moved node, an alert, a keypress — not from the loop that draws the result.
 * Cheap enough to call per event; it writes one number.
 */
export function pokeFrames(now: number = performance.now()): void {
  activeUntil = now + ACTIVITY_TAIL_MS
}

/**
 * Frames per second anything may draw at right now. Zero means draw nothing.
 *
 * The ceiling applies to the focused case too: it is a ceiling on the app, not
 * a penalty for being in the background.
 */
export function targetFrameHz(now: number = performance.now()): number {
  if (!visible) return 0
  if (focused) return ceilingHz
  if (unfocusedMode === 'full') return ceilingHz
  if (now < activeUntil) return ceilingHz
  return Math.min(REDUCED_HZ, ceilingHz)
}

/**
 * Tolerance on the interval, as a fraction of it.
 *
 * Without it a 60 Hz target on a 120 Hz display halves again to 40: frames
 * arrive every 8.33 ms, so the second one lands at 16.67 ms and any jitter at
 * all puts it under a 16.67 ms threshold, pushing the decision out another
 * whole frame. Ten percent absorbs the jitter without ever letting a loop run
 * more than a hair above its target.
 */
const INTERVAL_TOLERANCE = 0.9

/**
 * Per-loop rate limiter.
 *
 * One instance per loop rather than a module-level map keyed by name: a typo in
 * a string id silently gives a loop its own budget, and two loops sharing an id
 * silently starve each other. An object cannot be misspelled.
 *
 * `shouldRun` records the frame it approves, exactly like
 * `CanvasFrameGate.shouldDraw` — so the caller must do the work when it returns
 * true and must not when it returns false.
 */
export class FrameLimiter {
  private lastRunAt: number | null = null

  /**
   * `intrinsicHz` is the rate this loop's *content* needs, independent of the
   * policy — a chevron crawl at 30, a slow noise drift at 10. Omitted means
   * "whatever the policy allows".
   */
  constructor(private readonly intrinsicHz?: number) {}

  shouldRun(now: number = performance.now()): boolean {
    const hz = Math.min(this.intrinsicHz ?? Infinity, targetFrameHz(now))
    if (!(hz > 0)) return false
    const last = this.lastRunAt
    if (last === null) {
      this.lastRunAt = now
      return true
    }
    // A clock that went backwards (a test, or a loop resumed against a
    // different time base) would otherwise wedge the limiter until it caught
    // up, so treat it as due.
    if (now < last || now - last >= (1000 / hz) * INTERVAL_TOLERANCE) {
      this.lastRunAt = now
      return true
    }
    return false
  }

  /**
   * Forget the last run, so the next `shouldRun` is due immediately.
   *
   * For resuming after a pause: the interval since the last drawn frame is
   * however long the window was hidden, which is not information about when the
   * next one is wanted.
   */
  reset(): void {
    this.lastRunAt = null
  }
}

/**
 * `now`, stepped down to a clock that ticks `hz` times a second.
 *
 * This is what lets a facet's declared animation rate cost nothing to honour.
 * Feeding a quantised timestamp to a shader means the value handed to it is
 * *identical* across the frames in between — so `CanvasFrameGate`, which
 * already skips a frame whose inputs all match the last one, skips them with no
 * new mechanism and no second opinion about what "animated" means.
 *
 * - `hz === 0` → `null`: the facet promised its output does not depend on time
 *   at all, and `null` says that at the call site rather than leaving a
 *   live-but-unread number for someone to wire back in.
 * - `hz === undefined` → `now`: undeclared means fully animated, which is the
 *   safe default for a facet from a mod that has not thought about it.
 */
export function quantizeClock(now: number, hz: number | undefined): number | null {
  if (hz === undefined) return now
  if (!(hz > 0)) return null
  const step = 1000 / hz
  return Math.floor(now / step) * step
}

/** Restore module defaults. Tests only — this state is process-wide. */
export function resetFramePolicyForTest(): void {
  visible = true
  focused = true
  unfocusedMode = 'reduced'
  ceilingHz = DEFAULT_CEILING_HZ
  activeUntil = 0
}

// Focus arrives from the main process, subscribed once on load in the same
// style as `useWindowVisible` — a wiring step that has to be remembered is a
// wiring step that gets forgotten, and the failure would be silent (a window
// that never leaves full rate).
if (typeof window !== 'undefined') {
  window.api?.window?.onFocusChanged?.((next) => setWindowFocused(next))

  // Direct interaction is a change by definition, and it is the one case where
  // a tenth of a second of latency would be felt rather than merely missed — an
  // unfocused window still gets hover and scroll, and both have to feel
  // immediate. Attached here, not in a component: the overlays that already
  // listen for input are conditionally mounted, so any of them would be a place
  // this could silently stop happening.
  const poke = () => pokeFrames()
  for (const type of ['pointerdown', 'pointermove', 'keydown', 'wheel'] as const) {
    window.addEventListener(type, poke, { capture: true, passive: true })
  }
}
