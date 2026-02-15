import { useEffect, useRef, useState } from 'react'
import { COLOR_PRESETS } from '../lib/color-presets'
import type { ColorPreset } from '../lib/color-presets'

interface NodeTitleBarSharedControlsProps {
  id: string
  preset?: ColorPreset
  onClose: (id: string) => void
  onColorChange: (id: string, color: string) => void
}

export function NodeTitleBarSharedControls({ id, preset, onClose, onColorChange }: NodeTitleBarSharedControlsProps) {
  const [pickerOpen, setPickerOpen] = useState(false)
  const pickerRef = useRef<HTMLDivElement>(null)

  // Close color picker on outside click
  useEffect(() => {
    if (!pickerOpen) return
    const handleClick = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setPickerOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [pickerOpen])

  return (
    <div className="node-titlebar__actions">
      <div style={{ position: 'relative' }} ref={pickerRef}>
        <button
          className="node-titlebar__color-btn"
          title="Header color"
          style={preset ? { color: preset.titleBarFg } : undefined}
          onClick={(e) => {
            e.stopPropagation()
            setPickerOpen((prev) => !prev)
          }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          &#9679;
        </button>
        {pickerOpen && (
          <div className="node-titlebar__color-picker" onMouseDown={(e) => e.stopPropagation()}>
            {COLOR_PRESETS.map((p) => (
              <button
                key={p.id}
                className="node-titlebar__color-swatch"
                style={{ backgroundColor: p.titleBarBg }}
                onClick={(e) => {
                  e.stopPropagation()
                  onColorChange(id, p.id)
                  setPickerOpen(false)
                }}
              />
            ))}
          </div>
        )}
      </div>
      <button
        className="node-titlebar__close"
        style={preset ? { color: preset.titleBarFg } : undefined}
        onClick={(e) => { e.stopPropagation(); onClose(id) }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        &times;
      </button>
    </div>
  )
}
