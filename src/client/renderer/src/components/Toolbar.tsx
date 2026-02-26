import { useRef, useEffect, useLayoutEffect, useState } from 'react'
import type { InputDevice } from '../hooks/useCamera'
import { useFps } from '../hooks/useFps'
import { usePerfStore } from '../stores/perfStore'
import { useAudioStore } from '../stores/audioStore'
import crabIcon from '../assets/crab.png'
import terminalIcon from '../assets/terminal.png'
import type { CrabEntry } from '../lib/crab-nav'
import { CrabDance } from '../lib/crab-dance'
import { useHoveredCardStore } from '../stores/hoveredCardStore'
import { useUsageStore } from '../stores/usageStore'

export type CrabNavEvent = { fromNodeId: string | null; toNodeId: string; ts: number } | null

interface ToolbarProps {
  inputDevice: InputDevice
  onToggleInputDevice: () => void
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
  inputDevice,
  onToggleInputDevice,
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
        Help
      </button>
      <button
        className={'toolbar__btn' + (keycastEnabled ? ' toolbar__btn--active' : '')}
        onClick={onKeycastToggle}
        data-tooltip="Show key presses on screen"
        data-tooltip-no-flip
      >
        Keycast
      </button>
      <div className="toolbar__perf">
        <button
          className={'toolbar__btn' + (tracing ? ' toolbar__btn--recording' : '')}
          onClick={startTrace}
          disabled={tracing}
          data-tooltip="Record 5s Chrome content trace"
          data-tooltip-no-flip
        >
          {tracing ? 'Tracing...' : 'Perf Trace'}
        </button>
      </div>
      <button
        className="toolbar__btn"
        onClick={onDebugCapture}
        data-tooltip="Copy camera/viewport state to clipboard"
        data-tooltip-no-flip
      >
        Camera Debug
      </button>
      <button
        className={'toolbar__btn' + (goodGfx ? ' toolbar__btn--active' : '')}
        onClick={onGoodGfxToggle}
        data-tooltip={goodGfx ? 'Switch to simple background shader' : 'Switch to full background shader'}
        data-tooltip-no-flip
      >
        Good Gfx
      </button>
      <FullscreenToggle />
      <AudioTapToggle />
      <BeatsToggle />
      <BeatIndicators />
      <span className="toolbar__zoom">
        <BpmIndicator />
        <span className="toolbar__status-item toolbar__metric"><span ref={fpsRef}>0</span> <span className="toolbar__metric-label">fps</span></span>
        <span className="toolbar__status-item toolbar__metric">{(zoom * 100).toFixed(2)}<span className="toolbar__metric-label">%</span></span>
        <button className="toolbar__status-btn" onClick={onToggleInputDevice}>{inputDevice}</button>
        <UsageIndicators />
      </span>
      {crabs.length > 0 && (
        <CrabGroup crabs={crabs} onCrabClick={onCrabClick} onCrabReorder={onCrabReorder} selectedNodeId={selectedNodeId} crabNavEvent={crabNavEvent} />
      )}
    </div>
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
      data-tooltip={on ? 'Exit fullscreen' : 'Enter fullscreen'}
      data-tooltip-no-flip
    >
      Fullscreen
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
      data-tooltip={on ? 'Stop audio tap' : 'Start audio tap'}
      data-tooltip-no-flip
    >
      Audio Tap
    </button>
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
      data-tooltip={beatsVisible ? 'Hide beat indicator (raw energy → onset detection → phase-locked pulse)' : 'Show beat indicator (raw energy → onset detection → phase-locked pulse)'}
      data-tooltip-no-flip
    >
      Audio Vis
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

function UsageIndicators() {
  const usage = useUsageStore(s => s.usage)
  const subscriptionType = useUsageStore(s => s.subscriptionType)
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
          data-tooltip={formatResetTime('5-hour usage', fiveHour.resets_at) ?? undefined}
          data-tooltip-no-flip
        >
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
          data-tooltip={formatResetTime('7-day usage', sevenDay.resets_at) ?? undefined}
          data-tooltip-no-flip
        >
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
          {formatCredits(extra.used_credits)}
        </span>
      )}
    </span>
  )
}

