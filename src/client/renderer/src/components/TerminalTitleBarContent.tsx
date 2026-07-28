import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ColorPreset } from '../lib/color-presets'
import { blendHex } from '../lib/color-presets'
import { terminalSubtitle } from '../lib/node-title'
interface TerminalTitleBarContentProps {
  name: string | undefined
  shellTitleHistory: string[] | undefined
  preset: ColorPreset | undefined
  id: string
  isClaudeSurface: boolean
  onRename: (id: string, name: string) => void
  canStartEdit?: () => boolean
}

export function TerminalTitleBarContent({
  name, shellTitleHistory, preset, id, isClaudeSurface, onRename, canStartEdit
}: TerminalTitleBarContentProps) {
  const [editing, setEditing] = useState(false)
  const [editValue, setEditValue] = useState('')
  const [inputWidth, setInputWidth] = useState<number | undefined>(undefined)
  const inputRef = useRef<HTMLInputElement>(null)
  const sizerRef = useRef<HTMLSpanElement>(null)

  // Select-all on edit start
  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.select()
    }
  }, [editing])

  // Auto-size input to match text width (layoutEffect to avoid flicker)
  useLayoutEffect(() => {
    if (editing && sizerRef.current) {
      setInputWidth(sizerRef.current.scrollWidth)
    }
  }, [editing, editValue])

  const history = terminalSubtitle(shellTitleHistory ?? [])

  const typeIconColor = preset ? preset.terminalBg : '#6c7086'

  return (
    <>
      {!isClaudeSurface && (
        <span className="terminal-card__type-icon terminal-card__type-icon--terminal" style={{ color: typeIconColor }}>&gt;_</span>
      )}
      <div
        className="terminal-card__left-area"
        onClick={(e) => {
          if (canStartEdit && !canStartEdit()) return
          e.stopPropagation()
          setEditValue(name || '')
          setEditing(true)
        }}
      >
        {editing ? (
          <>
            <span ref={sizerRef} className="terminal-card__title-sizer">{editValue || ' '}</span>
            <input
              ref={inputRef}
              className="terminal-card__title-input"
              value={editValue}
              style={preset ? { width: inputWidth, color: preset.titleBarFg } : { width: inputWidth }}
              onChange={(e) => setEditValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  onRename(id, editValue)
                  setEditing(false)
                } else if (e.key === 'Escape') {
                  setEditing(false)
                }
                e.stopPropagation()
              }}
              onBlur={() => {
                onRename(id, editValue)
                setEditing(false)
              }}
              autoFocus
            />
            {history && <span className="terminal-card__separator" style={preset ? { color: blendHex(preset.titleBarFg, preset.titleBarBg, 0.7) } : undefined}>{'\u00A0\u21BC\u00A0'}</span>}
            {history && <span className="terminal-card__history" style={preset ? { color: blendHex(preset.titleBarFg, preset.titleBarBg, 0.75) } : undefined}>{history}</span>}
          </>
        ) : (
          <>
            {name && <span className="terminal-card__custom-name" style={preset ? { color: preset.titleBarFg } : undefined}>{name}</span>}
            {name && history && <span className="terminal-card__separator" style={preset ? { color: blendHex(preset.titleBarFg, preset.titleBarBg, 0.7) } : undefined}>{'\u00A0\u21BC\u00A0'}</span>}
            {history && <span className="terminal-card__history" style={preset ? { color: blendHex(preset.titleBarFg, preset.titleBarBg, 0.75) } : undefined}>{history}</span>}
            {!name && !history && <span className="terminal-card__placeholder" style={preset ? { color: preset.titleBarFg } : undefined}>Untitled</span>}
          </>
        )}
      </div>
    </>
  )
}
