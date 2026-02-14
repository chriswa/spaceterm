import { useEffect, useRef, useState } from 'react'
import { REMNANT_WIDTH, REMNANT_HEIGHT } from '../lib/constants'
import { COLOR_PRESETS, COLOR_PRESET_MAP } from '../lib/color-presets'

const DRAG_THRESHOLD = 5

interface RemnantCardProps {
  id: string
  x: number
  y: number
  zIndex: number
  zoom: number
  name?: string
  colorPresetId?: string
  shellTitleHistory?: string[]
  cwd?: string
  claudeSessionHistory?: ClaudeSessionEntry[]
  exitCode: number
  focused: boolean
  onFocus: (id: string) => void
  onClose: (id: string) => void
  onMove: (id: string, x: number, y: number) => void
  onRename: (id: string, name: string) => void
  onColorChange: (id: string, color: string) => void
  onResumeSession?: (remnantId: string, claudeSessionId: string) => void
  onNodeReady?: (nodeId: string, bounds: { x: number; y: number; width: number; height: number }) => void
  onDragStart?: (id: string) => void
  onDragEnd?: (id: string) => void
}

export function RemnantCard({
  id, x, y, zIndex, zoom, name, colorPresetId, shellTitleHistory, cwd, claudeSessionHistory, exitCode, focused,
  onFocus, onClose, onMove, onRename, onColorChange, onResumeSession, onNodeReady,
  onDragStart, onDragEnd
}: RemnantCardProps) {
  const preset = colorPresetId ? COLOR_PRESET_MAP[colorPresetId] : undefined
  const propsRef = useRef({ x, y, zoom, id, onNodeReady })
  propsRef.current = { x, y, zoom, id, onNodeReady }

  // Editable title state
  const [editing, setEditing] = useState(false)
  const [editValue, setEditValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  // Select-all on edit start
  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.select()
    }
  }, [editing])

  // Color picker state
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

  // Notify parent when focused node is ready
  useEffect(() => {
    if (!focused) return
    propsRef.current.onNodeReady?.(id, { x: propsRef.current.x, y: propsRef.current.y, width: REMNANT_WIDTH, height: REMNANT_HEIGHT })
  }, [focused, id])

  // Mousedown handler: drag-to-move or click-to-focus
  const handleMouseDown = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('.terminal-card__close, .terminal-card__color-btn, .terminal-card__left-area, .terminal-card__title-input, .terminal-card__color-picker')) return

    e.preventDefault()

    const startScreenX = e.clientX
    const startScreenY = e.clientY
    const startX = propsRef.current.x
    const startY = propsRef.current.y
    const currentZoom = propsRef.current.zoom
    let dragging = false

    const onMouseMove = (ev: MouseEvent) => {
      const dx = ev.clientX - startScreenX
      const dy = ev.clientY - startScreenY

      if (!dragging && Math.abs(dx) + Math.abs(dy) > DRAG_THRESHOLD) {
        dragging = true
        onDragStart?.(id)
      }

      if (dragging) {
        onMove(id, startX + dx / currentZoom, startY + dy / currentZoom)
      }
    }

    const onMouseUp = () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)

      if (dragging) {
        onDragEnd?.(id)
      } else {
        onFocus(id)
      }
    }

    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
  }

  // Build display text
  const abbrevCwd = cwd?.replace(/^\/Users\/[^/]+/, '~').replace(/^\/home\/[^/]+/, '~')
  const seen = new Set<string>()
  const unique = (shellTitleHistory ?? []).filter((t) => {
    if (seen.has(t)) return false
    seen.add(t)
    return true
  })
  const history = unique.join(' \u25C0 ')

  return (
    <div
      data-node-id={id}
      className={`remnant-card canvas-node ${focused ? 'remnant-card--focused' : ''}`}
      style={{
        position: 'absolute',
        left: x,
        top: y,
        width: REMNANT_WIDTH,
        zIndex
      }}
      onMouseDown={handleMouseDown}
    >
      <div
        className="terminal-card__header"
        style={preset ? {
          backgroundColor: preset.titleBarBg,
          color: preset.titleBarFg,
          borderBottomColor: preset.titleBarBg
        } : undefined}
      >
        <div
          className="terminal-card__left-area"
          onClick={(e) => {
            e.stopPropagation()
            setEditValue(name || '')
            setEditing(true)
          }}
          onMouseDown={(e) => e.stopPropagation()}
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
                onMouseDown={(e) => e.stopPropagation()}
                autoFocus
              />
              {history && <span className="terminal-card__history" style={preset ? { color: preset.titleBarFg, opacity: 0.5 } : undefined}>{history}</span>}
            </>
          ) : (
            <>
              {name && <span className="terminal-card__custom-name" style={preset ? { color: preset.titleBarFg } : undefined}>{name}</span>}
              {name && history && <span className="terminal-card__separator" style={preset ? { color: preset.titleBarFg, opacity: 0.4 } : undefined}>{'\u2014'}</span>}
              {history && <span className="terminal-card__history" style={preset ? { color: preset.titleBarFg, opacity: 0.5 } : undefined}>{history}</span>}
            </>
          )}
        </div>
        {abbrevCwd && (
          <span className="terminal-card__cwd" style={preset ? { color: preset.titleBarFg, opacity: 0.5 } : undefined}>{abbrevCwd}</span>
        )}
        <div className="terminal-card__actions">
          <div style={{ position: 'relative' }} ref={pickerRef}>
            <button
              className="terminal-card__color-btn"
              title="Header color"
              style={preset ? { color: preset.titleBarFg } : undefined}
              onClick={(e) => {
                e.stopPropagation()
                setPickerOpen((prev) => !prev)
              }}
              onMouseDown={(e) => e.stopPropagation()}
            >
              ●
            </button>
            {pickerOpen && (
              <div className="terminal-card__color-picker" onMouseDown={(e) => e.stopPropagation()}>
                {COLOR_PRESETS.map((p) => (
                  <button
                    key={p.id}
                    className="terminal-card__color-swatch"
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
            className="terminal-card__close"
            style={preset ? { color: preset.titleBarFg } : undefined}
            onClick={(e) => { e.stopPropagation(); onClose(id) }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            &times;
          </button>
        </div>
      </div>
      <div className="remnant-card__body">
        <div className="remnant-card__exit">exited ({exitCode})</div>
        {claudeSessionHistory && claudeSessionHistory.length > 0 && (
          <div className="remnant-card__sessions">
            {[...claudeSessionHistory].reverse().map((entry, i) => (
              <div
                key={i}
                className={`terminal-card__session-entry terminal-card__session-entry--${entry.reason} terminal-card__session-entry--clickable`}
                onClick={(e) => {
                  e.stopPropagation()
                  onResumeSession?.(id, entry.claudeSessionId)
                }}
                onMouseDown={(e) => e.stopPropagation()}
              >
                <span className="terminal-card__session-id">{entry.claudeSessionId.slice(0, 8)}</span>
                {' '}
                <span className="terminal-card__session-reason">({entry.reason})</span>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="terminal-card__footer" style={preset ? { backgroundColor: preset.titleBarBg, color: preset.titleBarFg, borderTopColor: preset.titleBarBg } : undefined}>
        {id.slice(0, 8)}
      </div>
    </div>
  )
}
