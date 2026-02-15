import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { CELL_WIDTH, CELL_HEIGHT, terminalPixelSize, WHEEL_WINDOW_MS, HORIZONTAL_SCROLL_THRESHOLD, PINCH_ZOOM_THRESHOLD } from '../lib/constants'
import { COLOR_PRESETS, COLOR_PRESET_MAP } from '../lib/color-presets'
import type { SnapshotMessage } from '../../../../shared/protocol'

const DRAG_THRESHOLD = 5
const LOW_ZOOM_THRESHOLD = 0.3
const SNAPSHOT_FONT = '14px Menlo, Monaco, "Courier New", monospace'
const SNAPSHOT_BOLD_FONT = 'bold 14px Menlo, Monaco, "Courier New", monospace'
const textEncoder = new TextEncoder()

export const terminalSelectionGetters = new Map<string, () => string>()

interface TerminalCardProps {
  id: string
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
  onFocus: (id: string) => void
  onUnfocus: () => void
  onDisableScrollMode: () => void
  onClose: (id: string) => void
  onMove: (id: string, x: number, y: number) => void
  onResize: (id: string, cols: number, rows: number) => void
  onRename: (id: string, name: string) => void
  onColorChange: (id: string, color: string) => void
  onCwdChange?: (id: string, cwd: string) => void
  onShellTitleChange?: (id: string, title: string) => void
  onShellTitleHistoryChange?: (id: string, history: string[]) => void
  claudeSessionHistory?: ClaudeSessionEntry[]
  onClaudeSessionHistoryChange?: (id: string, history: ClaudeSessionEntry[]) => void
  waitingForUser?: boolean
  onWaitingForUserChange?: (id: string, waiting: boolean) => void
  onExit?: (id: string, exitCode: number) => void
  onNodeReady?: (nodeId: string, bounds: { x: number; y: number; width: number; height: number }) => void
  onDragStart?: (id: string) => void
  onDragEnd?: (id: string) => void
}

export function TerminalCard({
  id, sessionId, x, y, cols, rows, zIndex, zoom, name, colorPresetId, shellTitle, shellTitleHistory, cwd, focused, scrollMode,
  onFocus, onUnfocus, onDisableScrollMode, onClose, onMove, onResize, onRename, onColorChange,
  onCwdChange, onShellTitleChange, onShellTitleHistoryChange, claudeSessionHistory, onClaudeSessionHistoryChange, waitingForUser, onWaitingForUserChange, onExit, onNodeReady,
  onDragStart, onDragEnd
}: TerminalCardProps) {
  const preset = colorPresetId ? COLOR_PRESET_MAP[colorPresetId] : undefined
  const cardRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const wheelAccRef = useRef({ dx: 0, dy: 0, t: 0 })
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const snapshotRef = useRef<SnapshotMessage | null>(null)

  // Keep current props in refs for event handlers
  const propsRef = useRef({ x, y, zoom, focused, id, sessionId, onCwdChange, onShellTitleChange, onShellTitleHistoryChange, onClaudeSessionHistoryChange, onWaitingForUserChange, onDisableScrollMode, onExit, onNodeReady })
  propsRef.current = { x, y, zoom, focused, id, sessionId, onCwdChange, onShellTitleChange, onShellTitleHistoryChange, onClaudeSessionHistoryChange, onWaitingForUserChange, onDisableScrollMode, onExit, onNodeReady }

  const scrollModeRef = useRef(false)
  scrollModeRef.current = scrollMode

  // Derive pixel size from cols/rows
  const { width, height } = terminalPixelSize(cols, rows)

  // Mount terminal (only when focused)
  useEffect(() => {
    if (!focused) return
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
      propsRef.current.onShellTitleChange?.(propsRef.current.id, title)
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
      window.api.log(`[TerminalCard ${id.slice(0, 8)}] cell dimensions: cellWidth=${dims.css.cell.width} cellHeight=${dims.css.cell.height} constantCellWidth=${CELL_WIDTH} constantCellHeight=${CELL_HEIGHT} termCols=${term.cols} termRows=${term.rows}`)
    } catch {
      // Renderer not ready yet
    }

    // Switch to live mode (stop receiving snapshots, start receiving raw data)
    window.api.node.setTerminalMode(sessionId, 'live')

    // Attach to server session and replay scrollback before subscribing to live data
    let cancelled = false
    window.api.pty.attach(sessionId).then((result) => {
      if (cancelled) return
      if (result.scrollback.length > 0) {
        term.write(textEncoder.encode(result.scrollback))
      }
      if (result.shellTitleHistory && result.shellTitleHistory.length > 0) {
        propsRef.current.onShellTitleHistoryChange?.(propsRef.current.id, result.shellTitleHistory)
      }
      if (result.cwd) {
        propsRef.current.onCwdChange?.(propsRef.current.id, result.cwd)
      }
      if (result.claudeSessionHistory && result.claudeSessionHistory.length > 0) {
        propsRef.current.onClaudeSessionHistoryChange?.(propsRef.current.id, result.claudeSessionHistory)
      }
      if (result.waitingForUser !== undefined) {
        propsRef.current.onWaitingForUserChange?.(propsRef.current.id, result.waitingForUser)
      }
    }).catch(() => {
      // Session may not exist on server (e.g. newly created, already attached)
    })

    // Wire up IPC — use sessionId for all PTY operations
    const cleanupData = window.api.pty.onData(sessionId, (data) => {
      term.write(textEncoder.encode(data))
    })

    const cleanupExit = window.api.pty.onExit(sessionId, (exitCode) => {
      propsRef.current.onExit?.(propsRef.current.id, exitCode)
    })

    const cleanupTitleHistory = window.api.pty.onShellTitleHistory(sessionId, (history) => {
      propsRef.current.onShellTitleHistoryChange?.(propsRef.current.id, history)
    })

    const cleanupCwd = window.api.pty.onCwd(sessionId, (cwd) => {
      propsRef.current.onCwdChange?.(propsRef.current.id, cwd)
    })

    const cleanupClaudeSessionHistory = window.api.pty.onClaudeSessionHistory(sessionId, (history) => {
      propsRef.current.onClaudeSessionHistoryChange?.(propsRef.current.id, history)
    })

    const cleanupWaitingForUser = window.api.pty.onWaitingForUser(sessionId, (waiting) => {
      propsRef.current.onWaitingForUserChange?.(propsRef.current.id, waiting)
    })

    term.onData((data) => {
      window.api.pty.write(propsRef.current.sessionId, data)
    })

    term.onResize(({ cols, rows }) => {
      window.api.pty.resize(propsRef.current.sessionId, cols, rows)
    })

    terminalRef.current = term
    fitAddonRef.current = fitAddon
    terminalSelectionGetters.set(id, () => term.getSelection())

    return () => {
      cancelled = true
      terminalSelectionGetters.delete(id)
      cleanupData()
      cleanupExit()
      cleanupTitleHistory()
      cleanupCwd()
      cleanupClaudeSessionHistory()
      cleanupWaitingForUser()
      term.dispose()
    }
  }, [focused, sessionId])

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
  }, [focused, id])

  // Notify parent when focused node size is known (mount or resize)
  useEffect(() => {
    if (!focused) return
    const { width, height } = terminalPixelSize(cols, rows)
    propsRef.current.onNodeReady?.(id, { x: propsRef.current.x - width / 2, y: propsRef.current.y - height / 2, width, height })
  }, [focused, cols, rows, id])

  // --- Snapshot mode (only when unfocused) ---

  const paintCanvas = (snapshot: SnapshotMessage, currentZoom: number) => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const cw = Math.ceil(cols * CELL_WIDTH)
    const ch = Math.ceil(rows * CELL_HEIGHT)

    if (canvas.width !== cw || canvas.height !== ch) {
      canvas.width = cw
      canvas.height = ch
    }

    const bgColor = preset?.terminalBg ?? '#1e1e2e'
    ctx.fillStyle = bgColor
    ctx.fillRect(0, 0, cw, ch)

    const lowDetail = currentZoom < LOW_ZOOM_THRESHOLD

    for (let y = 0; y < snapshot.lines.length; y++) {
      const row = snapshot.lines[y]
      let xOffset = 0

      for (const span of row) {
        const spanWidth = span.text.length * CELL_WIDTH

        if (span.bg !== bgColor && span.bg !== '#1e1e2e') {
          ctx.fillStyle = span.bg
          ctx.fillRect(xOffset, y * CELL_HEIGHT, spanWidth, CELL_HEIGHT)
        }

        if (lowDetail) {
          if (span.fg !== '#000000' && span.text.trim().length > 0) {
            ctx.fillStyle = span.fg
            ctx.globalAlpha = 0.7
            for (let i = 0; i < span.text.length; i++) {
              if (span.text[i] !== ' ') {
                ctx.fillRect(xOffset + i * CELL_WIDTH + 1, y * CELL_HEIGHT + 3, CELL_WIDTH - 2, CELL_HEIGHT - 6)
              }
            }
            ctx.globalAlpha = 1.0
          }
        } else {
          if (span.text.trim().length > 0) {
            ctx.fillStyle = span.fg
            ctx.font = span.bold ? SNAPSHOT_BOLD_FONT : SNAPSHOT_FONT
            ctx.textBaseline = 'top'
            for (let i = 0; i < span.text.length; i++) {
              if (span.text[i] !== ' ') {
                ctx.fillText(span.text[i], xOffset + i * CELL_WIDTH, y * CELL_HEIGHT + 1)
              }
            }
          }
        }

        xOffset += spanWidth
      }
    }
  }

  // Subscribe to snapshot events (only when unfocused)
  useEffect(() => {
    if (focused) return

    window.api.node.setTerminalMode(sessionId, 'snapshot')

    const cleanup = window.api.node.onSnapshot(sessionId, (snapshot) => {
      snapshotRef.current = snapshot
      paintCanvas(snapshot, propsRef.current.zoom)
    })

    return () => {
      cleanup()
    }
  }, [focused, sessionId])

  // Repaint snapshot when zoom changes
  useEffect(() => {
    if (focused) return
    if (snapshotRef.current) {
      paintCanvas(snapshotRef.current, zoom)
    }
  }, [focused, zoom])

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
  const dragOccurredRef = useRef(false)

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
    // Don't interfere with header buttons or color picker
    if ((e.target as HTMLElement).closest('.terminal-card__close, .terminal-card__color-btn, .terminal-card__color-picker')) return

    const isInteractiveTitle = !!(e.target as HTMLElement).closest('.terminal-card__left-area')

    const isHeader = !!(e.target as HTMLElement).closest('.terminal-card__header')

    // When focused and clicking body: let xterm handle the event
    // but still detect click (no drag) for re-centering the camera
    const bodyClickWhileFocused = focused && !isHeader
    if (!bodyClickWhileFocused && !isInteractiveTitle) {
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
        onDragStart?.(id)
        if (isInteractiveTitle && inputRef.current) {
          inputRef.current.blur()
        }
      }

      if (dragging && !bodyClickWhileFocused) {
        onMove(id, startX + dx / currentZoom, startY + dy / currentZoom)
      }
    }

    const onMouseUp = () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)

      if (dragging) {
        onDragEnd?.(id)
        if (isInteractiveTitle) {
          dragOccurredRef.current = true
          setTimeout(() => { dragOccurredRef.current = false }, 0)
        }
      } else {
        onFocus(id)
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
  const waitingClass = waitingForUser && !focused ? 'terminal-card--waiting' : ''

  return (
    <div
      style={{
        position: 'absolute',
        left: x - width / 2,
        top: y - height / 2,
        width,
        height,
        zIndex
      }}
    >
      <div
        ref={cardRef}
        data-node-id={id}
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
            if (dragOccurredRef.current) return
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
      <div className="terminal-card__body" ref={containerRef} style={{ display: focused ? undefined : 'none' }} />
      <div style={{ display: focused ? 'none' : undefined, padding: '2px 2px 0 2px', flex: 1 }}>
        <canvas
          ref={canvasRef}
          style={{
            width: Math.ceil(cols * CELL_WIDTH),
            height: Math.ceil(rows * CELL_HEIGHT),
            display: 'block'
          }}
        />
      </div>
      <div className="terminal-card__footer" style={preset ? { backgroundColor: preset.titleBarBg, color: preset.titleBarFg, borderTopColor: preset.titleBarBg } : undefined}>
        {id.slice(0, 8)}
        {waitingForUser && <span className="terminal-card__footer-waiting-text"> — User Input Required!</span>}
      </div>
      </div>
      {claudeSessionHistory && claudeSessionHistory.length > 0 && (
        <div className="terminal-card__session-history">
          {[...claudeSessionHistory].reverse().map((entry, i) => (
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
