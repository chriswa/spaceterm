import { useRef, useEffect } from 'react'
import type { InputDevice } from '../hooks/useCamera'
import { useFps } from '../hooks/useFps'
import { usePerfStore } from '../stores/perfStore'
import { useShaderStore } from '../stores/shaderStore'
import { useEdgesStore } from '../stores/edgesStore'
import { useAudioStore } from '../stores/audioStore'
import crabIcon from '../assets/crab.png'

interface CrabEntry { nodeId: string; color: 'white' | 'red' | 'purple' | 'orange' | 'gray'; unviewed: boolean; addedAt: number }

interface ToolbarProps {
  inputDevice: InputDevice
  onAddTerminal: () => void
  onResetView: () => void
  onToggleInputDevice: () => void
  forceLayoutPlaying: boolean
  forceLayoutSpeed: number
  onForceLayoutToggle: () => void
  onForceLayoutIncrease: () => void
  onForceLayoutDecrease: () => void
  crabs: CrabEntry[]
  onCrabClick: (nodeId: string) => void
}

export function Toolbar({
  inputDevice,
  onAddTerminal, onResetView, onToggleInputDevice,
  forceLayoutPlaying, forceLayoutSpeed, onForceLayoutToggle, onForceLayoutIncrease, onForceLayoutDecrease,
  crabs, onCrabClick
}: ToolbarProps) {
  const fps = useFps()
  const recording = usePerfStore(s => s.recording)
  const startTrace = usePerfStore(s => s.startTrace)
  const tracing = recording === 'trace'
  const shadersEnabled = useShaderStore(s => s.shadersEnabled)
  const toggleShaders = useShaderStore(s => s.toggle)
  const edgesEnabled = useEdgesStore(s => s.edgesEnabled)
  const toggleEdges = useEdgesStore(s => s.toggle)

  return (
    <div className="toolbar">
      <button className="toolbar__btn" onClick={onAddTerminal}>
        + New Terminal
      </button>
      <button className="toolbar__btn" onClick={onResetView}>
        Reset View
      </button>
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
      <button
        className={'toolbar__btn' + (shadersEnabled ? ' toolbar__btn--active' : '')}
        onClick={toggleShaders}
        title={shadersEnabled ? 'Disable shaders' : 'Enable shaders'}
      >
        Shaders
      </button>
      <button
        className={'toolbar__btn' + (edgesEnabled ? ' toolbar__btn--active' : '')}
        onClick={toggleEdges}
        title={edgesEnabled ? 'Disable edges' : 'Enable edges'}
      >
        Edges
      </button>
      <PlpToggle />
      <BeatsToggle />
      <span className="toolbar__zoom">
        <BeatIndicators />
        <span className="toolbar__status-sep" />
        <span className="toolbar__status-item">{fps} fps</span>
        <span className="toolbar__status-sep" />
        <button className="toolbar__status-btn" onClick={onToggleInputDevice}>{inputDevice}</button>
      </span>
      {crabs.length > 0 && (
        <CrabGroup crabs={crabs} onCrabClick={onCrabClick} />
      )}
    </div>
  )
}

function PlpToggle() {
  const plpEnabled = useAudioStore(s => s.plpEnabled)
  const togglePlp = useAudioStore(s => s.togglePlp)
  return (
    <button
      className={'toolbar__btn' + (plpEnabled ? ' toolbar__btn--active' : '')}
      onClick={togglePlp}
      title={plpEnabled ? 'Using Predominant Local Pulse beat detection' : 'Using standard beat detection'}
    >
      Predominant Local Pulse
    </button>
  )
}

function CrabGroup({ crabs, onCrabClick }: { crabs: CrabEntry[]; onCrabClick: (nodeId: string) => void }) {
  const containerRef = useRef<HTMLDivElement>(null)

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

      const children = el.children
      for (let i = 0; i < children.length; i++) {
        const child = children[i] as HTMLElement
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
        <button
          key={crab.nodeId}
          className={`toolbar__crab toolbar__crab--${crab.color}${crab.unviewed ? ' toolbar__crab--attention' : ''}`}
          style={{ WebkitMaskImage: `url(${crabIcon})`, maskImage: `url(${crabIcon})` }}
          onClick={() => onCrabClick(crab.nodeId)}
          title={{ orange: 'Working', white: 'Stopped', red: 'Permission', purple: 'Plan', gray: 'Session' }[crab.color]}
        />
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

function BeatIndicators() {
  const beatsVisible = useAudioStore(s => s.beatsVisible)
  const hasSignal = useAudioStore(s => s.hasSignal)
  const listening = useAudioStore(s => s.listening)
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

    const tick = () => {
      rafId = requestAnimationFrame(tick)
      const eEl = energyRef.current
      const oEl = onsetRef.current
      const pEl = phaseRef.current
      if (!eEl || !oEl || !pEl) return

      const now = performance.now()
      const dt = now - prevTime
      prevTime = now

      const { phase, bpm, energy, onset, confidence } = useAudioStore.getState()

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

      // --- Phase indicator (existing logic, unchanged) ---
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
        pulse = 0
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
      // Skip pEl.title — can't hover a 12px pulsing dot anyway
    }

    rafId = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafId)
  }, [])

  if (!beatsVisible) return null

  if (listening && !hasSignal) {
    return (
      <span className="toolbar__beats">
        <span className="toolbar__beat toolbar__beat--energy toolbar__beat--no-signal" />
        <span className="toolbar__beat toolbar__beat--onset toolbar__beat--no-signal" />
        <span className="toolbar__beat toolbar__beat--no-signal" />
      </span>
    )
  }

  return (
    <span className="toolbar__beats">
      <span ref={energyRef} className="toolbar__beat toolbar__beat--energy" />
      <span ref={onsetRef} className="toolbar__beat toolbar__beat--onset" />
      <span ref={phaseRef} className="toolbar__beat" />
    </span>
  )
}
