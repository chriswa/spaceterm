import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { CELL_WIDTH, CELL_HEIGHT, terminalPixelSize } from '../lib/constants'

const DRAG_THRESHOLD = 5

interface TerminalCardProps {
  sessionId: string
  x: number
  y: number
  cols: number
  rows: number
  zIndex: number
  zoom: number
  focusMode: 'none' | 'soft' | 'hard'
  onSoftFocus: (sessionId: string) => void
  onHardFocus: (sessionId: string) => void
  onUnfocus: () => void
  onClose: (sessionId: string) => void
  onMove: (sessionId: string, x: number, y: number) => void
  onResize: (sessionId: string, cols: number, rows: number) => void
}

export function TerminalCard({
  sessionId, x, y, cols, rows, zIndex, zoom, focusMode,
  onSoftFocus, onHardFocus, onUnfocus, onClose, onMove, onResize
}: TerminalCardProps) {
  const cardRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)

  // Keep current props in refs for event handlers
  const propsRef = useRef({ x, y, zoom, focusMode, sessionId })
  propsRef.current = { x, y, zoom, focusMode, sessionId }

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

    // Custom wheel handler: controls both xterm scroll processing AND
    // canvas propagation. Attached once at mount — no race condition
    // since propsRef is updated synchronously during render.
    term.attachCustomWheelEventHandler((ev) => {
      if (propsRef.current.focusMode === 'hard') {
        // Prevent the event from bubbling to the canvas (no pan/zoom)
        ev.stopPropagation()
        // Let xterm handle the scroll
        return true
      }
      // Block xterm's scroll processing in soft/none focus
      return false
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

  // Mousedown handler: drag-to-move or click-to-hard-focus
  const handleMouseDown = (e: React.MouseEvent) => {
    // Don't interfere with header buttons
    if ((e.target as HTMLElement).closest('.terminal-card__close, .terminal-card__reset-size')) return

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
      <div className="terminal-card__header">
        <span className="terminal-card__title">{sessionId.slice(0, 8)}</span>
        <div className="terminal-card__actions">
          <button
            className="terminal-card__reset-size"
            title="Reset to 160×45"
            onClick={(e) => {
              e.stopPropagation()
              onResize(sessionId, 160, 45)
            }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            ⬡
          </button>
          <button
            className="terminal-card__close"
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
