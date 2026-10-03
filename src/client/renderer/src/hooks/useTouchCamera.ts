import { useEffect, useRef } from 'react'
import { Momentum, VelocityTracker } from '../lib/touch-momentum'

/**
 * Touch for the canvas camera: one finger pans, two pinch-zoom about their
 * midpoint (and pan with it).
 *
 * Mouse and trackpad arrive as mouse and wheel events, which iOS does not
 * synthesise for a drag — it scrolls the page instead — so without this a
 * phone cannot move the canvas at all. Nothing here runs on a desktop, which
 * never produces touch events.
 *
 * A tap is left alone: below the slop distance nothing is prevented, so the
 * browser still turns it into the click that focuses a card. A finger held
 * still is a long press — the touch version of a desktop ⌘-click — and its
 * click is suppressed, so it does not also focus whatever it was held on.
 * Moving on from a long press, without lifting, drags what was pressed
 * instead of panning — the touch version of dragging a card by its title.
 *
 * A pan that is still moving when the finger lifts carries on and eases to a
 * stop, the way iOS scroll views do (see touch-momentum.ts); the next touch
 * catches it.
 *
 * A touch that began somewhere else — the phone's full-screen terminal — can
 * be handed over part way through with `handTouchToCanvas`, and carries on
 * here as a pan or pinch from where the fingers are.
 */

/** Movement below this many pixels is still a tap. */
const TAP_SLOP_PX = 8
const LONG_PRESS_MS = 500

export interface TouchCameraControls {
  pan(dx: number, dy: number): void
  zoom(anchor: { x: number; y: number }, z: number): void
  getZoom(): number
  /** A pan or pinch has begun — the canvas equivalent of a background drag. */
  onGestureStart(): void
  /** A finger held still on one spot. */
  onLongPress?(point: { x: number; y: number }): void
  /**
   * The finger moved on after a long press. `dx`, `dy` are screen pixels from
   * where it was pressed. Returning false from the first call (nothing there
   * to drag) makes it an ordinary pan.
   */
  onLongPressDrag?(dx: number, dy: number): boolean
  /** The finger lifted from a long-press drag. */
  onLongPressDragEnd?(): void
}

type Point = { x: number; y: number }

/** The mounted canvas's way to take over a touch; see `handTouchToCanvas`. */
let adoptTouch: ((e: TouchEvent) => boolean) | null = null

/**
 * Let the canvas finish a touch that something else began: one finger pans
 * and two pinch, from their current positions, until the last finger lifts.
 * Call it from that touch's own event, after the view that began it has
 * decided to leave. The touch keeps its original target even if that view
 * unmounts, so the canvas follows it there. False when there is no canvas.
 */
export function handTouchToCanvas(e: TouchEvent): boolean {
  return adoptTouch?.(e) ?? false
}

const midpoint = (a: Touch, b: Touch): Point => ({ x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 })
const distance = (a: Touch, b: Touch): number => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)

export function useTouchCamera(selector: string, controls: TouchCameraControls): void {
  const controlsRef = useRef(controls)
  controlsRef.current = controls

  useEffect(() => {
    const el = document.querySelector<HTMLElement>(selector)
    if (!el) return

    let origin: Point | null = null
    let last: Point | null = null
    let panning = false
    let pinch: { startDistance: number; startZoom: number; last: Point } | null = null
    let pressTimer: ReturnType<typeof setTimeout> | undefined
    let longPressed = false
    /** After a long press, whether the finger has moved on to drag a node. */
    let pressDragging = false
    const cancelPress = () => clearTimeout(pressTimer)

    const tracker = new VelocityTracker()
    let glideFrame = 0
    const stopGlide = () => {
      cancelAnimationFrame(glideFrame)
      glideFrame = 0
    }
    /** Carry the pan on from the finger's release velocity until it decays away. */
    const glide = (vx: number, vy: number) => {
      const momentum = new Momentum(vx, vy)
      if (!momentum.moving) return
      let last = performance.now()
      const frame = (now: number) => {
        const step = momentum.step(now - last)
        last = now
        if (!step) {
          glideFrame = 0
          return
        }
        // pan() takes the camera's motion, which is opposite to the finger's.
        controlsRef.current.pan(-step.dx, -step.dy)
        glideFrame = requestAnimationFrame(frame)
      }
      glideFrame = requestAnimationFrame(frame)
    }

    const begin = () => {
      cancelPress()
      if (!panning && !pinch) controlsRef.current.onGestureStart()
    }

    const onStart = (e: TouchEvent) => {
      // A touch catches a glide in progress, as on any iOS scroll view.
      stopGlide()
      tracker.reset()
      if (e.touches.length === 1) {
        tracker.add(e.touches[0].clientX, e.touches[0].clientY, e.timeStamp)
        origin = last = { x: e.touches[0].clientX, y: e.touches[0].clientY }
        panning = false
        pinch = null
        longPressed = false
        pressDragging = false
        const at = origin
        cancelPress()
        pressTimer = setTimeout(() => {
          if (panning || pinch || !controlsRef.current.onLongPress) return
          longPressed = true
          controlsRef.current.onLongPress(at)
        }, LONG_PRESS_MS)
      } else if (e.touches.length === 2) {
        begin()
        const [a, b] = [e.touches[0], e.touches[1]]
        pinch = { startDistance: Math.max(1, distance(a, b)), startZoom: controlsRef.current.getZoom(), last: midpoint(a, b) }
        panning = false
      }
    }

    const onMove = (e: TouchEvent) => {
      if (pinch && e.touches.length >= 2) {
        e.preventDefault()
        const [a, b] = [e.touches[0], e.touches[1]]
        const mid = midpoint(a, b)
        controlsRef.current.pan(pinch.last.x - mid.x, pinch.last.y - mid.y)
        controlsRef.current.zoom(mid, pinch.startZoom * (distance(a, b) / pinch.startDistance))
        pinch.last = mid
        return
      }
      if (e.touches.length !== 1 || !origin || !last) return
      const t = e.touches[0]
      if (longPressed && !panning) {
        e.preventDefault()
        const dx = t.clientX - origin.x
        const dy = t.clientY - origin.y
        if (pressDragging) {
          controlsRef.current.onLongPressDrag?.(dx, dy)
          return
        }
        if (Math.hypot(dx, dy) < TAP_SLOP_PX) return
        pressDragging = !!controlsRef.current.onLongPressDrag?.(dx, dy)
        if (pressDragging) return
        // Nothing to drag: pan from here, as if the press had not been held.
      }
      if (!panning) {
        if (Math.hypot(t.clientX - origin.x, t.clientY - origin.y) < TAP_SLOP_PX) return
        begin()
        panning = true
      }
      e.preventDefault()
      controlsRef.current.pan(last.x - t.clientX, last.y - t.clientY)
      last = { x: t.clientX, y: t.clientY }
      tracker.add(t.clientX, t.clientY, e.timeStamp)
    }

    const onEnd = (e: TouchEvent) => {
      if (e.touches.length === 0) {
        cancelPress()
        // The press already did something; it must not also become a click.
        if (longPressed && e.cancelable) e.preventDefault()
        if (pressDragging) controlsRef.current.onLongPressDragEnd?.()
        pressDragging = false
        if (panning && !pinch && !longPressed) {
          const { vx, vy } = tracker.velocity(e.timeStamp)
          glide(vx, vy)
        }
        longPressed = false
        origin = last = null
        panning = false
        pinch = null
      } else if (e.touches.length === 1) {
        // Lifting one finger of a pinch continues as a pan from where it is.
        pinch = null
        panning = true
        last = { x: e.touches[0].clientX, y: e.touches[0].clientY }
        origin = last
        tracker.reset()
      }
    }

    let releaseAdopted: (() => void) | null = null
    adoptTouch = (e: TouchEvent) => {
      const target = e.target
      if (!target || e.touches.length === 0) return false
      releaseAdopted?.()
      stopGlide()
      cancelPress()
      tracker.reset()
      longPressed = false
      pressDragging = false
      origin = last = null
      panning = false
      pinch = null
      begin()
      if (e.touches.length >= 2) {
        const [a, b] = [e.touches[0], e.touches[1]]
        pinch = { startDistance: Math.max(1, distance(a, b)), startZoom: controlsRef.current.getZoom(), last: midpoint(a, b) }
      } else {
        // Already moving: no slop to cross, it pans from the first move.
        const t = e.touches[0]
        origin = last = { x: t.clientX, y: t.clientY }
        panning = true
        tracker.add(t.clientX, t.clientY, e.timeStamp)
      }
      const end = (ev: TouchEvent) => {
        onEnd(ev)
        if (ev.touches.length === 0) releaseAdopted?.()
      }
      target.addEventListener('touchmove', onMove as EventListener, { passive: false })
      target.addEventListener('touchend', end as EventListener, { passive: false })
      target.addEventListener('touchcancel', end as EventListener, { passive: false })
      releaseAdopted = () => {
        target.removeEventListener('touchmove', onMove as EventListener)
        target.removeEventListener('touchend', end as EventListener)
        target.removeEventListener('touchcancel', end as EventListener)
        releaseAdopted = null
      }
      return true
    }

    el.addEventListener('touchstart', onStart, { passive: true })
    el.addEventListener('touchmove', onMove, { passive: false })
    el.addEventListener('touchend', onEnd, { passive: false })
    el.addEventListener('touchcancel', onEnd, { passive: false })
    return () => {
      adoptTouch = null
      releaseAdopted?.()
      cancelPress()
      stopGlide()
      el.removeEventListener('touchstart', onStart)
      el.removeEventListener('touchmove', onMove)
      el.removeEventListener('touchend', onEnd)
      el.removeEventListener('touchcancel', onEnd)
    }
  }, [selector])
}
