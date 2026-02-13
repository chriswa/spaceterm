import type { InputDevice } from '../hooks/useCamera'

interface ToolbarProps {
  zoom: number
  inputDevice: InputDevice
  onAddTerminal: () => void
  onResetView: () => void
}

export function Toolbar({ zoom, inputDevice, onAddTerminal, onResetView }: ToolbarProps) {
  return (
    <div className="toolbar">
      <button className="toolbar__btn" onClick={onAddTerminal}>
        + New Terminal
      </button>
      <button className="toolbar__btn" onClick={onResetView}>
        Reset View
      </button>
      <span className="toolbar__zoom">{Math.round(zoom * 100)}% | {inputDevice}</span>
    </div>
  )
}
