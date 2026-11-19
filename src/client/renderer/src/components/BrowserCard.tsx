import { useCallback, useEffect, useRef } from 'react'
import { browserCardSize } from '../../../../shared/node-size'
import { BROWSER_PROFILE_LABELS, type BrowserProfile } from '../../../../shared/browser'
import type { ArchivedNode } from '../../../../shared/state'
import type { ColorPreset } from '../lib/color-presets'
import type { Camera } from '../lib/camera'
import { keyInput, modifiersOf, mouseButtonOf, pagePoint } from '../lib/browser-input'
import { CardShell } from './CardShell'
import { statusText, useBrowserFrames } from '../hooks/useBrowserFrames'
import { useReparentStore } from '../stores/reparentStore'
import { useSurfacePresenterStore } from '../stores/surfacePresenterStore'
import { type NodeId } from '../../../../shared/ids'

const DRAG_THRESHOLD = 5

interface BrowserCardProps {
  id: NodeId
  x: number
  y: number
  zIndex: number
  zoom: number
  profile: BrowserProfile
  url: string
  title: string
  /** The page's own size, in CSS pixels. */
  width: number
  height: number
  focused: boolean
  selected: boolean
  colorPresetId?: string
  resolvedPreset?: ColorPreset
  archivedChildren: ArchivedNode[]
  onFocus: (id: NodeId) => void
  onClose: (id: NodeId) => void
  onMove: (id: NodeId, x: number, y: number, metaKey?: boolean, shiftKey?: boolean) => void
  onColorChange: (id: NodeId, color: string) => void
  onOpenArchiveSearch: (nodeId: NodeId) => void
  onNodeReady?: (nodeId: NodeId, bounds: { x: number; y: number; width: number; height: number }) => void
  onDragStart?: (id: NodeId, solo?: boolean, ctrlAtStart?: boolean, shiftAtStart?: boolean) => void
  onDragEnd?: (id: NodeId) => void
  onStartReparent?: (id: NodeId) => void
  onReparentTarget?: (id: NodeId) => void
  onAddNode?: (parentNodeId: NodeId, type: import('./AddNodeBody').AddNodeType) => void
  cameraRef: React.MutableRefObject<Camera>
}

/**
 * A web page an agent opened. Unfocused it shows a thumbnail now and then;
 * focused it is live, and takes the mouse, wheel and keyboard. The page itself
 * runs on the server's side — see `shared/browser.ts`.
 */
export function BrowserCard({
  id, x, y, zIndex, zoom, profile, url, title, width, height, focused, selected, resolvedPreset, archivedChildren,
  onFocus, onClose, onMove, onColorChange, onOpenArchiveSearch, onNodeReady,
  onDragStart, onDragEnd, onStartReparent, onReparentTarget, onAddNode, cameraRef
}: BrowserCardProps) {
  const size = browserCardSize(width, height)
  const propsRef = useRef({ x, y })
  propsRef.current = { x, y }
  const reparentingNodeId = useReparentStore(s => s.reparentingNodeId)
  // The phone shows a focused page full screen (BrowserView); the card stays a thumbnail under it.
  const presentedElsewhere = useSurfacePresenterStore(s => s.external)
  const live = focused && !presentedElsewhere
  // Quarter steps, so a wheel notch of zoom does not resend the watch.
  const scale = live ? Math.round(zoom * window.devicePixelRatio * 4) / 4 : 0.5
  const { frame, status, imgRef } = useBrowserFrames(id, { live, scale })
  const frameRef = useRef(frame)
  frameRef.current = frame
  const pageRef = useRef<HTMLDivElement>(null)
  const keysRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!focused) return
    onNodeReady?.(id, { x: x - size.width / 2, y: y - size.height / 2, width: size.width, height: size.height })
  }, [focused, id, x, y, size.width, size.height, onNodeReady])

  // Keys go to the page while it is focused. App's own shortcuts are taken in
  // the capture phase before they get here.
  useEffect(() => {
    if (live) keysRef.current?.focus({ preventScroll: true })
  }, [live])

  /** A client point on the page, in its CSS pixels. */
  const toPage = useCallback((clientX: number, clientY: number) => {
    const img = imgRef.current
    const current = frameRef.current
    if (!img || !current) return null
    return pagePoint(clientX, clientY, img.getBoundingClientRect(), current)
  }, [imgRef])

  // Wheel scrolls the page rather than zooming the canvas, while live. A native
  // listener, since the canvas's is native and would otherwise run first.
  useEffect(() => {
    const el = pageRef.current
    if (!el || !live) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      e.stopPropagation()
      const at = toPage(e.clientX, e.clientY)
      if (!at) return
      window.api.browser.input(id, { kind: 'wheel', ...at, deltaX: e.deltaX, deltaY: e.deltaY, modifiers: modifiersOf(e) })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [id, live, toPage])

  // Hover, for menus and link previews: at most one move per frame.
  const hoverFrame = useRef<number | null>(null)
  const handlePageMouseMove = (e: React.MouseEvent) => {
    if (!live || e.buttons !== 0 || hoverFrame.current !== null) return
    const { clientX, clientY } = e
    hoverFrame.current = requestAnimationFrame(() => {
      hoverFrame.current = null
      const at = toPage(clientX, clientY)
      if (at) window.api.browser.input(id, { kind: 'mouse', type: 'mouseMoved', ...at, button: 'none', clickCount: 0, modifiers: 0 })
    })
  }

  const handlePageMouseDown = (e: React.MouseEvent) => {
    if (!live) return
    e.stopPropagation()
    e.preventDefault()
    keysRef.current?.focus({ preventScroll: true })
    const at = toPage(e.clientX, e.clientY)
    if (!at) return
    const button = mouseButtonOf(e.button)
    const clickCount = e.detail || 1
    window.api.browser.input(id, { kind: 'mouse', type: 'mousePressed', ...at, button, clickCount, modifiers: modifiersOf(e) })
    // A drag selects text or moves a slider; it carries on outside the card.
    const onMove = (ev: MouseEvent) => {
      const p = toPage(ev.clientX, ev.clientY)
      if (p) window.api.browser.input(id, { kind: 'mouse', type: 'mouseMoved', ...p, button, clickCount, modifiers: modifiersOf(ev) })
    }
    const onUp = (ev: MouseEvent) => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      const p = toPage(ev.clientX, ev.clientY) ?? at
      window.api.browser.input(id, { kind: 'mouse', type: 'mouseReleased', ...p, button, clickCount, modifiers: modifiersOf(ev) })
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  const handleKey = (e: React.KeyboardEvent, type: 'keyDown' | 'keyUp') => {
    if (!live) return
    // Escape leaves the page to the canvas, as in a terminal.
    if (e.key === 'Escape') return
    e.preventDefault()
    e.stopPropagation()
    window.api.browser.input(id, keyInput(e.nativeEvent, type))
  }

  const handleMouseDown = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('.node-titlebar__actions, .node-titlebar__color-picker, .archive-body, .browser-card__nav')) return
    e.preventDefault()
    const startScreenX = e.clientX
    const startScreenY = e.clientY
    const startX = propsRef.current.x
    const startY = propsRef.current.y
    const currentZoom = cameraRef.current.z
    const ctrlAtStart = e.ctrlKey
    let dragging = false

    const onMouseMove = (ev: MouseEvent) => {
      const dx = ev.clientX - startScreenX
      const dy = ev.clientY - startScreenY
      if (!dragging && Math.abs(dx) + Math.abs(dy) > DRAG_THRESHOLD) {
        dragging = true
        onDragStart?.(id, ev.metaKey, ctrlAtStart, ev.shiftKey)
      }
      if (dragging) onMove(id, startX + dx / currentZoom, startY + dy / currentZoom, ev.metaKey, ev.shiftKey)
    }

    const onMouseUp = () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
      if (dragging) onDragEnd?.(id)
      else if (useReparentStore.getState().reparentingNodeId) onReparentTarget?.(id)
      else onFocus(id)
    }

    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
  }

  const message = statusText(status, frame !== null)
  const heading = title || url

  return (
    <CardShell
      nodeId={id}
      x={x - size.width / 2}
      y={y - size.height / 2}
      width={size.width}
      height={size.height}
      zIndex={zIndex}
      focused={focused}
      headVariant="visible"
      titleContent={
        <div className="browser-card__head">
          <span className="browser-card__profile">{BROWSER_PROFILE_LABELS[profile]}</span>
          <span className="browser-card__title" title={url}>{heading}</span>
          <span className="browser-card__nav">
            <button type="button" title="Back" onClick={() => window.api.browser.history(id, 'back')}>‹</button>
            <button type="button" title="Forward" onClick={() => window.api.browser.history(id, 'forward')}>›</button>
            <button type="button" title="Reload" onClick={() => window.api.browser.history(id, 'reload')}>↻</button>
          </span>
        </div>
      }
      headStyle={resolvedPreset ? {
        backgroundColor: resolvedPreset.titleBarBg,
        color: resolvedPreset.titleBarFg,
        borderBottomColor: resolvedPreset.titleBarBg
      } : undefined}
      preset={resolvedPreset}
      archivedChildren={archivedChildren}
      onClose={onClose}
      onColorChange={onColorChange}
      onOpenArchiveSearch={onOpenArchiveSearch}
      onMouseDown={handleMouseDown}
      onStartReparent={onStartReparent}
      onAddNode={onAddNode}
      isReparenting={reparentingNodeId === id}
      className={`terminal-card browser-card ${focused ? 'terminal-card--focused' : selected ? 'terminal-card--selected' : ''}`}
      onMouseEnter={() => { if (reparentingNodeId) useReparentStore.getState().setHoveredNode(id) }}
      onMouseLeave={() => { if (reparentingNodeId) useReparentStore.getState().setHoveredNode(null) }}
    >
      <div
        ref={pageRef}
        className={`browser-card__page${live ? ' browser-card__page--live' : ''}`}
        onMouseDown={handlePageMouseDown}
        onMouseMove={handlePageMouseMove}
        onContextMenu={(e) => { if (live) e.preventDefault() }}
      >
        {frame && <img ref={imgRef} className="browser-card__frame" src={frame.src} alt="" draggable={false} />}
        {message && <div className="browser-card__status">{message}</div>}
        <div
          ref={keysRef}
          className="browser-card__keys"
          tabIndex={-1}
          onKeyDown={(e) => handleKey(e, 'keyDown')}
          onKeyUp={(e) => handleKey(e, 'keyUp')}
        />
      </div>
    </CardShell>
  )
}
