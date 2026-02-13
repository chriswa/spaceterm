import type { InputDevice } from '../hooks/useCamera'

interface ToolbarProps {
  zoom: number
  cameraX: number
  cameraY: number
  inputDevice: InputDevice
  onAddTerminal: () => void
  onResetView: () => void
  onFitAll: () => void
  onToggleInputDevice: () => void
}

export function Toolbar({ zoom, cameraX, cameraY, inputDevice, onAddTerminal, onResetView, onFitAll, onToggleInputDevice }: ToolbarProps) {
  return (
    <div className="toolbar">
      <button className="toolbar__btn" onClick={onAddTerminal}>
        + New Terminal
      </button>
      <button className="toolbar__btn" onClick={onResetView}>
        Reset View
      </button>
      <span className="toolbar__zoom">
        <button className="toolbar__status-btn" onClick={onFitAll}>{Math.round(zoom * 100)}%</button>
        <span> | </span>
        x:{Math.round(cameraX)} y:{Math.round(cameraY)}
        <span> | </span>
        <button className="toolbar__status-btn" onClick={onToggleInputDevice}>{inputDevice}</button>
      </span>
    </div>
  )
}
