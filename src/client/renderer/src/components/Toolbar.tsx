import { useRef, useEffect, useLayoutEffect, useState } from 'react'
import type { InputDevice } from '../hooks/useCamera'
import { useFps } from '../hooks/useFps'
import { usePerfStore } from '../stores/perfStore'
import { useAudioStore } from '../stores/audioStore'
import crabIcon from '../assets/crab.png'

interface CrabEntry { nodeId: string; color: 'white' | 'red' | 'purple' | 'orange' | 'gray'; unviewed: boolean; createdAt: string; title: string }

interface ToolbarProps {
  inputDevice: InputDevice
  onToggleInputDevice: () => void
  forceLayoutPlaying: boolean
  forceLayoutSpeed: number
  onForceLayoutToggle: () => void
  onForceLayoutIncrease: () => void
  onForceLayoutDecrease: () => void
  crabs: CrabEntry[]
  onCrabClick: (nodeId: string) => void
  selectedNodeId: string | null
}

export function Toolbar({
  inputDevice,
  onToggleInputDevice,
  forceLayoutPlaying, forceLayoutSpeed, onForceLayoutToggle, onForceLayoutIncrease, onForceLayoutDecrease,
  crabs, onCrabClick, selectedNodeId
}: ToolbarProps) {
  const fps = useFps()
  const recording = usePerfStore(s => s.recording)
  const startTrace = usePerfStore(s => s.startTrace)
  const tracing = recording === 'trace'
  return (
    <div className="toolbar">
      <div className="toolbar__force-layout">
        <button className="toolbar__force-btn" onClick={onForceLayoutToggle} title={forceLayoutPlaying ? 'Pause force layout' : 'Play force layout'}>
          {forceLayoutPlaying ? '\u23F8' : '\u25B6'}
        </button>
        <button className="toolbar__force-btn" onClick={onForceLayoutDecrease} title="Decrease speed">
          &minus;
        </button>
        <span className="toolbar__force-speed">{forceLayoutSpeed}</span>
        <button className="toolbar__force-btn" onClick={onForceLayoutIncrease} title="Increase speed">
          +
        </button>
      </div>
      <div className="toolbar__perf">
        <button
          className={'toolbar__btn' + (tracing ? ' toolbar__btn--recording' : '')}
          onClick={startTrace}
          disabled={tracing}
          title="Record 5s Chrome content trace"
        >
          {tracing ? 'Tracing...' : 'Trace'}
        </button>
      </div>
      <FullscreenToggle />
      <KioskToggle />
      <BeatsToggle />
      <span className="toolbar__zoom">
        <BeatIndicators />
        <BpmIndicator />
        <span className="toolbar__status-sep" />
        <span className="toolbar__status-item toolbar__metric">{fps} <span className="toolbar__metric-label">fps</span></span>
        <span className="toolbar__status-sep" />
        <button className="toolbar__status-btn" onClick={onToggleInputDevice}>{inputDevice}</button>
      </span>
      {crabs.length > 0 && (
        <CrabGroup crabs={crabs} onCrabClick={onCrabClick} selectedNodeId={selectedNodeId} />
      )}
    </div>
  )
}

function FullscreenToggle() {
  const [on, setOn] = useState(true)

  useEffect(() => { window.api.window.isFullScreen().then(setOn) }, [])

  const toggle = () => {
    const next = !on
    window.api.window.setFullScreen(next).then(() => setOn(next))
  }

  return (
    <button
      className={'toolbar__btn' + (on ? ' toolbar__btn--active' : '')}
      onClick={toggle}
      title={on ? 'Exit fullscreen' : 'Enter fullscreen'}
    >
      Fullscreen
    </button>
  )
}

function KioskToggle() {
  const [on, setOn] = useState(false)

  useEffect(() => { window.api.window.isKiosk().then(setOn) }, [])

  const toggle = () => {
    const next = !on
    window.api.window.setKiosk(next).then(() => setOn(next))
  }

  return (
    <button
      className={'toolbar__btn' + (on ? ' toolbar__btn--active' : '')}
      onClick={toggle}
      title={on ? 'Exit kiosk mode' : 'Enter kiosk mode'}
    >
      Kiosk
    </button>
  )
}

function CrabGroup({ crabs, onCrabClick, selectedNodeId }: { crabs: CrabEntry[]; onCrabClick: (nodeId: string) => void; selectedNodeId: string | null }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const prevCrabsRef = useRef<CrabEntry[]>([])
  const positionsRef = useRef<Map<string, number>>(new Map())
  const isFirstRenderRef = useRef(true)

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
        phantom.style.cssText = `position:absolute;top:0;left:${phantomLeft}px;pointer-events:none;width:20px;height:20px;border:none;padding:0;-webkit-mask-image:url(${crabIcon});mask-image:url(${crabIcon});-webkit-mask-size:contain;mask-size:contain;-webkit-mask-repeat:no-repeat;mask-repeat:no-repeat;-webkit-mask-position:center;mask-position:center;`
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

    positionsRef.current = newPositions
    prevCrabsRef.current = crabs
  }, [crabs])

  // Beat-synced glow/bounce/rock animation loop
  useEffect(() => {
    let rafId = 0
    // Continuous dance phase: 0→2 over FOUR beats (half-speed), single clock
    // Each real beat = 0.5 of dancePhase. 4 slots of 0.5 each.
    let dancePhase = 0
    let lastBpm = 0
    let lastStorePhase = -1
    let prevTime = performance.now()
    let logCounter = 0

    const tick = () => {
      rafId = requestAnimationFrame(tick)
      const el = containerRef.current
      if (!el) return

      const now = performance.now()
      const dt = now - prevTime
      prevTime = now

      const { phase, bpm } = useAudioStore.getState()

      let glowPulse: number
      let rock = 0
      let bounce = 0

      if (bpm > 0) {
        const beatPeriodMs = 60000 / bpm

        if (phase !== lastStorePhase || bpm !== lastBpm) {
          // Each real beat maps to 0.5 of dancePhase
          // Current slot (0-3): which quarter of the dance cycle
          const slot = Math.floor(dancePhase / 0.5)
          // Our local phase within this slot (0→1 = one real beat)
          const slotPhase = (dancePhase / 0.5) % 1

          if (slotPhase > 0.7 && phase < 0.3) {
            // Beat wrapped — advance to next slot
            const nextSlot = (slot + 1) % 4
            dancePhase = nextSlot * 0.5 + phase * 0.5
          } else if (slotPhase < 0.3 && phase > 0.7) {
            // Rare backward jump
            const prevSlot = (slot + 3) % 4
            dancePhase = prevSlot * 0.5 + phase * 0.5
          } else {
            // Normal correction within current slot
            dancePhase = slot * 0.5 + phase * 0.5
          }

          if (dancePhase >= 2) dancePhase -= 2
          if (dancePhase < 0) dancePhase += 2

          lastStorePhase = phase
          lastBpm = bpm
        } else {
          // Interpolate at half beat rate
          dancePhase += dt / (beatPeriodMs * 2)
          if (dancePhase >= 2) dancePhase -= 2
        }

        // Glow: raised cosine per real beat (2 pulses per dancePhase unit)
        const beatPhase = (dancePhase * 2) % 1
        glowPulse = 0.5 + 0.5 * Math.cos(2 * Math.PI * beatPhase)

        // Rock: squared cosine for more time spent at extremes
        const maxRock = 12 // degrees
        const c = Math.cos(Math.PI * dancePhase)
        rock = maxRock * c * Math.abs(c)

        // Bounce: 2 bounces per dance-half (= 1 bounce per real beat)
        const maxBounce = 3 // px
        bounce = maxBounce * Math.abs(Math.sin(2 * Math.PI * dancePhase))

        // Periodic logging
        logCounter++
        if (logCounter % 120 === 0) {
          window.api.log(`[crab-dance] dancePhase=${dancePhase.toFixed(3)} slot=${Math.floor(dancePhase / 0.5)} storePhase=${phase.toFixed(3)} bpm=${bpm} rock=${rock.toFixed(1)} bounce=${bounce.toFixed(1)}`)
        }
      } else {
        glowPulse = 0.5 + 0.5 * Math.sin(2 * Math.PI * now / 2000)
      }

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
    }

    rafId = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafId)
  }, [])

  return (
    <div className="toolbar__crabs" ref={containerRef}>
      {crabs.map(crab => (
        <div key={crab.nodeId} className="toolbar__crab-slot" data-node-id={crab.nodeId}>
          <button
            className={`toolbar__crab toolbar__crab--${crab.color}${crab.unviewed ? ' toolbar__crab--attention' : ''}${crab.nodeId === selectedNodeId ? ' toolbar__crab--selected' : ''}`}
            style={{ WebkitMaskImage: `url(${crabIcon})`, maskImage: `url(${crabIcon})` }}
            onClick={() => onCrabClick(crab.nodeId)}
            title={crab.title}
          />
        </div>
      ))}
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
      title={beatsVisible ? 'Hide beat indicator (raw energy → onset detection → phase-locked pulse)' : 'Show beat indicator (raw energy → onset detection → phase-locked pulse)'}
    >
      Beats
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
      eEl.title = `Raw energy (RMS): ${energy.toFixed(4)}`

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
      oEl.title = onset ? 'Onset detection: fired!' : `Onset detection: ${onsetLevel.toFixed(2)}`

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
        // No BPM estimate: gentle sine oscillation at ~0.67Hz (matches useBeatPulse fallback)
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
