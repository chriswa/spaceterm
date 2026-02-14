import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { CELL_WIDTH, CELL_HEIGHT, terminalPixelSize, WHEEL_WINDOW_MS, HORIZONTAL_SCROLL_THRESHOLD, PINCH_ZOOM_THRESHOLD } from '../lib/constants'
import { COLOR_PRESETS, COLOR_PRESET_MAP } from '../lib/color-presets'

const DRAG_THRESHOLD = 5
const textEncoder = new TextEncoder()

export const terminalSelectionGetters = new Map<string, () => string>()

interface TerminalCardProps {
  sessionId: string
  x: number
  y: number
  cols: number
  rows: number
  zIndex: number
  zoom: number
  name?: string
  colorPresetId?: string
  shellTitle?: string
  shellTitleHistory?: string[]
  cwd?: string
  focused: boolean
  scrollMode: boolean
  onFocus: (sessionId: string) => void
  onUnfocus: () => void
  onDisableScrollMode: () => void
  onClose: (sessionId: string) => void
  onMove: (sessionId: string, x: number, y: number) => void
  onResize: (sessionId: string, cols: number, rows: number) => void
  onRename: (sessionId: string, name: string) => void
  onColorChange: (sessionId: string, color: string) => void
  onCwdChange?: (sessionId: string, cwd: string) => void
  onShellTitleChange?: (sessionId: string, title: string) => void
  onShellTitleHistoryChange?: (sessionId: string, history: string[]) => void
  claudeSessionHistory?: ClaudeSessionEntry[]
  onClaudeSessionHistoryChange?: (sessionId: string, history: ClaudeSessionEntry[]) => void
  waitingForUser?: boolean
  onWaitingForUserChange?: (sessionId: string, waiting: boolean) => void
  onExit?: (sessionId: string, exitCode: number) => void
  onNodeReady?: (nodeId: string, bounds: { x: number; y: number; width: number; height: number }) => void
}

export function TerminalCard({
  sessionId, x, y, cols, rows, zIndex, zoom, name, colorPresetId, shellTitle, shellTitleHistory, cwd, focused, scrollMode,
  onFocus, onUnfocus, onDisableScrollMode, onClose, onMove, onResize, onRename, onColorChange,
  onCwdChange, onShellTitleChange, onShellTitleHistoryChange, claudeSessionHistory, onClaudeSessionHistoryChange, waitingForUser, onWaitingForUserChange, onExit, onNodeReady
}: TerminalCardProps) {
  const preset = colorPresetId ? COLOR_PRESET_MAP[colorPresetId] : undefined
  const cardRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const wheelAccRef = useRef({ dx: 0, dy: 0, t: 0 })

  // Keep current props in refs for event handlers
  const propsRef = useRef({ x, y, zoom, focused, sessionId, onCwdChange, onShellTitleChange, onShellTitleHistoryChange, onClaudeSessionHistoryChange, onWaitingForUserChange, onDisableScrollMode, onExit, onNodeReady })
  propsRef.current = { x, y, zoom, focused, sessionId, onCwdChange, onShellTitleChange, onShellTitleHistoryChange, onClaudeSessionHistoryChange, onWaitingForUserChange, onDisableScrollMode, onExit, onNodeReady }

  const scrollModeRef = useRef(false)
  scrollModeRef.current = scrollMode

  // Derive pixel size from cols/rows
  const { width, height } = terminalPixelSize(cols, rows)

  // Mount terminal
  useEffect(() => {
    if (!containerRef.current) return

    const term = new Terminal({
      fontSize: 14,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      theme: {
        background: '#1e1e2e',
        foreground: '#cdd6f4',
        cursor: '#f5e0dc',
        selectionBackground: '#585b70',
        black: '#45475a',
        red: '#f38ba8',
        green: '#a6e3a1',
        yellow: '#f9e2af',
        blue: '#89b4fa',
        magenta: '#f5c2e7',
        cyan: '#94e2d5',
        white: '#bac2de',
        brightBlack: '#585b70',
        brightRed: '#f38ba8',
        brightGreen: '#a6e3a1',
        brightYellow: '#f9e2af',
        brightBlue: '#89b4fa',
        brightMagenta: '#f5c2e7',
        brightCyan: '#94e2d5',
        brightWhite: '#a6adc8'
      },
      allowProposedApi: true
    })

    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.loadAddon(new WebLinksAddon((event, url) => {
      if (event.metaKey) {
        window.api.openExternal(url)
      }
    }))
    term.options.linkHandler = {
      activate: (event, url) => {
        if (event.metaKey) {
          window.api.openExternal(url)
        }
      },
      allowNonHttpProtocols: true
    }
    term.loadAddon(new Unicode11Addon())
    term.open(containerRef.current)
    term.unicode.activeVersion = '11'

    // Register shell title change handler (OSC 0 / OSC 2)
    term.onTitleChange((title) => {
      propsRef.current.onShellTitleChange?.(propsRef.current.sessionId, title)
    })

    // Custom wheel handler: controls both xterm scroll processing AND
    // canvas propagation. Attached once at mount — no race condition
    // since propsRef is updated synchronously during render.
    term.attachCustomWheelEventHandler((ev) => {
      if (propsRef.current.focused) {
        // Scroll mode off: all events go to canvas
        if (!scrollModeRef.current) {
          return false
        }

        // Pinch-to-zoom: disable scroll mode, let canvas handle
        if (ev.ctrlKey && Math.abs(ev.deltaY) > PINCH_ZOOM_THRESHOLD) {
          scrollModeRef.current = false
          propsRef.current.onDisableScrollMode()
          return false
        }

        // Accumulate deltas for gesture detection
        const now = performance.now()
        const acc = wheelAccRef.current
        if (now - acc.t > WHEEL_WINDOW_MS) {
          acc.dx = 0
          acc.dy = 0
        }
        acc.dx += Math.abs(ev.deltaX)
        acc.dy += Math.abs(ev.deltaY)
        acc.t = now

        // Horizontal scroll: disable scroll mode, let canvas handle
        if (acc.dx > HORIZONTAL_SCROLL_THRESHOLD && acc.dx > acc.dy) {
          acc.dx = 0
          acc.dy = 0
          scrollModeRef.current = false
          propsRef.current.onDisableScrollMode()
          return false
        }

        // Vertical scroll: xterm handles, canvas doesn't see it
        ev.stopPropagation()
        return true
      }
      // Block xterm's scroll processing when not focused
      return false
    })

    term.attachCustomKeyEventHandler((ev) => {
      window.api.log(`[KeyHandler] type=${ev.type} key=${ev.key} shiftKey=${ev.shiftKey} code=${ev.code}`)
      if (ev.key === 'Enter' && ev.shiftKey) {
        if (ev.type === 'keydown') {
          // Send ESC + CR (\x1b\r) for Shift+Enter.
          // Ink's parseKeypress interprets this as meta+return, which Claude Code
          // (and other Ink-based CLIs) treat as "insert newline" instead of submit.
          window.api.log(`[KeyHandler] Shift+Enter detected, sending ESC+CR to session ${propsRef.current.sessionId}`)
          window.api.pty.write(propsRef.current.sessionId, '\x1b\r')
        }
        // Block all event types (keydown, keypress, keyup) for Shift+Enter
        // to prevent xterm from also sending a regular \r via the keypress event.
        return false
      }
      return true
    })

    try {
      fitAddon.fit()
    } catch {
      // Container may not be sized yet
    }

    // Log actual cell dimensions from xterm's renderer for calibration
    try {
      const dims = (term as any)._core._renderService.dimensions
      window.api.log(`[TerminalCard ${sessionId.slice(0, 8)}] cell dimensions: cellWidth=${dims.css.cell.width} cellHeight=${dims.css.cell.height} constantCellWidth=${CELL_WIDTH} constantCellHeight=${CELL_HEIGHT} termCols=${term.cols} termRows=${term.rows}`)
    } catch {
      // Renderer not ready yet
    }

    // Attach to server session and replay scrollback before subscribing to live data
    let cancelled = false
    window.api.pty.attach(sessionId).then((result) => {
      if (cancelled) return
      if (result.scrollback.length > 0) {
        term.write(textEncoder.encode(result.scrollback))
      }
      if (result.shellTitleHistory && result.shellTitleHistory.length > 0) {
        propsRef.current.onShellTitleHistoryChange?.(propsRef.current.sessionId, result.shellTitleHistory)
      }
      if (result.cwd) {
        propsRef.current.onCwdChange?.(propsRef.current.sessionId, result.cwd)
      }
      if (result.claudeSessionHistory && result.claudeSessionHistory.length > 0) {
        propsRef.current.onClaudeSessionHistoryChange?.(propsRef.current.sessionId, result.claudeSessionHistory)
      }
      if (result.waitingForUser !== undefined) {
        propsRef.current.onWaitingForUserChange?.(propsRef.current.sessionId, result.waitingForUser)
      }
    }).catch(() => {
      // Session may not exist on server (e.g. newly created, already attached)
    })

    // Wire up IPC
    const cleanupData = window.api.pty.onData(sessionId, (data) => {
      term.write(textEncoder.encode(data))
    })

    const cleanupExit = window.api.pty.onExit(sessionId, (exitCode) => {
      propsRef.current.onExit?.(propsRef.current.sessionId, exitCode)
    })

    const cleanupTitleHistory = window.api.pty.onShellTitleHistory(sessionId, (history) => {
      propsRef.current.onShellTitleHistoryChange?.(propsRef.current.sessionId, history)
    })

    const cleanupCwd = window.api.pty.onCwd(sessionId, (cwd) => {
      propsRef.current.onCwdChange?.(propsRef.current.sessionId, cwd)
    })

    const cleanupClaudeSessionHistory = window.api.pty.onClaudeSessionHistory(sessionId, (history) => {
      propsRef.current.onClaudeSessionHistoryChange?.(propsRef.current.sessionId, history)
    })

    const cleanupWaitingForUser = window.api.pty.onWaitingForUser(sessionId, (waiting) => {
      propsRef.current.onWaitingForUserChange?.(propsRef.current.sessionId, waiting)
    })

    term.onData((data) => {
      window.api.pty.write(sessionId, data)
    })

    term.onResize(({ cols, rows }) => {
      window.api.pty.resize(sessionId, cols, rows)
    })

    terminalRef.current = term
    fitAddonRef.current = fitAddon
    terminalSelectionGetters.set(sessionId, () => term.getSelection())

    return () => {
      cancelled = true
      terminalSelectionGetters.delete(sessionId)
      cleanupData()
      cleanupExit()
      cleanupTitleHistory()
      cleanupCwd()
      cleanupClaudeSessionHistory()
      cleanupWaitingForUser()
      term.dispose()
    }
  }, [sessionId])

  // Tint xterm background to match color preset
  useEffect(() => {
    const term = terminalRef.current
    if (!term) return
    const bg = preset?.terminalBg ?? '#1e1e2e'
    term.options.theme = { ...term.options.theme, background: bg }
  }, [preset])

  // Keyboard focus management
  useEffect(() => {
    const term = terminalRef.current
    if (!term) return

    if (focused) {
      term.focus()
    } else {
      term.blur()
    }
  }, [focused, sessionId])

  // Notify parent when focused node size is known (mount or resize)
  useEffect(() => {
    if (!focused) return
    const { width, height } = terminalPixelSize(cols, rows)
    propsRef.current.onNodeReady?.(sessionId, { x: propsRef.current.x, y: propsRef.current.y, width, height })
  }, [focused, cols, rows, sessionId])

  // Mouse coordinate correction for CSS transform scaling.
  // xterm uses clientX - getBoundingClientRect().left for mouse position.
  // We intercept mouse events in the capture phase and patch coordinates
  // so xterm's math yields the correct unscaled position.
  useEffect(() => {
    const container = containerRef.current
    if (!container || !focused) return

    const screen = container.querySelector('.xterm-screen') as HTMLElement
    if (!screen) return

    const adjustCoords = (e: MouseEvent) => {
      const z = propsRef.current.zoom
      if (z === 1) return

      const rect = screen.getBoundingClientRect()

      // Offset within element in screen pixels (scaled)
      const screenX = e.clientX - rect.left
      const screenY = e.clientY - rect.top

      // Convert to unscaled (CSS pixel) offset
      const unscaledX = screenX / z
      const unscaledY = screenY / z

      // Patch clientX/clientY so xterm's (clientX - rect.left) = unscaledX
      const correctedClientX = rect.left + unscaledX
      const correctedClientY = rect.top + unscaledY

      Object.defineProperty(e, 'clientX', { value: correctedClientX, configurable: true })
      Object.defineProperty(e, 'clientY', { value: correctedClientY, configurable: true })
      Object.defineProperty(e, 'pageX', { value: correctedClientX, configurable: true })
      Object.defineProperty(e, 'pageY', { value: correctedClientY, configurable: true })
      Object.defineProperty(e, 'offsetX', { value: unscaledX, configurable: true })
      Object.defineProperty(e, 'offsetY', { value: unscaledY, configurable: true })
    }

    screen.addEventListener('mousedown', adjustCoords, { capture: true })
    screen.addEventListener('mousemove', adjustCoords, { capture: true })
    screen.addEventListener('mouseup', adjustCoords, { capture: true })

    return () => {
      screen.removeEventListener('mousedown', adjustCoords, { capture: true })
      screen.removeEventListener('mousemove', adjustCoords, { capture: true })
      screen.removeEventListener('mouseup', adjustCoords, { capture: true })
    }
  }, [focused])

  // Filter non-left-click mouse buttons from reaching xterm during focus.
  // Blocks right-click, middle-click, and buttons 3/4 (prep for future custom actions).
  useEffect(() => {
    const container = containerRef.current
    if (!container || !focused) return

    const screen = container.querySelector('.xterm-screen') as HTMLElement
    if (!screen) return

    const filter = (e: MouseEvent) => {
      if (e.button !== 0) {
        e.preventDefault()
        e.stopPropagation()
        e.stopImmediatePropagation()
      }
    }

    screen.addEventListener('mousedown', filter, { capture: true })
    screen.addEventListener('mouseup', filter, { capture: true })
    screen.addEventListener('auxclick', filter, { capture: true })
    screen.addEventListener('contextmenu', filter, { capture: true })

    return () => {
      screen.removeEventListener('mousedown', filter, { capture: true })
      screen.removeEventListener('mouseup', filter, { capture: true })
      screen.removeEventListener('auxclick', filter, { capture: true })
      screen.removeEventListener('contextmenu', filter, { capture: true })
    }
  }, [focused])

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

  // Mousedown handler: drag-to-move or click-to-hard-focus
  const handleMouseDown = (e: React.MouseEvent) => {
    // Don't interfere with header buttons or editable title/color picker
    if ((e.target as HTMLElement).closest('.terminal-card__close, .terminal-card__color-btn, .terminal-card__left-area, .terminal-card__title-input, .terminal-card__color-picker')) return

    const isHeader = !!(e.target as HTMLElement).closest('.terminal-card__header')

    // When focused and clicking body: let xterm handle the event
    // but still detect click (no drag) for re-centering the camera
    const bodyClickWhileFocused = focused && !isHeader
    if (!bodyClickWhileFocused) {
      e.preventDefault()
    }

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
      }

      if (dragging && !bodyClickWhileFocused) {
        onMove(sessionId, startX + dx / currentZoom, startY + dy / currentZoom)
      }
    }

    const onMouseUp = () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)

      if (!dragging) {
        onFocus(sessionId)
      }
    }

    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
  }

  const abbrevCwd = cwd?.replace(/^\/Users\/[^/]+/, '~').replace(/^\/home\/[^/]+/, '~')
  const history = (shellTitleHistory ?? []).join(' \u00A0\u21BC\u00A0\u00A0')

  const focusClass = focused
    ? scrollMode
      ? 'terminal-card--focused terminal-card--scroll-mode'
      : 'terminal-card--focused'
    : ''
  const waitingClass = waitingForUser ? 'terminal-card--waiting' : ''

  return (
    <div
      style={{
        position: 'absolute',
        left: x,
        top: y,
        width,
        height,
        zIndex
      }}
    >
      <div
        ref={cardRef}
        data-session-id={sessionId}
        className={`terminal-card canvas-node ${focusClass} ${waitingClass}`}
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
                    onRename(sessionId, editValue)
                    setEditing(false)
                  } else if (e.key === 'Escape') {
                    setEditing(false)
                  }
                  e.stopPropagation()
                }}
                onBlur={() => {
                  onRename(sessionId, editValue)
                  setEditing(false)
                }}
                onMouseDown={(e) => e.stopPropagation()}
                autoFocus
              />
              {history && <span className="terminal-card__history" style={preset ? { color: preset.titleBarFg, opacity: 0.75 } : undefined}>{history}</span>}
            </>
          ) : (
            <>
              {name && <span className="terminal-card__custom-name" style={preset ? { color: preset.titleBarFg } : undefined}>{name}</span>}
              {name && history && <span className="terminal-card__separator" style={preset ? { color: preset.titleBarFg, opacity: 0.7 } : undefined}>{'\u00A0\u21BC\u00A0'}</span>}
              {history && <span className="terminal-card__history" style={preset ? { color: preset.titleBarFg, opacity: 0.75 } : undefined}>{history}</span>}
            </>
          )}
        </div>
        {abbrevCwd && (
          <span className="terminal-card__cwd" style={preset ? { color: preset.titleBarFg, opacity: 0.75 } : undefined}>{abbrevCwd}</span>
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
                      onColorChange(sessionId, p.id)
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
            onClick={(e) => { e.stopPropagation(); onClose(sessionId) }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            &times;
          </button>
        </div>
      </div>
      <div className="terminal-card__body" ref={containerRef} />
      <div className="terminal-card__footer" style={preset ? { backgroundColor: preset.titleBarBg, color: preset.titleBarFg, borderTopColor: preset.titleBarBg } : undefined}>
        {waitingForUser && <span className="terminal-card__waiting-indicator" title="Waiting for input" />}
        {sessionId.slice(0, 8)}
      </div>
      </div>
      {claudeSessionHistory && claudeSessionHistory.length > 0 && (
        <div className="terminal-card__session-history">
          {claudeSessionHistory.map((entry, i) => (
            <div key={i} className={`terminal-card__session-entry terminal-card__session-entry--${entry.reason}`}>
              <span className="terminal-card__session-id">{entry.claudeSessionId.slice(0, 8)}</span>
              {' '}
              <span className="terminal-card__session-reason">({entry.reason})</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
