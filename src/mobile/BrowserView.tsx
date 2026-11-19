import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useNodeStore } from '@/stores/nodeStore'
import { statusText, useBrowserFrames } from '@/hooks/useBrowserFrames'
import { pagePoint } from '@/lib/browser-input'
import { NO_GLIDE, startGlide, VelocityTracker } from '@/lib/touch-momentum'
import type { NodeId } from '../shared/ids'
import type { BrowserInput } from '../shared/browser'

/** A finger that moves less than this before lifting tapped. */
const TAP_SLOP_PX = 8
/** Two fingers closing to this fraction of where they started leave the page. */
const PINCH_EXIT = 0.6

function span(touches: TouchList): number {
  return Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY)
}

/**
 * A browser card's page, full screen above the bottom bar, laid out for this
 * phone: the page is lent this screen's size and told it is a phone for as
 * long as the view is open, and gets its own size back when it closes.
 *
 * A tap is a tap on the page, a drag scrolls it (and a flick carries on), two
 * fingers pinching in go back to the canvas. Typing goes through a hidden
 * field, so the iOS keyboard and dictation both work.
 */
export function BrowserView({ nodeId, onClose }: { nodeId: NodeId; onClose: () => void }) {
  const node = useNodeStore((s) => s.nodes[nodeId])
  const browser = node?.type === 'browser' ? node : null
  const areaRef = useRef<HTMLDivElement>(null)
  const typingRef = useRef<HTMLInputElement>(null)
  const [area, setArea] = useState({ width: 0, height: 0 })

  useLayoutEffect(() => {
    const el = areaRef.current
    if (!el) return
    const measure = () => setArea((a) =>
      a.width === el.clientWidth && a.height === el.clientHeight ? a : { width: el.clientWidth, height: el.clientHeight })
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const viewport = area.width > 0 ? { width: area.width, height: area.height, mobile: true } : undefined
  const { frame, status, imgRef } = useBrowserFrames(nodeId, { live: true, scale: window.devicePixelRatio, viewport })
  const frameRef = useRef(frame)
  frameRef.current = frame

  useEffect(() => {
    window.api.log(`[mobile-view] browser view mounted for ${nodeId}`)
    return () => window.api.log(`[mobile-view] browser view unmounted for ${nodeId}`)
  }, [nodeId])

  // ─── touches ─────────────────────────────────────────────────────────────

  useEffect(() => {
    const el = areaRef.current
    if (!el) return
    const send = (input: BrowserInput) => window.api.browser.input(nodeId, input)
    const toPage = (clientX: number, clientY: number) => {
      const img = imgRef.current
      const current = frameRef.current
      return img && current ? pagePoint(clientX, clientY, img.getBoundingClientRect(), current) : null
    }
    const wheel = (dx: number, dy: number, clientX: number, clientY: number) => {
      const at = toPage(clientX, clientY)
      if (at) send({ kind: 'wheel', ...at, deltaX: dx, deltaY: dy, modifiers: 0 })
    }

    const tracker = new VelocityTracker()
    let glide = NO_GLIDE
    let start: { x: number; y: number } | null = null
    let last: { x: number; y: number } | null = null
    let scrolling = false
    let pinchFrom = 0

    const onStart = (e: TouchEvent) => {
      e.preventDefault()
      glide.stop()
      if (e.touches.length >= 2) {
        start = null
        pinchFrom = span(e.touches)
        return
      }
      const t = e.touches[0]
      start = last = { x: t.clientX, y: t.clientY }
      scrolling = false
      tracker.reset()
      tracker.add(t.clientX, t.clientY, e.timeStamp)
    }
    const onMove = (e: TouchEvent) => {
      e.preventDefault()
      if (e.touches.length >= 2) {
        if (pinchFrom > 0 && span(e.touches) < pinchFrom * PINCH_EXIT) {
          pinchFrom = 0
          onClose()
        }
        return
      }
      const t = e.touches[0]
      if (!start || !last) return
      if (!scrolling && Math.hypot(t.clientX - start.x, t.clientY - start.y) < TAP_SLOP_PX) return
      scrolling = true
      // The page moves with the finger, so a finger going up scrolls down.
      wheel(last.x - t.clientX, last.y - t.clientY, t.clientX, t.clientY)
      last = { x: t.clientX, y: t.clientY }
      tracker.add(t.clientX, t.clientY, e.timeStamp)
    }
    const onEnd = (e: TouchEvent) => {
      if (e.touches.length > 0) return
      e.preventDefault()
      const at = last
      if (scrolling && at) {
        const { vx, vy } = tracker.velocity(e.timeStamp)
        glide = startGlide(vx, vy, (dx, dy) => wheel(-dx, -dy, at.x, at.y))
      } else if (start && e.type === 'touchend') {
        const p = toPage(start.x, start.y)
        if (p) send({ kind: 'tap', ...p })
      }
      start = last = null
      scrolling = false
    }
    el.addEventListener('touchstart', onStart, { passive: false })
    el.addEventListener('touchmove', onMove, { passive: false })
    el.addEventListener('touchend', onEnd, { passive: false })
    el.addEventListener('touchcancel', onEnd, { passive: false })
    return () => {
      el.removeEventListener('touchstart', onStart)
      el.removeEventListener('touchmove', onMove)
      el.removeEventListener('touchend', onEnd)
      el.removeEventListener('touchcancel', onEnd)
      glide.stop()
    }
  }, [nodeId, onClose, imgRef])

  // ─── typing ──────────────────────────────────────────────────────────────

  useEffect(() => {
    const input = typingRef.current
    if (!input) return
    const send = (value: BrowserInput) => window.api.browser.input(nodeId, value)
    const press = (key: string, code: string, keyCode: number, text?: string) => {
      send({ kind: 'key', type: 'keyDown', key, code, keyCode, modifiers: 0, ...(text ? { text } : {}) })
      send({ kind: 'key', type: 'keyUp', key, code, keyCode, modifiers: 0 })
    }
    // The field stays empty: each edit is sent to the page and undone here.
    // Text arrives as an edit, which is how the keyboard, autocorrect and
    // dictation all deliver it; Backspace and Enter are keys, since an empty
    // field has nothing for them to edit.
    const onBeforeInput = (e: InputEvent) => {
      e.preventDefault()
      if (e.inputType.startsWith('insert') && e.data) send({ kind: 'text', text: e.data })
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Backspace') press('Backspace', 'Backspace', 8)
      else if (e.key === 'Enter') press('Enter', 'Enter', 13, '\r')
      else return
      e.preventDefault()
    }
    input.addEventListener('beforeinput', onBeforeInput)
    input.addEventListener('keydown', onKeyDown)
    return () => {
      input.removeEventListener('beforeinput', onBeforeInput)
      input.removeEventListener('keydown', onKeyDown)
    }
  }, [nodeId])

  const message = browser ? statusText(status, frame !== null) : 'This page is gone.'

  return (
    <div className="mobile-term mobile-browser">
      <div className="mobile-term__bar">
        <button type="button" className="mobile-browser__btn" onClick={() => onClose()} aria-label="Back to the canvas">✕</button>
        <span className="mobile-term__title">{browser ? browser.title || browser.url : ''}</span>
        <button type="button" className="mobile-browser__btn" onClick={() => window.api.browser.history(nodeId, 'back')} aria-label="Back">‹</button>
        <button type="button" className="mobile-browser__btn" onClick={() => window.api.browser.history(nodeId, 'forward')} aria-label="Forward">›</button>
        <button type="button" className="mobile-browser__btn" onClick={() => window.api.browser.history(nodeId, 'reload')} aria-label="Reload">↻</button>
        {/* Focused inside the tap, which is what lets iOS raise the keyboard. */}
        <button type="button" className="mobile-browser__btn" onClick={() => typingRef.current?.focus()} aria-label="Keyboard">⌨︎</button>
      </div>
      <div ref={areaRef} className="mobile-term__area mobile-browser__area">
        {frame && <img ref={imgRef} className="mobile-browser__frame" src={frame.src} alt="" draggable={false} />}
        {message && <div className="mobile-browser__status">{message}</div>}
      </div>
      <input
        ref={typingRef}
        className="mobile-browser__typing"
        aria-hidden
        autoCapitalize="off"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
      />
    </div>
  )
}
