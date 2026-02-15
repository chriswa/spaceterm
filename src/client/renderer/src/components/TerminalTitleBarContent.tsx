import { useEffect, useRef, useState } from 'react'
import type { ColorPreset } from '../lib/color-presets'
import { blendHex } from '../lib/color-presets'
import { terminalSubtitle } from '../lib/node-title'

interface TerminalTitleBarContentProps {
  name: string | undefined
  shellTitleHistory: string[] | undefined
  cwd: string | undefined
  preset: ColorPreset | undefined
  id: string
  onRename: (id: string, name: string) => void
  canStartEdit?: () => boolean
}

export function TerminalTitleBarContent({
  name, shellTitleHistory, cwd, preset, id, onRename, canStartEdit
}: TerminalTitleBarContentProps) {
  const [editing, setEditing] = useState(false)
  const [editValue, setEditValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  // Select-all on edit start
  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.select()
    }
  }, [editing])

  const history = terminalSubtitle(shellTitleHistory ?? [])
  const abbrevCwd = cwd?.replace(/^\/Users\/[^/]+/, '~').replace(/^\/home\/[^/]+/, '~')

  return (
    <>
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
            <input
              ref={inputRef}
              className="terminal-card__title-input"
              value={editValue}
              style={preset ? { color: preset.titleBarFg } : undefined}
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
            {history && <span className="terminal-card__history" style={preset ? { color: blendHex(preset.titleBarFg, preset.titleBarBg, 0.75) } : undefined}>{history}</span>}
          </>
        ) : (
          <>
            {name && <span className="terminal-card__custom-name" style={preset ? { color: preset.titleBarFg } : undefined}>{name}</span>}
            {name && history && <span className="terminal-card__separator" style={preset ? { color: blendHex(preset.titleBarFg, preset.titleBarBg, 0.7) } : undefined}>{'\u00A0\u21BC\u00A0'}</span>}
            {history && <span className="terminal-card__history" style={preset ? { color: blendHex(preset.titleBarFg, preset.titleBarBg, 0.75) } : undefined}>{history}</span>}
          </>
        )}
      </div>
      {abbrevCwd && (
        <span className="terminal-card__cwd" style={preset ? { color: blendHex(preset.titleBarFg, preset.titleBarBg, 0.75) } : undefined}>{abbrevCwd}</span>
      )}
    </>
  )
}
