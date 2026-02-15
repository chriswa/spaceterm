import type { InputDevice } from '../hooks/useCamera'
import { useFps } from '../hooks/useFps'

interface ToolbarProps {
  zoom: number
  cameraX: number
  cameraY: number
  inputDevice: InputDevice
  onAddTerminal: () => void
  onResetView: () => void
  onFitAll: () => void
  onToggleInputDevice: () => void
  forceLayoutPlaying: boolean
  forceLayoutSpeed: number
  onForceLayoutToggle: () => void
  onForceLayoutIncrease: () => void
  onForceLayoutDecrease: () => void
}

export function Toolbar({
  zoom, cameraX, cameraY, inputDevice,
  onAddTerminal, onResetView, onFitAll, onToggleInputDevice,
  forceLayoutPlaying, forceLayoutSpeed, onForceLayoutToggle, onForceLayoutIncrease, onForceLayoutDecrease
}: ToolbarProps) {
  const fps = useFps()
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
      <span className="toolbar__zoom">
        {fps} fps
        <span> | </span>
        <button className="toolbar__status-btn" onClick={onFitAll}>{Math.round(zoom * 100)}%</button>
        <span> | </span>
        x:{Math.round(cameraX)} y:{Math.round(cameraY)}
        <span> | </span>
        <button className="toolbar__status-btn" onClick={onToggleInputDevice}>{inputDevice}</button>
      </span>
    </div>
  )
}
