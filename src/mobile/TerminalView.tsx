import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { TerminalCard } from '@/components/TerminalCard'
import { useNodeStore } from '@/stores/nodeStore'
import type { Camera } from '@/lib/camera'
import { bareTerminalGridFor, bareTerminalPixelSize, CELL_HEIGHT } from '../shared/node-size'
import type { NodeId } from '../shared/ids'
import { handTouchToCanvas } from '@/hooks/useTouchCamera'
import { NO_GLIDE, startGlide, VelocityTracker } from '@/lib/touch-momentum'
import { KeyRow } from './KeyRow'
import { TerminalGesture, LONG_PRESS_MS } from './terminal-gesture'

/**
 * One terminal surface, filling the screen and nothing else.
 *
 * It is the desktop's own `TerminalCard` — the same xterm, attach, replay and
 * input handling — without its title bar and footer, and with the surface
 * *borrowed* at a grid that fits this screen: the server remembers its own
 * size and gives it back when this closes, when the phone disconnects, or at
 * its next start (see `terminalBorrowSize`).
 *
 * Every touch goes to the gesture layer, never to xterm: drag up/down to
 * scroll — and a flicked scroll carries on after the finger lifts, as any iOS
 * scroll view does (touch-momentum.ts) — swipe sideways or pinch in to leave, tap to compose, long-press to
 * type with the keyboard and the extra keys, and again to put them away. See
 * terminal-gesture.ts. Leaving
 * happens mid-gesture, and the canvas takes the rest of it as a pan or pinch.
 */

/**
 * Text size as a fraction of the desktop's. Hard-coded while we find the right
 * number: 0.94 is ~50 columns on a 393-pt-wide phone (0.85 was ~55, too small).
 */
const SCALE = 0.94
/** Wait for the keyboard's animation to finish resizing before re-borrowing. */
const BORROW_SETTLE_MS = 150

const noop = () => undefined

/** Distance between the first two touches. */
function span(touches: TouchList): number {
  return Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY)
}

export function TerminalView({ nodeId, onClose, onCompose }: {
  nodeId: NodeId
  /** Back to the canvas; `swipe` when a sideways swipe did it, which zooms further out. */
  onClose: (via?: 'swipe') => void
  /** Called from inside the tap's touch handler, so it may take focus. */
  onCompose: () => void
}) {
  const node = useNodeStore((s) => s.nodes[nodeId])
  const terminal = node?.type === 'terminal' ? node : null
  const sessionId = terminal?.sessionId
  const scale = SCALE
  const cameraRef = useRef<Camera>({ x: 0, y: 0, z: scale })
  const areaRef = useRef<HTMLDivElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const [area, setArea] = useState({ width: 0, height: 0 })
  const [keyboard, setKeyboard] = useState(false)
  /** For the touch handlers, which are installed once. */
  const keyboardRef = useRef(keyboard)
  keyboardRef.current = keyboard
  const [swipeDx, setSwipeDx] = useState(0)
  const [pressArmed, setPressArmed] = useState(false)
  /** The row height the terminal really draws at on this phone; see TerminalCard's onRowHeight. */
  const [rowHeight, setRowHeight] = useState(CELL_HEIGHT)
  /** How far a pinch has closed, for the view to shrink with it; 1 when not pinching. */
  const [pinchScale, setPinchScale] = useState(1)

  // Hand the surface back to the canvas card on the way out (this card held
  // the live subscription), and give the surface its own size back.
  useEffect(() => {
    if (!sessionId) return
    return () => window.api.node.setTerminalMode(sessionId, 'snapshot')
  }, [sessionId])
  useEffect(() => () => { void window.api.node.terminalReturnSize(nodeId).catch(noop) }, [nodeId])

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

  // Borrow the grid that fits — again whenever the space changes, which is
  // mostly the keyboard opening and closing.
  const want = area.width > 0 ? bareTerminalGridFor(area.width, area.height, scale, rowHeight) : null
  const current = terminal ? { cols: terminal.cols, rows: terminal.rows } : null
  useEffect(() => {
    if (!want || !current || !terminal?.alive) return
    if (want.cols === current.cols && want.rows === current.rows) return
    const timer = setTimeout(() => {
      window.api.log(`[terminal-view] area ${area.width}x${area.height} at scale ${scale}, row ${rowHeight}px → ${want.cols}x${want.rows}`)
      void window.api.node.terminalBorrowSize(nodeId, want.cols, want.rows).catch(noop)
    }, BORROW_SETTLE_MS)
    return () => clearTimeout(timer)
  }, [nodeId, want?.cols, want?.rows, current?.cols, current?.rows, terminal?.alive])

  // ─── gestures ────────────────────────────────────────────────────────────

  const gestureRef = useRef(new TerminalGesture())
  const armTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const xtermScreen = () => cardRef.current?.querySelector<HTMLElement>('.xterm-screen') ?? null
  const textarea = () => cardRef.current?.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea') ?? null

  /**
   * A finger drag, as the wheel event a trackpad would have sent — so the
   * card's own wheel routing decides whether that means the TUI's mouse
   * protocol, its arrow keys, or the shell's scrollback, exactly as on the desktop.
   */
  const scrollBy = (deltaY: number, clientX: number, clientY: number) => {
    xtermScreen()?.dispatchEvent(new WheelEvent('wheel', {
      deltaY: deltaY / scale, deltaMode: WheelEvent.DOM_DELTA_PIXEL, clientX, clientY, bubbles: true, cancelable: true
    }))
  }

  useEffect(() => {
    const el = areaRef.current
    if (!el) return
    const g = gestureRef.current
    /** Velocity of a scrolling finger, for the glide when it lets go. */
    const tracker = new VelocityTracker()
    let scrolled: { x: number; y: number } | null = null
    let glide = NO_GLIDE
    /** A touch that stopped a glide stops it and nothing more — not a tap that opens the composer. */
    let caughtGlide = false

    const onStart = (e: TouchEvent) => {
      // Owning the touch from its start is what stops WebKit beginning a
      // long-press text selection; every outcome is decided here, not by it.
      e.preventDefault()
      caughtGlide = glide.active
      glide.stop()
      tracker.reset()
      scrolled = null
      clearTimeout(armTimer.current)
      if (e.touches.length >= 2) {
        // A second finger: the touch is a pinch from here on.
        setPressArmed(false)
        setSwipeDx(0)
        g.pinch(span(e.touches))
        return
      }
      const t = e.touches[0]
      g.begin(t.clientX, t.clientY, e.timeStamp)
      armTimer.current = setTimeout(() => { if (g.isStill()) setPressArmed(true) }, LONG_PRESS_MS)
    }
    /** Far enough to leave: go now, and let the canvas carry on with the fingers. */
    const leave = (e: TouchEvent, via?: 'swipe') => {
      clearTimeout(armTimer.current)
      onClose(via)
      handTouchToCanvas(e)
    }
    const onMove = (e: TouchEvent) => {
      e.preventDefault()
      if (e.touches.length >= 2) {
        const pinch = g.pinchMove(span(e.touches))
        if (pinch.kind === 'pinch') setPinchScale(Math.min(1, pinch.scale))
        else if (pinch.kind === 'exit') leave(e)
        return
      }
      const t = e.touches[0]
      const move = g.move(t.clientX, t.clientY)
      if (move.kind === 'exit') {
        leave(e, 'swipe')
        return
      }
      if (move.kind !== 'none') {
        clearTimeout(armTimer.current)
        setPressArmed(false)
      }
      if (move.kind === 'scroll') {
        scrollBy(move.deltaY, t.clientX, t.clientY)
        tracker.add(t.clientX, t.clientY, e.timeStamp)
        scrolled = { x: t.clientX, y: t.clientY }
      }
      else if (move.kind === 'swipe') setSwipeDx(move.dx)
    }
    const onEnd = (e: TouchEvent) => {
      if (e.touches.length > 0) return
      // No synthetic mouse events or click: xterm must never see the touch.
      e.preventDefault()
      clearTimeout(armTimer.current)
      setPressArmed(false)
      setSwipeDx(0)
      setPinchScale(1)
      const outcome = g.end(e.timeStamp)
      if (scrolled) {
        // Finger up is a positive wheel delta, so the glide's travel is negated.
        const at = scrolled
        glide = startGlide(0, tracker.velocity(e.timeStamp).vy, (_dx, dy) => scrollBy(-dy, at.x, at.y))
        return
      }
      if (caughtGlide) return
      if (outcome === 'tap') onCompose()
      else if (outcome === 'long-press') {
        // A second long press puts the keyboard away again; the blur ends
        // typing mode (below).
        if (keyboardRef.current) {
          textarea()?.blur()
          return
        }
        // Inside the touch handler, or iOS will not raise the keyboard.
        textarea()?.focus()
        setKeyboard(true)
      } else if (outcome === 'exit') onClose('swipe')
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
      clearTimeout(armTimer.current)
      glide.stop()
    }
  }, [onClose, onCompose])

  // The keyboard's own dismiss (and any other blur) ends typing mode.
  useEffect(() => {
    if (!keyboard) return
    const ta = textarea()
    if (!ta) return
    const onBlur = () => setKeyboard(false)
    ta.addEventListener('blur', onBlur)
    return () => ta.removeEventListener('blur', onBlur)
  }, [keyboard])

  if (!terminal) {
    return (
      <div className="mobile-term mobile-term--gone" onClick={() => onClose()}>
        <p>This surface is gone. Tap to return to the canvas.</p>
      </div>
    )
  }

  const size = bareTerminalPixelSize(terminal.cols, terminal.rows, rowHeight)
  cameraRef.current = { x: 0, y: 0, z: scale }

  return (
    <div className={`mobile-term${keyboard ? ' mobile-term--typing' : ''}`}>
      <div
        ref={areaRef}
        className="mobile-term__area"
        style={
          swipeDx ? { transform: `translateX(${swipeDx}px)`, opacity: Math.max(0.4, 1 - Math.abs(swipeDx) / 300) }
            : pinchScale < 1 ? { transform: `scale(${pinchScale})`, opacity: Math.max(0.4, pinchScale) }
            : undefined
        }
      >
        <div ref={cardRef} className="mobile-term__card" style={{ transform: `scale(${scale})`, width: size.width, height: size.height }}>
          <TerminalCard
            id={terminal.id}
            sessionId={terminal.sessionId}
            x={size.width / 2}
            y={size.height / 2}
            cols={terminal.cols}
            rows={terminal.rows}
            zIndex={1}
            zoom={scale}
            name={terminal.name ?? undefined}
            colorPresetId={terminal.colorPresetId}
            shellTitleHistory={terminal.shellTitleHistory}
            cwd={terminal.cwd}
            focused
            selected={false}
            anyNodeFocused
            claudeStatusUnread={terminal.claudeStatusUnread}
            claudeStatusAsleep={terminal.claudeStatusAsleep}
            scrollMode
            onFocus={noop}
            onUnfocus={noop}
            onDisableScrollMode={noop}
            onForwardWheelToCanvas={noop}
            onClose={noop}
            onMove={noop}
            onRename={noop}
            archivedChildren={terminal.archivedChildren}
            onColorChange={noop}
            onStampChange={noop}
            onOpenArchiveSearch={noop}
            claudeSessionHistory={terminal.claudeSessionHistory}
            agentType={terminal.agentType}
            claudeState={terminal.claudeState}
            claudeModel={terminal.claudeModel}
            claudeEffort={terminal.claudeEffort}
            terminalSessions={terminal.terminalSessions}
            lastInteractedAt={terminal.lastInteractedAt}
            cameraRef={cameraRef}
            chromeless
            autoFocus={false}
            onRowHeight={setRowHeight}
          />
        </div>
        {pressArmed && <div className="mobile-term__press" aria-hidden />}
      </div>
      {keyboard && <KeyRow sessionId={terminal.sessionId} onHide={() => textarea()?.blur()} />}
    </div>
  )
}
