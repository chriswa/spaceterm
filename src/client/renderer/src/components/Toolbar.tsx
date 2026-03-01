import { useRef, useEffect, useLayoutEffect, useState } from 'react'
import { useFps } from '../hooks/useFps'
import { usePerfStore } from '../stores/perfStore'
import { useAudioStore } from '../stores/audioStore'
import crabIcon from '../assets/crab.png'
import terminalIcon from '../assets/terminal.png'
import type { CrabEntry } from '../lib/crab-nav'
import { CrabDance } from '../lib/crab-dance'
import { useHoveredCardStore } from '../stores/hoveredCardStore'
import { useUsageStore } from '../stores/usageStore'
import { useGhRateLimitStore } from '../stores/ghRateLimitStore'
import { useFontStore, FONT_THEMES } from '../stores/fontStore'
import { useCameraLockStore } from '../stores/cameraLockStore'
import { useNotificationSoundStore } from '../stores/notificationSoundStore'

export type CrabNavEvent = { fromNodeId: string | null; toNodeId: string; ts: number } | null

interface ToolbarProps {
  crabs: CrabEntry[]
  onCrabClick: (nodeId: string, metaKey: boolean) => void
  onCrabReorder: (order: string[]) => void
  selectedNodeId: string | null
  crabNavEvent: CrabNavEvent
  zoom: number
  onHelpClick: () => void
  keycastEnabled: boolean
  onKeycastToggle: () => void
  onDebugCapture: () => void
  goodGfx: boolean
  onGoodGfxToggle: () => void
}

export function Toolbar({
  crabs, onCrabClick, onCrabReorder, selectedNodeId, crabNavEvent, zoom,
  onHelpClick,
  keycastEnabled, onKeycastToggle,
  onDebugCapture,
  goodGfx, onGoodGfxToggle
}: ToolbarProps) {
  const fpsRef = useRef<HTMLSpanElement>(null)
  useFps(fpsRef)
  const recording = usePerfStore(s => s.recording)
  const startTrace = usePerfStore(s => s.startTrace)
  const tracing = recording === 'trace'
  return (
    <div className="toolbar">
      <button
        className="toolbar__btn"
        onClick={onHelpClick}
        data-tooltip="Help (⌘?)"
        data-tooltip-no-flip
      >
        ?
      </button>
      <FullscreenToggle />
      <CameraLockToggle />
      <div className="toolbar__perf">
        <button
          className={'toolbar__btn' + (tracing ? ' toolbar__btn--recording' : '')}
          onClick={startTrace}
          disabled={tracing}
          data-tooltip="Perf Trace — Record 5s Chrome content trace"
          data-tooltip-no-flip
        >
          <MagnifyIcon />
        </button>
      </div>
      <button
        className="toolbar__btn"
        onClick={onDebugCapture}
        data-tooltip="Camera Debug — Copy camera/viewport state to clipboard"
        data-tooltip-no-flip
      >
        <MagnifyIcon />
      </button>
      <button
        className={'toolbar__btn' + (goodGfx ? ' toolbar__btn--active' : '')}
        onClick={onGoodGfxToggle}
        data-tooltip={goodGfx ? 'Good Gfx — Switch to simple background shader' : 'Good Gfx — Switch to full background shader'}
        data-tooltip-no-flip
      >
        ✦
      </button>
      <button
        className={'toolbar__btn' + (keycastEnabled ? ' toolbar__btn--active' : '')}
        onClick={onKeycastToggle}
        data-tooltip="Keycast — Show key presses on screen"
        data-tooltip-no-flip
      >
        <KeycastIcon />
      </button>
      <AudioTapToggle />
      <BeatsToggle />
      <NotificationSoundToggle />
      <ProportionalFontToggle />
      <BeatIndicators />
      <span className="toolbar__zoom">
        <BpmIndicator />
        <span className="toolbar__status-item toolbar__metric"><span ref={fpsRef}>0</span> <span className="toolbar__metric-label">fps</span></span>
        <span className="toolbar__status-item toolbar__metric">{(zoom * 100).toFixed(2)}<span className="toolbar__metric-label">%</span></span>
        <GhRateLimitIndicator />
        <UsageIndicators />
      </span>
      {crabs.length > 0 && (
        <CrabGroup crabs={crabs} onCrabClick={onCrabClick} onCrabReorder={onCrabReorder} selectedNodeId={selectedNodeId} crabNavEvent={crabNavEvent} />
      )}
    </div>
  )
}

function KeycastIcon() {
  // Vintage keyboard key from the front, slightly above.
  // Cap: front face (rectangle) + thin top surface strip visible from above.
  // Base is wider than the cap, so the back perspective lines peek out on
  // the sides — the "perspective trick" that makes it read as a 3D key.
  return (
    <svg viewBox="0 0 18 18" width="1em" height="1em" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" strokeLinecap="round" style={{ display: 'block' }}>
      {/* Cap: front face + top surface (lit from above) */}
      <path d="M5 5 L4 3 L14 3 L13 5 L13 10 L5 10 Z" fill="currentColor" fillOpacity="0.2" />
      {/* Front slopes down to wider base front edge */}
      <path d="M5 10 L2 16 L16 16 L13 10" />
      {/* Back perspective lines + base back edge (visible outside cap because base is wider) */}
      <path d="M4 3 L1 14 L17 14 L14 3" />
      {/* Short base side connectors joining front and back base edges */}
      <line x1="1" y1="14" x2="2" y2="16" />
      <line x1="17" y1="14" x2="16" y2="16" />
    </svg>
  )
}

function MagnifyIcon() {
  return (
    <svg viewBox="0 0 16 16" width="1em" height="1em" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" style={{ display: 'block' }}>
      <circle cx="6.5" cy="6.5" r="4.5" />
      <line x1="9.7" y1="9.7" x2="14" y2="14" />
    </svg>
  )
}

function AudioVisIcon() {
  const bars: Array<[number, number]> = [
    [1, 1.5], [4, 4], [7, 6], [10, 2.5], [13, 5.5], [16, 3], [19, 1.5]
  ]
  return (
    <svg viewBox="0 0 20 14" width="1em" height="1em" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" style={{ display: 'block' }}>
      {bars.map(([x, h], i) => (
        <line key={i} x1={x} y1={7 - h} x2={x} y2={7 + h} />
      ))}
    </svg>
  )
}

function FullscreenIcon() {
  return (
    <svg viewBox="0 0 16 16" width="1em" height="1em" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" style={{ display: 'block' }}>
      <polyline points="1,5 1,1 5,1" />
      <polyline points="11,1 15,1 15,5" />
      <polyline points="15,11 15,15 11,15" />
      <polyline points="5,15 1,15 1,11" />
    </svg>
  )
}

function LockIcon() {
  return (
    <svg viewBox="0 0 16 16" width="1em" height="1em" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" strokeLinecap="round" style={{ display: 'block' }}>
      {/* Shackle */}
      <path d="M5 7V5a3 3 0 0 1 6 0v2" />
      {/* Body */}
      <rect x="3.5" y="7" width="9" height="7" rx="1.5" fill="currentColor" fillOpacity="0.2" />
    </svg>
  )
}

function CameraLockToggle() {
  const locked = useCameraLockStore(s => s.locked)
  const toggle = useCameraLockStore(s => s.toggle)
  return (
    <button
      className={'toolbar__btn' + (locked ? ' toolbar__btn--active' : '')}
      onClick={toggle}
      data-tooltip={locked ? 'Camera Lock — Unlock auto-zoom on focus' : 'Camera Lock — Lock camera from auto-zoom on focus'}
      data-tooltip-no-flip
    >
      <LockIcon />
    </button>
  )
}

function FullscreenToggle() {
  const [on, setOn] = useState(true)

  useEffect(() => {
    const saved = localStorage.getItem('toolbar.fullscreen')
    if (saved !== null) {
      const desired = saved === 'true'
      window.api.window.setFullScreen(desired).then(() => setOn(desired))
    } else {
      window.api.window.isFullScreen().then(setOn)
    }
  }, [])

  const toggle = () => {
    const next = !on
    localStorage.setItem('toolbar.fullscreen', String(next))
    window.api.window.setFullScreen(next).then(() => setOn(next))
  }

  return (
    <button
      className={'toolbar__btn' + (on ? ' toolbar__btn--active' : '')}
      onClick={toggle}
      data-tooltip={on ? 'Fullscreen — Exit fullscreen' : 'Fullscreen — Enter fullscreen'}
      data-tooltip-no-flip
    >
      <FullscreenIcon />
    </button>
  )
}

function AudioTapToggle() {
  const [on, setOn] = useState(() => localStorage.getItem('toolbar.audioTap') !== 'false')

  useEffect(() => {
    if (on) window.api.audio.start().catch(() => {})
  }, [])

  const toggle = () => {
    const next = !on
    localStorage.setItem('toolbar.audioTap', String(next))
    ;(next ? window.api.audio.start() : window.api.audio.stop()).then(() => setOn(next))
  }

  return (
    <button
      className={'toolbar__btn' + (on ? ' toolbar__btn--active' : '')}
      onClick={toggle}
      data-tooltip={on ? 'Audio Tap — Stop audio tap' : 'Audio Tap — Start audio tap'}
      data-tooltip-no-flip
    >
      ♪
    </button>
  )
}

function ProportionalFontToggle() {
  const proportional = useFontStore(s => s.proportional)
  const toggle = useFontStore(s => s.toggle)
  const themeId = useFontStore(s => s.themeId)
  const setThemeId = useFontStore(s => s.setThemeId)
  const [open, setOpen] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)

  // Close dropdown on outside click
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  return (
    <div className="toolbar__font-group" ref={dropdownRef}>
      <button
        className={'toolbar__btn' + (proportional ? ' toolbar__btn--active' : '')}
        onClick={toggle}
        data-tooltip={proportional ? 'Proportional — Switch to monospace font' : 'Proportional — Switch to proportional font'}
        data-tooltip-no-flip
      >
        Aa
      </button>
      <button
        className={'toolbar__font-dropdown-btn' + (open ? ' toolbar__font-dropdown-btn--open' : '')}
        onClick={() => setOpen(o => !o)}
        data-tooltip="Font theme"
        data-tooltip-no-flip
      >
        ▾
      </button>
      {open && (
        <div className="toolbar__font-menu">
          {FONT_THEMES.map(t => (
            <button
              key={t.id}
              className={'toolbar__font-menu-item' + (t.id === themeId ? ' toolbar__font-menu-item--active' : '')}
              onClick={() => {
                setThemeId(t.id)
                if (!proportional) toggle()
                setOpen(false)
              }}
            >
              <span className="toolbar__font-menu-label">{t.label}</span>
              <span className="toolbar__font-menu-preview" style={{ fontFamily: t.fontFamily, fontSize: t.fontSize, fontWeight: t.fontWeight }}>
                Abc 123
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function CrabGroup({ crabs, onCrabClick, onCrabReorder, selectedNodeId, crabNavEvent }: { crabs: CrabEntry[]; onCrabClick: (nodeId: string, metaKey: boolean) => void; onCrabReorder: (order: string[]) => void; selectedNodeId: string | null; crabNavEvent: CrabNavEvent }) {
  const hoveredNodeId = useHoveredCardStore(s => s.hoveredNodeId)
  const containerRef = useRef<HTMLDivElement>(null)
  const prevCrabsRef = useRef<CrabEntry[]>([])
  const positionsRef = useRef<Map<string, number>>(new Map())
  const isFirstRenderRef = useRef(true)
  const isDraggingRef = useRef(false)
  const triangleRef = useRef<HTMLDivElement>(null)
  const navAnimRef = useRef<{ cancel: () => void } | null>(null)

  // Capture positions before paint, animate enter/exit/reorder.
  // Positions are stored as distance from the slot's left edge to the
  // container's right edge (offsetWidth - offsetLeft). The container's right
  // edge is viewport-anchored (toolbar is full-width, crabs are the rightmost
  // flex item), so this metric is stable: a crab that hasn't moved within the
  // group keeps the same value even when siblings are added/removed.
  //
  // IMPORTANT: We use offsetLeft/offsetWidth (layout positions) instead of
  // getBoundingClientRect() because the latter includes transforms from
  // in-progress Web Animations, which creates a feedback loop: animations
  // pollute measurements → bogus deltas → more animations.
  useLayoutEffect(() => {
    const el = containerRef.current
    if (!el) return

    const prevCrabs = prevCrabsRef.current
    const oldPositions = positionsRef.current
    const newPositions = new Map<string, number>()

    const slots = el.querySelectorAll<HTMLElement>('.toolbar__crab-slot')
    const containerWidth = el.offsetWidth
    for (const slot of slots) {
      const nodeId = slot.dataset.nodeId
      if (nodeId) {
        newPositions.set(nodeId, containerWidth - slot.offsetLeft)
      }
    }

    if (isFirstRenderRef.current) {
      isFirstRenderRef.current = false
      positionsRef.current = newPositions
      prevCrabsRef.current = crabs
      return
    }

    const prevIds = new Set(prevCrabs.map(c => c.nodeId))
    const currIds = new Set(crabs.map(c => c.nodeId))

    // Exits — crabs in prev but not current
    for (const prev of prevCrabs) {
      if (!currIds.has(prev.nodeId)) {
        const oldRightOffset = oldPositions.get(prev.nodeId)
        if (oldRightOffset == null) continue

        // Convert right-relative offset to left position within current container
        const phantomLeft = containerWidth - oldRightOffset
        const phantom = document.createElement('button')
        phantom.className = `toolbar__crab toolbar__crab--${prev.color}`
        const maskUrl = prev.kind === 'terminal' ? terminalIcon : crabIcon
        phantom.style.cssText = `position:absolute;top:0;left:${phantomLeft}px;pointer-events:none;width:20px;height:20px;border:none;padding:0;-webkit-mask-image:url(${maskUrl});mask-image:url(${maskUrl});-webkit-mask-size:contain;mask-size:contain;-webkit-mask-repeat:no-repeat;mask-repeat:no-repeat;-webkit-mask-position:center;mask-position:center;`
        el.appendChild(phantom)

        const anim = phantom.animate(
          [
            { transform: 'translateY(0)', opacity: 1 },
            { transform: 'translateY(40px)', opacity: 0 },
          ],
          { duration: 250, easing: 'cubic-bezier(0.4, 0, 1, 1)', fill: 'forwards' }
        )
        anim.onfinish = () => phantom.remove()
      }
    }

    // Enters — crabs in current but not prev
    for (const slot of slots) {
      const nodeId = slot.dataset.nodeId
      if (nodeId && !prevIds.has(nodeId)) {
        slot.animate(
          [
            { transform: 'translateY(-40px)', opacity: 0 },
            { transform: 'translateY(0)', opacity: 1 },
          ],
          { duration: 280, easing: 'cubic-bezier(0.4, 0, 1, 1)' }
        )
      }
    }

    // FLIP reorder — crabs present in both.
    // Skip when a drag just caused the reorder — siblings were already visually
    // shifted during drag, so the FLIP animation would fight with those transforms.
    if (!isDraggingRef.current) {
      // delta = newRightOffset - oldRightOffset: positive means the crab moved
      // further from the right edge (leftward), so we start shifted right.
      for (const slot of slots) {
        const nodeId = slot.dataset.nodeId
        if (nodeId && prevIds.has(nodeId) && currIds.has(nodeId)) {
          const oldRightOffset = oldPositions.get(nodeId)
          const newRightOffset = newPositions.get(nodeId)
          if (oldRightOffset != null && newRightOffset != null) {
            const delta = newRightOffset - oldRightOffset
            if (Math.abs(delta) > 1) {
              slot.animate(
                [
                  { transform: `translateX(${delta}px)` },
                  { transform: 'translateX(0)' },
                ],
                { duration: 300, easing: 'cubic-bezier(0.4, 0, 0.2, 1)' }
              )
            }
          }
        }
      }
    }

    positionsRef.current = newPositions
    prevCrabsRef.current = crabs
  }, [crabs])

  // Beat-synced glow/bounce/rock animation loop
  useEffect(() => {
    let rafId = 0
    const dance = new CrabDance()
    let logCounter = 0

    const tick = () => {
      rafId = requestAnimationFrame(tick)
      const el = containerRef.current
      if (!el) return

      const { glowPulse, rock, bounce } = dance.tick()
      const glowRadius = 2 + 4 * glowPulse

      // Target inner crab buttons, skipping exit phantoms
      const crabButtons = el.querySelectorAll<HTMLElement>('.toolbar__crab-slot .toolbar__crab')
      for (const child of crabButtons) {
        child.style.filter = `drop-shadow(0 0 ${glowRadius}px currentColor)`
        if (child.classList.contains('toolbar__crab--attention')) {
          child.style.translate = `0 ${-bounce}px`
          child.style.rotate = `${rock}deg`
        } else {
          child.style.translate = ''
          child.style.rotate = ''
        }
      }

      logCounter++
      if (logCounter % 120 === 0) {
        window.api.log(`[crab-dance] rock=${rock.toFixed(1)} bounce=${bounce.toFixed(1)}`)
      }
    }

    rafId = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafId)
  }, [])

  const handleCrabMouseDown = (e: React.MouseEvent, crabIndex: number) => {
    if (e.button !== 0) return
    e.preventDefault()

    const container = containerRef.current
    if (!container) return

    const startX = e.clientX
    const metaKey = e.metaKey
    const nodeId = crabs[crabIndex].nodeId
    let dragging = false

    // Measure slot positions using layout (not getBoundingClientRect, which includes transforms)
    const slots = container.querySelectorAll<HTMLElement>('.toolbar__crab-slot')
    const slotCenters: number[] = []
    const containerRect = container.getBoundingClientRect()
    for (const slot of slots) {
      slotCenters.push(containerRect.left + slot.offsetLeft + slot.offsetWidth / 2)
    }

    const draggedSlot = slots[crabIndex]

    // Measure slot stride for sibling shifting
    const slotStride = slotCenters.length > 1
      ? slotCenters[1] - slotCenters[0]
      : 26

    let prevTargetIndex = crabIndex

    const computeTargetIndex = (dx: number) => {
      const draggedCenter = slotCenters[crabIndex] + dx
      let idx = 0
      for (let i = 0; i < slotCenters.length; i++) {
        if (slotCenters[i] < draggedCenter) idx = i + 1
      }
      if (idx > crabIndex) idx--
      return Math.max(0, Math.min(idx, crabs.length - 1))
    }

    const shiftSiblings = (targetIndex: number) => {
      for (let i = 0; i < slots.length; i++) {
        if (i === crabIndex) continue
        let shift = 0
        if (targetIndex < crabIndex && i >= targetIndex && i < crabIndex) {
          shift = slotStride
        } else if (targetIndex > crabIndex && i > crabIndex && i <= targetIndex) {
          shift = -slotStride
        }
        slots[i].style.transform = shift ? `translateX(${shift}px)` : ''
      }
    }

    const onMouseMove = (ev: MouseEvent) => {
      const dx = ev.clientX - startX
      if (!dragging && Math.abs(dx) < 5) return

      if (!dragging) {
        dragging = true
        isDraggingRef.current = true
        useHoveredCardStore.getState().setToolbarHoveredNode(null)
        draggedSlot.classList.add('toolbar__crab-slot--dragging')
        for (let i = 0; i < slots.length; i++) {
          if (i !== crabIndex) slots[i].classList.add('toolbar__crab-slot--shifting')
        }
      }

      draggedSlot.style.transform = `translateX(${dx}px)`

      const targetIndex = computeTargetIndex(dx)
      if (targetIndex !== prevTargetIndex) {
        prevTargetIndex = targetIndex
        shiftSiblings(targetIndex)
      }
    }

    const onMouseUp = (ev: MouseEvent) => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)

      // Clean up all inline transforms and classes from siblings
      for (let i = 0; i < slots.length; i++) {
        if (i !== crabIndex) {
          slots[i].style.transform = ''
          slots[i].classList.remove('toolbar__crab-slot--shifting')
        }
      }
      draggedSlot.style.transform = ''
      draggedSlot.classList.remove('toolbar__crab-slot--dragging')

      if (!dragging) {
        isDraggingRef.current = false
        onCrabClick(nodeId, metaKey)
        return
      }

      // Compute target index from final position
      const dx = ev.clientX - startX
      const targetIndex = computeTargetIndex(dx)

      // Use requestAnimationFrame so the FLIP animation sees the old positions
      // before React re-renders with the new order
      requestAnimationFrame(() => {
        isDraggingRef.current = false
      })

      if (targetIndex !== crabIndex) {
        const order = crabs.map(c => c.nodeId)
        const [removed] = order.splice(crabIndex, 1)
        order.splice(targetIndex, 0, removed)
        onCrabReorder(order)
      } else {
        isDraggingRef.current = false
      }
    }

    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
  }

  // Triangle navigation indicator animation
  useEffect(() => {
    if (!crabNavEvent || !containerRef.current || !triangleRef.current) return

    const container = containerRef.current
    const triangle = triangleRef.current
    const { fromNodeId, toNodeId } = crabNavEvent

    // Cancel any in-progress animation
    if (navAnimRef.current) {
      navAnimRef.current.cancel()
      navAnimRef.current = null
    }

    // Measure destination position
    const toSlot = container.querySelector<HTMLElement>(`.toolbar__crab-slot[data-node-id="${toNodeId}"]`)
    if (!toSlot) return
    const toX = toSlot.offsetLeft + toSlot.offsetWidth / 2

    // Measure start position
    let fromX: number
    if (fromNodeId) {
      const fromSlot = container.querySelector<HTMLElement>(`.toolbar__crab-slot[data-node-id="${fromNodeId}"]`)
      fromX = fromSlot ? fromSlot.offsetLeft + fromSlot.offsetWidth / 2 : toX
    } else {
      fromX = toX
    }

    // Show triangle at starting position
    triangle.style.opacity = '1'
    triangle.style.left = `${fromX}px`
    // Clear any residual fill from previous animations
    triangle.getAnimations().forEach(a => a.cancel())

    const slideDuration = 250
    const fadeDelay = 100
    const fadeDuration = 300
    let cancelled = false
    let fadeTimeout: ReturnType<typeof setTimeout>
    let fadeAnim: Animation | null = null

    const slideAnim = triangle.animate(
      [{ left: `${fromX}px` }, { left: `${toX}px` }],
      { duration: slideDuration, easing: 'cubic-bezier(0.4, 0, 0.2, 1)', fill: 'forwards' }
    )

    slideAnim.onfinish = () => {
      if (cancelled) return
      triangle.style.left = `${toX}px`
      slideAnim.cancel()
      fadeTimeout = setTimeout(() => {
        if (cancelled) return
        fadeAnim = triangle.animate(
          [{ opacity: '1' }, { opacity: '0' }],
          { duration: fadeDuration, fill: 'forwards' }
        )
        fadeAnim.onfinish = () => {
          if (!cancelled) {
            triangle.style.opacity = '0'
            fadeAnim!.cancel()
          }
        }
      }, fadeDelay)
    }

    navAnimRef.current = {
      cancel: () => {
        cancelled = true
        slideAnim.cancel()
        if (fadeAnim) fadeAnim.cancel()
        clearTimeout(fadeTimeout)
      }
    }
  }, [crabNavEvent])

  return (
    <div className="toolbar__crabs" ref={containerRef}>
      {crabs.map((crab, i) => (
          <div key={crab.nodeId} className="toolbar__crab-slot" data-node-id={crab.nodeId}>
            <button
              className={`toolbar__crab toolbar__crab--${crab.color}${crab.unviewed ? ' toolbar__crab--attention' : ''}${crab.nodeId === selectedNodeId ? ' toolbar__crab--selected' : ''}${crab.nodeId === hoveredNodeId ? ' toolbar__crab--card-hovered' : ''}${crab.asleep ? ' toolbar__crab--asleep' : ''}`}
              style={crab.kind === 'terminal'
                ? { WebkitMaskImage: `url(${terminalIcon})`, maskImage: `url(${terminalIcon})` }
                : { WebkitMaskImage: `url(${crabIcon})`, maskImage: `url(${crabIcon})` }
              }
              onMouseDown={(e) => handleCrabMouseDown(e, i)}
              onMouseEnter={() => {
                if (!isDraggingRef.current) {
                  useHoveredCardStore.getState().setToolbarHoveredNode(crab.nodeId)
                }
              }}
              onMouseLeave={() => {
                useHoveredCardStore.getState().setToolbarHoveredNode(null)
              }}
              data-tooltip={crab.title && crab.title.length > 80 ? crab.title.slice(0, 80) + '\u2026' : crab.title}
              data-tooltip-no-flip
            />
          </div>
      ))}
      <div ref={triangleRef} className="toolbar__crab-nav-triangle" />
    </div>
  )
}

function BeatsToggle() {
  const beatsVisible = useAudioStore(s => s.beatsVisible)
  const toggleBeats = useAudioStore(s => s.toggleBeats)
  return (
    <button
      className={'toolbar__btn' + (beatsVisible ? ' toolbar__btn--active' : '')}
      onClick={toggleBeats}
      data-tooltip={beatsVisible ? 'Audio Vis — Hide beat indicator (raw energy → onset detection → phase-locked pulse)' : 'Audio Vis — Show beat indicator (raw energy → onset detection → phase-locked pulse)'}
      data-tooltip-no-flip
    >
      <AudioVisIcon />
    </button>
  )
}

function BellIcon() {
  return (
    <svg viewBox="0 0 16 16" width="1em" height="1em" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" strokeLinecap="round" style={{ display: 'block' }}>
      <path d="M3 6.5a5 5 0 0 1 10 0c0 3 1.5 4.5 1.5 4.5H1.5S3 9.5 3 6.5" />
      <path d="M6 11a2 2 0 0 0 4 0" />
    </svg>
  )
}

function NotificationSoundToggle() {
  const enabled = useNotificationSoundStore(s => s.enabled)
  const toggle = useNotificationSoundStore(s => s.toggle)
  return (
    <button
      className={'toolbar__btn' + (enabled ? ' toolbar__btn--active' : '')}
      onClick={toggle}
      data-tooltip={enabled ? 'Notification Sound — Disable sound on new unread surfaces' : 'Notification Sound — Play sound when surfaces need attention'}
      data-tooltip-no-flip
    >
      <BellIcon />
    </button>
  )
}

function BpmIndicator() {
  const [displayBpm, setDisplayBpm] = useState(0)

  useEffect(() => {
    const id = setInterval(() => {
      setDisplayBpm(useAudioStore.getState().bpm)
    }, 1000)
    setDisplayBpm(useAudioStore.getState().bpm)
    return () => clearInterval(id)
  }, [])

  if (displayBpm <= 0) return null

  return (
    <span className="toolbar__status-item toolbar__metric">
      {Math.round(displayBpm)} <span className="toolbar__metric-label">bpm</span>
    </span>
  )
}

function BeatIndicators() {
  const beatsVisible = useAudioStore(s => s.beatsVisible)
  const energyRef = useRef<HTMLSpanElement>(null)
  const onsetRef = useRef<HTMLSpanElement>(null)
  const phaseRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    let rafId = 0
    // Energy EMA state
    let smoothEnergy = 0
    // Onset decay state
    let onsetLevel = 0
    let lastOnset = false
    // Phase interpolation state
    let localPhase = 0
    let lastBpm = 0
    let lastStorePhase = 0
    let prevTime = performance.now()
    let logCounter = 0

    const tick = () => {
      rafId = requestAnimationFrame(tick)
      const eEl = energyRef.current
      const oEl = onsetRef.current
      const pEl = phaseRef.current
      if (!eEl || !oEl || !pEl) return

      const now = performance.now()
      const dt = now - prevTime
      prevTime = now

      const { phase, bpm, energy, onset, confidence, hasSignal, listening } = useAudioStore.getState()

      // Periodic diagnostic logging
      logCounter++
      if (logCounter % 300 === 0) {
        window.api.log(`[beat-indicators] listening=${listening} hasSignal=${hasSignal} energy=${energy.toFixed(4)} bpm=${bpm} phase=${phase.toFixed(3)} conf=${confidence.toFixed(2)} onset=${onset}`)
      }

      // --- Energy indicator (most raw) ---
      smoothEnergy = smoothEnergy + 0.3 * (energy - smoothEnergy)
      const eNorm = Math.min(1, smoothEnergy / 0.15) // normalize roughly 0..1
      const eScale = 0.5 + 0.9 * eNorm
      const eOpacity = 0.15 + 0.85 * eNorm
      const eGlow = 6 * eNorm
      const eLightness = 25 + 35 * eNorm
      eEl.style.transform = `scale(${eScale})`
      eEl.style.opacity = String(eOpacity)
      eEl.style.background = `hsl(190, 80%, ${eLightness}%)`
      eEl.style.boxShadow = eGlow > 0.5 ? `0 0 ${eGlow}px hsl(190, 80%, ${eLightness}%)` : 'none'
      // tooltip removed — beat indicators don't need tooltips

      // --- Onset indicator (intermediate) ---
      if (onset && !lastOnset) {
        onsetLevel = 1
      }
      lastOnset = onset
      onsetLevel *= 0.92
      const oScale = 0.4 + 1.2 * onsetLevel
      const oOpacity = 0.1 + 0.9 * onsetLevel
      const oGlow = 10 * onsetLevel
      const oLightness = 20 + 45 * onsetLevel
      oEl.style.transform = `scale(${oScale})`
      oEl.style.opacity = String(oOpacity)
      oEl.style.background = `hsl(30, 90%, ${oLightness}%)`
      oEl.style.boxShadow = oGlow > 0.5 ? `0 0 ${oGlow}px hsl(30, 90%, ${oLightness}%)` : 'none'
      // tooltip removed — beat indicators don't need tooltips

      // --- Phase indicator ---
      let pulse: number
      if (bpm > 0) {
        const beatPeriodMs = 60000 / bpm
        if (phase !== lastStorePhase || bpm !== lastBpm) {
          localPhase = phase
          lastStorePhase = phase
          lastBpm = bpm
        } else {
          localPhase += dt / beatPeriodMs
          if (localPhase >= 1) localPhase -= Math.floor(localPhase)
        }
        pulse = 0.5 + 0.5 * Math.cos(2 * Math.PI * localPhase)
      } else {
        // No BPM estimate: gentle sine oscillation at ~0.67Hz
        pulse = 0.5 + 0.5 * Math.sin(2 * Math.PI * now / 1500)
      }

      const scale = 0.6 + pulse * 0.9 * Math.max(0.3, confidence)
      const baseOpacity = energy > 0.005 ? 0.4 : 0.15
      const opacity = baseOpacity + pulse * 0.6 * Math.max(0.2, confidence)
      const glowRadius = 2 + pulse * 8 * confidence
      const glowAlpha = 0.2 + pulse * 0.8 * confidence
      const hue = Math.round(confidence * 120)

      pEl.style.transform = `scale(${scale})`
      pEl.style.opacity = String(opacity)
      pEl.style.background = `hsl(${hue}, 80%, 50%)`
      pEl.style.boxShadow = `0 0 ${glowRadius}px hsla(${hue}, 80%, 50%, ${glowAlpha})`
    }

    rafId = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafId)
  }, [])

  if (!beatsVisible) return null

  return (
    <span className="toolbar__beats">
      <span ref={energyRef} className="toolbar__beat toolbar__beat--energy" />
      <span ref={onsetRef} className="toolbar__beat toolbar__beat--onset" />
      <span ref={phaseRef} className="toolbar__beat" />
    </span>
  )
}

function formatResetTime(label: string, isoString: string): string | null {
  try {
    const d = new Date(isoString)
    if (isNaN(d.getTime())) return null
    // Round to nearest hour
    if (d.getMinutes() >= 30) d.setHours(d.getHours() + 1)
    d.setMinutes(0, 0, 0)
    const hour = d.toLocaleTimeString(undefined, { hour: 'numeric' })
    const now = new Date()
    const diffDays = Math.round((d.getTime() - now.getTime()) / 86_400_000)
    if (diffDays <= 0) return `${label} resets at ${hour}`
    const dateStr = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    return `${label} resets ${dateStr} at ${hour}`
  } catch {
    return null
  }
}

function formatCredits(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`
}

// --- Delta sparkline (reusable for any minute-keyed monotonic history) ---

const SPARKLINE_W = 80
const SPARKLINE_H = 20
const SPARKLINE_PAD = 2

interface DeltaSparklineProps {
  history: (number | null)[]
  color: string          // e.g. '#4ade80'
  formatPeak: (value: number) => string  // formats the peak delta for tooltip
}

function DeltaSparkline({ history, color, formatPeak }: DeltaSparklineProps) {
  // Build one delta per history slot: zero for gaps, real delta for consecutive non-null pairs
  const allDeltas: number[] = []
  for (let i = 1; i < history.length; i++) {
    const prev = history[i - 1]
    const cur = history[i]
    allDeltas.push(prev != null && cur != null ? cur - prev : 0)
  }

  // Only show if there's at least one non-zero delta
  if (!allDeltas.some(d => d !== 0)) return null

  const maxD = Math.max(...allDeltas)
  const peakIdx = allDeltas.indexOf(maxD)
  const range = maxD || 1
  const bottomY = SPARKLINE_H - SPARKLINE_PAD

  const points = allDeltas.map((d, i) => ({
    x: SPARKLINE_PAD + (i / (allDeltas.length - 1)) * (SPARKLINE_W - 2 * SPARKLINE_PAD),
    y: SPARKLINE_PAD + (1 - d / range) * (SPARKLINE_H - 2 * SPARKLINE_PAD),
  }))

  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ')
  const area = line + ` L ${points[points.length - 1].x} ${bottomY} L ${points[0].x} ${bottomY} Z`
  const minutesAgo = allDeltas.length - 1 - peakIdx
  const peakTime = new Date(Date.now() - minutesAgo * 60_000)
  const timeStr = peakTime.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }).toLowerCase()
  const peakTooltip = `Recent peak: ${formatPeak(maxD)} / min @ ${timeStr}`

  // Derive fill with 50% opacity from the stroke color
  const fillColor = color.startsWith('#')
    ? `${color}80`   // hex + 50% alpha
    : color.replace('rgb(', 'rgba(').replace(')', ', 0.5)')

  return (
    <svg
      width={SPARKLINE_W}
      height={SPARKLINE_H}
      viewBox={`0 0 ${SPARKLINE_W} ${SPARKLINE_H}`}
      data-tooltip={peakTooltip}
      style={{
        position: 'absolute',
        bottom: '100%',
        left: '50%',
        transform: 'translateX(-50%)',
        marginBottom: 2,
      }}
    >
      <path d={area} fill={fillColor} />
      <path
        d={line}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity={0.8}
      />
    </svg>
  )
}

const ONE_HOUR_MS = 60 * 60 * 1000
const FIVE_HOUR_MS = 5 * 60 * 60 * 1000
const SEVEN_DAY_MS = 7 * 24 * 60 * 60 * 1000
/** Minimum elapsed time before showing a projection (avoids wild swings early). */
const PROJECTION_MIN_ELAPSED_MS = 10 * 60 * 1000

/** Project current utilization to end-of-window, or null if not enough
 *  data (too early in the window, zero usage, or window already expired). */
function projectUsage(utilization: number, resetsAt: string, windowMs: number): number | null {
  try {
    const resetMs = new Date(resetsAt).getTime()
    if (isNaN(resetMs)) return null
    const now = Date.now()
    const remainingMs = resetMs - now
    if (remainingMs <= 0) return null                   // window expired
    const elapsedMs = windowMs - remainingMs
    if (elapsedMs < PROJECTION_MIN_ELAPSED_MS) return null // too early
    if (utilization <= 0) return null                    // nothing to project
    return utilization * (windowMs / elapsedMs)
  } catch {
    return null
  }
}

/** Color for a utilization indicator.
 *  0–50%: white, 50–75%: white→yellow, 75–99%: yellow→orange, 100%: red */
function utilizationColor(pct: number): string {
  if (pct >= 100) return '#ff3b30'
  if (pct <= 50) return '#ffffff'
  if (pct <= 75) {
    // white → yellow
    const t = (pct - 50) / 25
    const r = 255
    const g = 255
    const b = Math.round(255 * (1 - t))
    return `rgb(${r},${g},${b})`
  }
  // 75–99: yellow → orange
  const t = (pct - 75) / 24
  const r = 255
  const g = Math.round(255 - 90 * t) // 255 → 165
  return `rgb(${r},${g},0)`
}

function formatDelta(resetAt: string): string {
  const diffMs = new Date(resetAt).getTime() - Date.now()
  if (diffMs <= 0) return 'now'
  const totalMinutes = Math.ceil(diffMs / 60_000)
  if (totalMinutes < 60) return `${totalMinutes}m`
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`
}

function GhRateLimitIndicator() {
  const data = useGhRateLimitStore(s => s.data)
  const usedHistory = useGhRateLimitStore(s => s.usedHistory)
  const [, setTick] = useState(0)

  // Re-render every 30s to keep the countdown fresh
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 30_000)
    return () => clearInterval(id)
  }, [])

  if (!data) return null

  const pct = data.limit > 0 ? (data.used / data.limit) * 100 : 0
  const projectedGh = projectUsage(pct, data.resetAt, ONE_HOUR_MS)

  return (
    <span
      className="toolbar__status-item toolbar__metric"
      style={{ position: 'relative' }}
      data-tooltip={`GitHub GraphQL rate limit \u2022 resets in ${formatDelta(data.resetAt)}`}
      data-tooltip-no-flip
    >
      <DeltaSparkline history={usedHistory} color="#60a5fa" formatPeak={(v) => `${v} req`} />
      <span className="toolbar__metric-label">GH </span>
      <span style={{ color: utilizationColor(pct) }}>{Math.round(pct)}<span className="toolbar__metric-label">%</span></span>
      {projectedGh != null && (
        <span style={{ color: '#888' }} data-tooltip="GitHub rate limit linear extrapolation">
          {' '}({Math.round(projectedGh)}<span className="toolbar__metric-label">%</span>)
        </span>
      )}
    </span>
  )
}

function UsageIndicators() {
  const usage = useUsageStore(s => s.usage)
  const subscriptionType = useUsageStore(s => s.subscriptionType)
  const creditHistory = useUsageStore(s => s.creditHistory)
  const fiveHourHistory = useUsageStore(s => s.fiveHourHistory)
  const sevenDayHistory = useUsageStore(s => s.sevenDayHistory)
  const prevCreditsRef = useRef<number | null>(null)
  const extraRef = useRef<HTMLSpanElement>(null)

  const credits = usage?.extra_usage?.used_credits ?? null

  // Floating combat text on credit increase
  useEffect(() => {
    const prev = prevCreditsRef.current
    prevCreditsRef.current = credits
    if (prev == null || credits == null || credits <= prev) return

    const container = extraRef.current
    if (!container) return

    const diff = credits - prev
    const el = document.createElement('span')
    el.textContent = `+$${(diff / 100).toFixed(2)}`
    el.style.cssText = 'position:absolute;left:50%;bottom:100%;pointer-events:none;font-size:28px;font-weight:700;color:#4ade80;white-space:nowrap;text-shadow:0 0 8px rgba(74,222,128,0.6);'
    container.appendChild(el)
    const anim = el.animate(
      [
        { transform: 'translate(-50%, 0)', opacity: 1, offset: 0 },
        { transform: 'translate(-50%, -24px)', opacity: 1, offset: 0.35 },
        { transform: 'translate(-50%, -54px)', opacity: 0, offset: 1 },
      ],
      { duration: 2800, easing: 'ease-out', fill: 'forwards' }
    )
    anim.onfinish = () => el.remove()
  }, [credits])

  if (!usage || !subscriptionType) return null

  const fiveHour = usage.five_hour
  const sevenDay = usage.seven_day
  const extra = usage.extra_usage
  const projected5h = fiveHour != null && typeof fiveHour.utilization === 'number'
    ? projectUsage(fiveHour.utilization, fiveHour.resets_at, FIVE_HOUR_MS)
    : null
  const projected7d = sevenDay != null && typeof sevenDay.utilization === 'number'
    ? projectUsage(sevenDay.utilization, sevenDay.resets_at, SEVEN_DAY_MS)
    : null

  return (
    <span className="toolbar__usage">
      <span className="toolbar__usage-tag">{subscriptionType}</span>
      {fiveHour != null && typeof fiveHour.utilization === 'number' && (
        <span
          className="toolbar__status-item toolbar__metric"
          style={{ position: 'relative' }}
          data-tooltip={formatResetTime('5-hour usage', fiveHour.resets_at) ?? undefined}
          data-tooltip-no-flip
        >
          <DeltaSparkline history={fiveHourHistory} color={utilizationColor(fiveHour.utilization)} formatPeak={(v) => `${v}%pts`} />
          <span className="toolbar__metric-label">5h </span>
          <span style={{ color: utilizationColor(fiveHour.utilization) }}>{Math.round(fiveHour.utilization)}<span className="toolbar__metric-label">%</span></span>
          {projected5h != null && (
            <span style={{ color: '#888' }} data-tooltip="5-hour usage linear extrapolation">
              {' '}({Math.round(projected5h)}<span className="toolbar__metric-label">%</span>)
            </span>
          )}
        </span>
      )}
      {sevenDay != null && typeof sevenDay.utilization === 'number' && (
        <span
          className="toolbar__status-item toolbar__metric"
          style={{ position: 'relative' }}
          data-tooltip={formatResetTime('7-day usage', sevenDay.resets_at) ?? undefined}
          data-tooltip-no-flip
        >
          <DeltaSparkline history={sevenDayHistory} color={utilizationColor(sevenDay.utilization)} formatPeak={(v) => `${v}%pts`} />
          <span className="toolbar__metric-label">7d </span>
          <span style={{ color: utilizationColor(sevenDay.utilization) }}>{Math.round(sevenDay.utilization)}<span className="toolbar__metric-label">%</span></span>
          {projected7d != null && (
            <span style={{ color: '#888' }} data-tooltip="7-day usage linear extrapolation">
              {' '}({Math.round(projected7d)}<span className="toolbar__metric-label">%</span>)
            </span>
          )}
        </span>
      )}
      {extra != null && typeof extra.used_credits === 'number' && (
        <span
          ref={extraRef}
          className="toolbar__status-item toolbar__metric"
          style={{ position: 'relative' }}
          data-tooltip={extra.monthly_limit != null ? `Limit: ${formatCredits(extra.monthly_limit)}` : 'Limit: unlimited'}
          data-tooltip-no-flip
        >
          <DeltaSparkline history={creditHistory} color="#4ade80" formatPeak={formatCredits} />
          {formatCredits(extra.used_credits)}
        </span>
      )}
    </span>
  )
}

