import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { CELL_WIDTH, CELL_HEIGHT, terminalPixelSize, WHEEL_WINDOW_MS, HORIZONTAL_SCROLL_THRESHOLD, PINCH_ZOOM_THRESHOLD } from '../lib/constants'

const DRAG_THRESHOLD = 5

const PRESET_COLORS = [
  '#f38ba8', '#fab387', '#f9e2af', '#a6e3a1',
  '#94e2d5', '#89b4fa', '#b4befe', '#cba6f7',
  '#f5c2e7', '#eba0ac', '#74c7ec', '#7f849c',
  '#585b70', '#45475a', '#313244', '#181825',
]

function contrastForeground(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255
  return luminance > 0.5 ? '#1e1e2e' : '#cdd6f4'
}

const TINT_AMOUNT = 0.35
const DARKEN = 0.55

function tintedBackground(hex: string): string {
  // Mix the color in, then darken the result
  let r = Math.round(0x1e + (parseInt(hex.slice(1, 3), 16) - 0x1e) * TINT_AMOUNT)
  let g = Math.round(0x1e + (parseInt(hex.slice(3, 5), 16) - 0x1e) * TINT_AMOUNT)
  let b = Math.round(0x2e + (parseInt(hex.slice(5, 7), 16) - 0x2e) * TINT_AMOUNT)
  r = Math.round(r * DARKEN)
  g = Math.round(g * DARKEN)
  b = Math.round(b * DARKEN)
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`
}

interface TerminalCardProps {
  sessionId: string
  x: number
  y: number
  cols: number
  rows: number
  zIndex: number
  zoom: number
  name?: string
  headerColor?: string
  shellTitle?: string
  focusMode: 'none' | 'soft' | 'hard'
  onSoftFocus: (sessionId: string) => void
  onHardFocus: (sessionId: string) => void
  onUnfocus: () => void
  onClose: (sessionId: string) => void
  onMove: (sessionId: string, x: number, y: number) => void
  onResize: (sessionId: string, cols: number, rows: number) => void
  onRename: (sessionId: string, name: string) => void
  onColorChange: (sessionId: string, color: string) => void
  onCwdChange?: (sessionId: string, cwd: string) => void
  onShellTitleChange?: (sessionId: string, title: string) => void
}

export function TerminalCard({
  sessionId, x, y, cols, rows, zIndex, zoom, name, headerColor, shellTitle, focusMode,
  onSoftFocus, onHardFocus, onUnfocus, onClose, onMove, onResize, onRename, onColorChange,
  onCwdChange, onShellTitleChange
}: TerminalCardProps) {
  const cardRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const wheelAccRef = useRef({ dx: 0, dy: 0, t: 0 })

  // Keep current props in refs for event handlers
  const propsRef = useRef({ x, y, zoom, focusMode, sessionId, onUnfocus, onCwdChange, onShellTitleChange })
  propsRef.current = { x, y, zoom, focusMode, sessionId, onUnfocus, onCwdChange, onShellTitleChange }

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
    term.open(containerRef.current)

    // Register OSC 7 handler for CWD reporting
    term.parser.registerOscHandler(7, (data) => {
      // data is "file://HOST/path" — extract the path
      try {
        const url = new URL(data)
        const cwd = decodeURIComponent(url.pathname)
        if (cwd) {
          propsRef.current.onCwdChange?.(propsRef.current.sessionId, cwd)
        }
      } catch {
        // Malformed URL, ignore
      }
      return true
    })

    // Register shell title change handler (OSC 0 / OSC 2)
    term.onTitleChange((title) => {
      propsRef.current.onShellTitleChange?.(propsRef.current.sessionId, title)
    })

    // Custom wheel handler: controls both xterm scroll processing AND
    // canvas propagation. Attached once at mount — no race condition
    // since propsRef is updated synchronously during render.
    term.attachCustomWheelEventHandler((ev) => {
      if (propsRef.current.focusMode === 'hard') {
        // Pinch-to-zoom: ctrlKey (how macOS reports pinch) + above threshold.
        // Per-event check is fine since ctrlKey is a strong disambiguator.
        if (ev.ctrlKey && Math.abs(ev.deltaY) > PINCH_ZOOM_THRESHOLD) {
          propsRef.current.onUnfocus()
          return false
        }

        // Accumulate deltas over a time window for frame-rate-independent
        // gesture detection. At 60Hz each event has ~2× the delta of 120Hz,
        // but summed over WHEEL_WINDOW_MS they converge to the same total.
        const now = performance.now()
        const acc = wheelAccRef.current
        if (now - acc.t > WHEEL_WINDOW_MS) {
          acc.dx = 0
          acc.dy = 0
        }
        acc.dx += Math.abs(ev.deltaX)
        acc.dy += Math.abs(ev.deltaY)
        acc.t = now

        // Horizontal scroll: accumulated horizontal exceeds threshold
        // AND dominates vertical over the window
        if (acc.dx > HORIZONTAL_SCROLL_THRESHOLD && acc.dx > acc.dy) {
          acc.dx = 0
          acc.dy = 0
          propsRef.current.onUnfocus()
          // Return false (block xterm) but DON'T stopPropagation —
          // event bubbles to canvas which handles pan/zoom immediately
          return false
        }

        // Normal vertical scroll: xterm handles it, canvas doesn't see it
        ev.stopPropagation()
        return true
      }
      // Block xterm's scroll processing in soft/none focus
      return false
    })

    term.attachCustomKeyEventHandler((ev) => {
      window.api.log(`[KeyHandler] type=${ev.type} key=${ev.key} shiftKey=${ev.shiftKey} code=${ev.code}`)
      if (ev.type === 'keydown' && ev.key === 'Enter' && ev.shiftKey) {
        // Send ESC + CR (\x1b\r) for Shift+Enter.
        // Ink's parseKeypress interprets this as meta+return, which Claude Code
        // (and other Ink-based CLIs) treat as "insert newline" instead of submit.
        // This is more compatible than CSI u (\x1b[13;2u) which only works
        // with recent Ink versions. ESC+CR works across Claude Code versions,
        // tmux, and SSH sessions.
        window.api.log(`[KeyHandler] Shift+Enter detected, sending ESC+CR to session ${propsRef.current.sessionId}`)
        window.api.pty.write(propsRef.current.sessionId, '\x1b\r')
        return false // prevent xterm's default Enter handling
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
    window.api.pty.attach(sessionId).then((scrollback) => {
      if (cancelled) return
      if (scrollback.length > 0) {
        term.write(scrollback)
      }
    }).catch(() => {
      // Session may not exist on server (e.g. newly created, already attached)
    })

    // Wire up IPC
    const cleanupData = window.api.pty.onData(sessionId, (data) => {
      term.write(data)
    })

    const cleanupExit = window.api.pty.onExit(sessionId, () => {
      term.write('\r\n[Process exited]\r\n')
    })

    term.onData((data) => {
      window.api.pty.write(sessionId, data)
    })

    term.onResize(({ cols, rows }) => {
      window.api.pty.resize(sessionId, cols, rows)
    })

    terminalRef.current = term
    fitAddonRef.current = fitAddon

    return () => {
      cancelled = true
      cleanupData()
      cleanupExit()
      term.dispose()
    }
  }, [sessionId])

  // Tint xterm background to match header color
  useEffect(() => {
    const term = terminalRef.current
    if (!term) return
    const bg = headerColor ? tintedBackground(headerColor) : '#1e1e2e'
    term.options.theme = { ...term.options.theme, background: bg }
  }, [headerColor])

  // Keyboard focus management
  useEffect(() => {
    const term = terminalRef.current
    if (!term) return

    if (focusMode === 'soft' || focusMode === 'hard') {
      term.focus()
    } else {
      term.blur()
    }
  }, [focusMode, sessionId])

  // Mouse coordinate correction for CSS transform scaling.
  // xterm uses clientX - getBoundingClientRect().left for mouse position.
  // We intercept mouse events in the capture phase and patch coordinates
  // so xterm's math yields the correct unscaled position.
  useEffect(() => {
    const container = containerRef.current
    if (!container || focusMode !== 'hard') return

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
  }, [focusMode])

  // Filter non-left-click mouse buttons from reaching xterm during hard focus.
  // Blocks right-click, middle-click, and buttons 3/4 (prep for future custom actions).
  useEffect(() => {
    const container = containerRef.current
    if (!container || focusMode !== 'hard') return

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
  }, [focusMode])

  // Editable title state
  const [editing, setEditing] = useState(false)
  const [editValue, setEditValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

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
    if ((e.target as HTMLElement).closest('.terminal-card__close, .terminal-card__color-btn, .terminal-card__title, .terminal-card__title-input, .terminal-card__color-picker')) return

    // In hard focus, only allow drag from the header (body goes to xterm)
    if (focusMode === 'hard') {
      if (!(e.target as HTMLElement).closest('.terminal-card__header')) return
    }

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
      }

      if (dragging) {
        onMove(sessionId, startX + dx / currentZoom, startY + dy / currentZoom)
      }
    }

    const onMouseUp = () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)

      if (!dragging) {
        onHardFocus(sessionId)
      }
    }

    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
  }

  const handleMouseEnter = () => {
    onSoftFocus(sessionId)
  }

  const handleMouseLeave = (e: React.MouseEvent) => {
    // Ignore spurious mouseleave from pointer-events toggling on .xterm.
    // If relatedTarget is still inside the card, the mouse hasn't truly left.
    if (cardRef.current && e.relatedTarget instanceof Node && cardRef.current.contains(e.relatedTarget)) {
      return
    }
    onUnfocus()
  }

  const focusClass =
    focusMode === 'hard' ? 'terminal-card--hard' :
    focusMode === 'soft' ? 'terminal-card--soft' : ''

  return (
    <div
      ref={cardRef}
      data-session-id={sessionId}
      className={`terminal-card ${focusClass}`}
      style={{
        position: 'absolute',
        left: x,
        top: y,
        width,
        height,
        zIndex
      }}
      onMouseDown={handleMouseDown}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <div
        className="terminal-card__header"
        style={headerColor ? {
          backgroundColor: headerColor,
          color: contrastForeground(headerColor),
          borderBottomColor: headerColor
        } : undefined}
      >
        {editing ? (
          <input
            ref={inputRef}
            className="terminal-card__title-input"
            value={editValue}
            style={headerColor ? { color: contrastForeground(headerColor) } : undefined}
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
        ) : (
          <span
            className="terminal-card__title"
            style={headerColor ? { color: contrastForeground(headerColor) } : undefined}
            onClick={(e) => {
              e.stopPropagation()
              setEditValue(name || sessionId.slice(0, 8))
              setEditing(true)
            }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            {name || sessionId.slice(0, 8)}
          </span>
        )}
        {shellTitle && (
          <span
            className="terminal-card__shell-title"
            style={headerColor ? { color: contrastForeground(headerColor), opacity: 0.6 } : undefined}
          >
            {shellTitle}
          </span>
        )}
        <div className="terminal-card__actions">
          <div style={{ position: 'relative' }} ref={pickerRef}>
            <button
              className="terminal-card__color-btn"
              title="Header color"
              style={headerColor ? { color: contrastForeground(headerColor) } : undefined}
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
                {PRESET_COLORS.map((color) => (
                  <button
                    key={color}
                    className="terminal-card__color-swatch"
                    style={{ backgroundColor: color }}
                    onClick={(e) => {
                      e.stopPropagation()
                      onColorChange(sessionId, color)
                      setPickerOpen(false)
                    }}
                  />
                ))}
              </div>
            )}
          </div>
          <button
            className="terminal-card__close"
            style={headerColor ? { color: contrastForeground(headerColor) } : undefined}
            onClick={(e) => { e.stopPropagation(); onClose(sessionId) }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            &times;
          </button>
        </div>
      </div>
      <div className="terminal-card__body" ref={containerRef} />
    </div>
  )
}
