interface ToolbarProps {
  zoom: number
  onAddTerminal: () => void
  onResetView: () => void
}

export function Toolbar({ zoom, onAddTerminal, onResetView }: ToolbarProps) {
  return (
    <div className="toolbar">
      <button className="toolbar__btn" onClick={onAddTerminal}>
        + New Terminal
      </button>
      <button className="toolbar__btn" onClick={onResetView}>
        Reset View
      </button>
      <span className="toolbar__zoom">{Math.round(zoom * 100)}%</span>
    </div>
  )
}
