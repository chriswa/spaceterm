import type { InputDevice } from '../hooks/useCamera'
import { useFps } from '../hooks/useFps'
import { usePerfStore } from '../stores/perfStore'
import { useShaderStore } from '../stores/shaderStore'
import { useEdgesStore } from '../stores/edgesStore'
import { useAudioStore } from '../stores/audioStore'
import crabIcon from '../assets/crab.png'

interface CrabEntry { nodeId: string; color: 'white' | 'red' | 'purple' | 'orange'; addedAt: number }

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
      <span className="toolbar__zoom">
        <BeatIndicator />
        <span className="toolbar__status-sep" />
        <span className="toolbar__status-item">{fps} fps</span>
        <span className="toolbar__status-sep" />
        <button className="toolbar__status-btn" onClick={onToggleInputDevice}>{inputDevice}</button>
      </span>
      {crabs.length > 0 && (
        <div className="toolbar__crabs">
          {crabs.map(crab => (
            <button
              key={crab.nodeId}
              className={`toolbar__crab toolbar__crab--${crab.color}`}
              style={{ WebkitMaskImage: `url(${crabIcon})`, maskImage: `url(${crabIcon})` }}
              onClick={() => onCrabClick(crab.nodeId)}
              title={crab.color === 'orange' ? 'Working' : crab.color === 'white' ? 'Stopped' : crab.color === 'red' ? 'Permission' : 'Plan'}
            />
          ))}
        </div>
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
      title={plpEnabled ? 'Using PLP beat detection' : 'Using standard beat detection'}
    >
      PLP
    </button>
  )
}

function BeatIndicator() {
  const phase = useAudioStore(s => s.phase)
  const bpm = useAudioStore(s => s.bpm)
  const energy = useAudioStore(s => s.energy)
  const confidence = useAudioStore(s => s.confidence)
  const hasSignal = useAudioStore(s => s.hasSignal)
  const listening = useAudioStore(s => s.listening)

  // No signal state: show red dot
  if (listening && !hasSignal) {
    return (
      <span
        className="toolbar__beat toolbar__beat--no-signal"
        title="No audio signal (check permissions)"
      />
    )
  }

  // Phase-driven pulse: strongest at phase=0 (on beat), fades to next beat
  const pulse = Math.exp(-4 * phase)

  // Scale: 0.6 at rest, up to 1.5 on beat (scaled by confidence)
  const scale = 0.6 + pulse * 0.9 * Math.max(0.3, confidence)

  // Opacity: dim when no audio, bright on beats
  const baseOpacity = energy > 0.005 ? 0.4 : 0.15
  const opacity = baseOpacity + pulse * 0.6 * Math.max(0.2, confidence)

  // Glow intensity
  const glowRadius = 2 + pulse * 8 * confidence
  const glowAlpha = 0.2 + pulse * 0.8 * confidence

  // Color: hue gradient from red (0°) through yellow/orange to green (120°)
  // confidence 0 → red, 0.5 → yellow, 1.0 → green
  const hue = Math.round(confidence * 120)
  const sat = 80
  const light = 50

  return (
    <span
      className="toolbar__beat"
      style={{
        transform: `scale(${scale})`,
        opacity,
        background: `hsl(${hue}, ${sat}%, ${light}%)`,
        boxShadow: `0 0 ${glowRadius}px hsla(${hue}, ${sat}%, ${light}%, ${glowAlpha})`
      }}
      title={bpm > 0 ? `${bpm} BPM (${Math.round(confidence * 100)}%)` : 'Listening...'}
    />
  )
}
