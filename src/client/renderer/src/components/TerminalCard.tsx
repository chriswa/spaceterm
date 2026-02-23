import { useCallback, useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { SearchAddon } from '@xterm/addon-search'
import { CELL_WIDTH, CELL_HEIGHT, BODY_PADDING_TOP, terminalPixelSize } from '../lib/constants'
import { classifyWheelEvent } from '../lib/wheel-gesture'
import type { ColorPreset } from '../lib/color-presets'
import type { Camera } from '../lib/camera'
import type { ArchivedNode, TerminalSessionEntry } from '../../../../shared/state'
import type { SnapshotMessage } from '../../../../shared/protocol'
import { XTERM_THEME, DEFAULT_BG } from '../../../../shared/theme'
import { TerminalTitleBarContent } from './TerminalTitleBarContent'
import { TerminalSearchBar } from './TerminalSearchBar'
import { CardShell } from './CardShell'
import { useReparentStore } from '../stores/reparentStore'
import { useHoveredCardStore } from '../stores/hoveredCardStore'
import { showToast } from '../lib/toast'
import { saveTerminalScroll, loadTerminalScroll, clearTerminalScroll, consumeScrollRestore } from '../lib/focus-storage'
import crabIcon from '../assets/crab.png'
import { deriveCrabAppearance, CRAB_COLORS } from '../lib/crab-nav'
import { useCrabDance } from '../lib/crab-dance'
import { angleBorderColor } from '../lib/angle-color'

function cleanTerminalCopy(raw: string): string {
  // Strip box-drawing border characters (│, ─, ╭, etc.) from line edges, then trailing whitespace
  let lines = raw.split('\n').map(l =>
    l.replace(/^[\u2500-\u257F]+ ?/, '').replace(/ *[\u2500-\u257F]+$/, '').trimEnd()
  )

  // Detect Claude Code output pattern: "⏺ " prefix, subsequent lines blank or 2+ space indented
  if (lines.length > 0 && lines[0].startsWith('⏺ ')) {
    const rest = lines.slice(1)
    const isClaude = rest.every(l => l === '' || l.startsWith('  '))
    if (isClaude) {
      lines[0] = lines[0].slice('⏺ '.length)
      lines = [lines[0], ...rest.map(l => l === '' ? '' : l.slice(2))]
    }
  }

  // Dedent: strip common leading whitespace
  const indents = lines.filter(l => l.length > 0).map(l => l.match(/^ */)![0].length)
  const minIndent = indents.length > 0 ? Math.min(...indents) : 0
  if (minIndent > 0) {
    lines = lines.map(l => l.length > 0 ? l.slice(minIndent) : l)
  }

  return lines.join('\n')
}

const DRAG_THRESHOLD = 5
const SNAPSHOT_FONT = '14px Menlo, Monaco, "Courier New", monospace'
const SNAPSHOT_BOLD_FONT = 'bold 14px Menlo, Monaco, "Courier New", monospace'

const darkenHex = (hex: string, amount: number): string => {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  const f = 1 - amount
  return '#' + [r, g, b].map(c => Math.round(c * f).toString(16).padStart(2, '0')).join('')
}

export const terminalSelectionGetters = new Map<string, () => string>()
export const terminalSearchOpeners = new Map<string, () => void>()
export const terminalSearchClosers = new Map<string, () => boolean>()
export const terminalPlanJumpers = new Map<string, () => boolean>()


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
  resolvedPreset?: ColorPreset
  shellTitle?: string
  shellTitleHistory?: string[]
  cwd?: string
  focused: boolean
  selected: boolean
  anyNodeFocused: boolean
  claudeStatusUnread?: boolean
  scrollMode: boolean
  onFocus: (id: string) => void
  onUnfocus: () => void
  onDisableScrollMode: () => void
  onClose: (id: string) => void
  onMove: (id: string, x: number, y: number, metaKey?: boolean) => void
  onResize: (id: string, cols: number, rows: number) => void
  onRename: (id: string, name: string) => void
  archivedChildren: ArchivedNode[]
  onColorChange: (id: string, color: string) => void
  onUnarchive: (parentNodeId: string, archivedNodeId: string) => void
  onArchiveDelete: (parentNodeId: string, archivedNodeId: string) => void
  onOpenArchiveSearch: (nodeId: string) => void
  claudeSessionHistory?: ClaudeSessionEntry[]
  claudeState?: string
  claudeModel?: string
  onExit?: (id: string, exitCode: number) => void
  onNodeReady?: (nodeId: string, bounds: { x: number; y: number; width: number; height: number }) => void
  onDragStart?: (id: string, solo?: boolean, ctrlAtStart?: boolean, shiftAtStart?: boolean) => void
  onDragEnd?: (id: string) => void
  onStartReparent?: (id: string) => void
  onReparentTarget?: (id: string) => void
  terminalSessions?: TerminalSessionEntry[]
  onSessionRevive?: (nodeId: string, session: TerminalSessionEntry) => void
  onFork?: (id: string) => void
  onExtraCliArgs?: (nodeId: string, extraCliArgs: string) => void
  extraCliArgs?: string
  onAddNode?: (parentNodeId: string, type: import('./AddNodeBody').AddNodeType) => void
  cameraRef: React.RefObject<Camera>
}

export function TerminalCard({
  id, sessionId, x, y, cols, rows, zIndex, zoom, name, colorPresetId, resolvedPreset, shellTitle, shellTitleHistory, cwd, focused, selected, anyNodeFocused, claudeStatusUnread, scrollMode,
  onFocus, onUnfocus, onDisableScrollMode, onClose, onMove, onResize, onRename, archivedChildren, onColorChange, onUnarchive, onArchiveDelete, onOpenArchiveSearch,
  claudeSessionHistory, claudeState, claudeModel, onExit, onNodeReady,
  onDragStart, onDragEnd, onStartReparent, onReparentTarget,
  terminalSessions, onSessionRevive, onFork, onExtraCliArgs, extraCliArgs, onAddNode, cameraRef
}: TerminalCardProps) {
  const preset = resolvedPreset
  const cardRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const wheelAccRef = useRef({ dx: 0, dy: 0, t: 0 })
  const pixelOffsetRef = useRef(0)
  const searchAddonRef = useRef<SearchAddon | null>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const snapshotRef = useRef<SnapshotMessage | null>(null)
  const autoJumpedRef = useRef(false)
  const behindCrabRef = useRef<HTMLDivElement>(null)

  // Keep current props in refs for event handlers
  const propsRef = useRef({ x, y, zoom, focused, id, sessionId, onDisableScrollMode, onExit, onNodeReady })
  propsRef.current = { x, y, zoom, focused, id, sessionId, onDisableScrollMode, onExit, onNodeReady }

  const [claudeContextPercent, setClaudeContextPercent] = useState<number | undefined>(undefined)
  const [claudeSessionLineCount, setClaudeSessionLineCount] = useState<number | undefined>(undefined)
  const [xtermReady, setXtermReady] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [planCacheFiles, setPlanCacheFiles] = useState<string[]>([])
  const searchOpenRef = useRef(false)

  // Reset when unfocusing so it's always false on next focus
  useEffect(() => {
    if (!focused) {
      setXtermReady(false)
      setSearchOpen(false)
      searchOpenRef.current = false
    }
  }, [focused])

  const closeSearch = useCallback(() => {
    setSearchOpen(false)
    searchOpenRef.current = false
    searchAddonRef.current?.clearDecorations()
    terminalRef.current?.focus()
  }, [])

  const scrollModeRef = useRef(false)
  scrollModeRef.current = scrollMode

  // Derive pixel size from cols/rows (non-Claude terminals have no footer)
  const hasFooter = !!(claudeSessionHistory && claudeSessionHistory.length > 0)
  const { width, height } = terminalPixelSize(cols, rows, hasFooter)

  // Mount terminal (only when focused)
  useEffect(() => {
    if (!focused) return
    if (!containerRef.current) return

    const term = new Terminal({
      fontSize: 14,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      theme: {
        ...XTERM_THEME,
        background: preset?.terminalBg ?? DEFAULT_BG,
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
        window.api.log(`[LinkHandler] activate: url=${url} metaKey=${event.metaKey} button=${event.button}`)
        if (event.metaKey) {
          window.api.openExternal(url)
        }
      },
      hover: (_event, url) => {
        window.api.log(`[LinkHandler] hover: url=${url}`)
      },
      leave: (_event, url) => {
        window.api.log(`[LinkHandler] leave: url=${url}`)
      },
      allowNonHttpProtocols: true
    }
    term.loadAddon(new Unicode11Addon())
    const searchAddon = new SearchAddon()
    term.loadAddon(searchAddon)
    searchAddonRef.current = searchAddon
    term.open(containerRef.current)
    term.unicode.activeVersion = '11'

    // Clean clipboard text on copy: strip trailing whitespace, Claude Code prefixes, and common indent
    const container = containerRef.current
    const handleCopy = (e: ClipboardEvent) => {
      const sel = term.getSelection()
      if (sel) {
        e.clipboardData?.setData('text/plain', cleanTerminalCopy(sel))
        e.preventDefault()
      }
    }
    container.addEventListener('copy', handleCopy)

    // Pixel-smooth scroll: grab screen element for CSS transforms
    const screenEl = containerRef.current!.querySelector('.xterm-screen') as HTMLElement
    screenEl.style.willChange = 'transform'

    // Set absolute scroll position with sub-line pixel precision.
    // Clamps to valid range, updates xterm viewport + pixelOffsetRef + CSS transform.
    const applyPixelScroll = (pixels: number) => {
      const maxPixels = (term.buffer.active.length - term.rows) * CELL_HEIGHT
      const clamped = Math.max(0, Math.min(pixels, maxPixels))
      const line = Math.floor(clamped / CELL_HEIGHT)
      const remainder = clamped - line * CELL_HEIGHT
      term.scrollToLine(line)
      pixelOffsetRef.current = remainder
      screenEl.style.transform = remainder !== 0
        ? `translateY(${-remainder}px)`
        : ''
    }

    // Debounced scroll position save for reload persistence
    let scrollSaveTimer: ReturnType<typeof setTimeout> | undefined
    const saveScrollDebounced = () => {
      if (scrollSaveTimer !== undefined) clearTimeout(scrollSaveTimer)
      scrollSaveTimer = setTimeout(() => {
        const pixels = term.buffer.active.viewportY * CELL_HEIGHT + pixelOffsetRef.current
        saveTerminalScroll(sessionId, pixels)
      }, 300)
    }

    // Custom wheel handler: controls both xterm scroll processing AND
    // canvas propagation. Attached once at mount — no race condition
    // since propsRef is updated synchronously during render.
    term.attachCustomWheelEventHandler((ev) => {
      if (propsRef.current.focused) {
        // Scroll mode off: all events go to canvas
        if (!scrollModeRef.current) {
          return false
        }

        // Classify gesture: pinch or horizontal → escape to canvas
        const gesture = classifyWheelEvent(wheelAccRef.current, ev)
        if (gesture !== 'vertical') {
          scrollModeRef.current = false
          propsRef.current.onDisableScrollMode()
          return false
        }

        // Pixel-smooth vertical scroll: we handle it ourselves
        ev.preventDefault()
        ev.stopPropagation()

        let deltaPixels = ev.deltaY
        if (ev.deltaMode === WheelEvent.DOM_DELTA_LINE) deltaPixels *= CELL_HEIGHT
        if (ev.deltaMode === WheelEvent.DOM_DELTA_PAGE) deltaPixels *= CELL_HEIGHT * term.rows

        const currentPixels = term.buffer.active.viewportY * CELL_HEIGHT + pixelOffsetRef.current
        applyPixelScroll(currentPixels + deltaPixels)
        saveScrollDebounced()

        return false
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
    let readyTimeout: ReturnType<typeof setTimeout> | undefined
    let onRenderDisposable: { dispose(): void } | undefined

    const markReady = () => {
      if (readyTimeout !== undefined) clearTimeout(readyTimeout)
      if (onRenderDisposable) onRenderDisposable.dispose()
      readyTimeout = undefined
      onRenderDisposable = undefined
      setXtermReady(true)
    }

    // Restore saved scroll position after scrollback is loaded — only when App marked this session during reload restore
    const restoreScroll = () => {
      if (!consumeScrollRestore(sessionId)) {
        clearTerminalScroll(sessionId)
        return
      }
      const savedScroll = loadTerminalScroll(sessionId)
      if (savedScroll !== null) {
        const maxPixels = (term.buffer.active.length - term.rows) * CELL_HEIGHT
        if (savedScroll <= maxPixels) {
          applyPixelScroll(savedScroll)
        }
      }
    }

    // Safety timeout: if onRender never fires, unblock after 500ms
    readyTimeout = setTimeout(markReady, 500)

    window.api.pty.attach(sessionId).then((result) => {
      if (cancelled) return
      if (result.scrollback.length > 0) {
        term.write(result.scrollback, () => {
          // Parsing complete — wait for the next render frame to mark ready
          onRenderDisposable = term.onRender(() => {
            markReady()
            restoreScroll()
          })
        })
      } else {
        markReady()
      }
      if (result.claudeContextPercent !== undefined) {
        setClaudeContextPercent(result.claudeContextPercent)
      }
    }).catch(() => {
      // Session may not exist on server — still unblock so we don't get stuck on snapshot
      markReady()
    })

    // Wire up IPC — use sessionId for all PTY operations
    const cleanupData = window.api.pty.onData(sessionId, (data) => {
      term.write(data)
    })

    const cleanupExit = window.api.pty.onExit(sessionId, (exitCode) => {
      propsRef.current.onExit?.(propsRef.current.id, exitCode)
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
    terminalSearchOpeners.set(id, () => {
      if (searchOpenRef.current) {
        const input = cardRef.current?.querySelector('.terminal-search-bar__input') as HTMLInputElement | null
        input?.focus()
        input?.select()
        return
      }
      setSearchOpen(true)
      searchOpenRef.current = true
    })
    terminalSearchClosers.set(id, () => {
      if (searchOpenRef.current) {
        setSearchOpen(false)
        searchOpenRef.current = false
        searchAddon.clearDecorations()
        term.focus()
        return true
      }
      return false
    })
    terminalPlanJumpers.set(id, () => {
      const buffer = term.buffer.active
      for (let i = buffer.length - 1; i >= 0; i--) {
        const line = buffer.getLine(i)
        if (line && line.translateToString().includes("Here is Claude's plan:")) {
          const startPixels = buffer.viewportY * CELL_HEIGHT + pixelOffsetRef.current
          const targetPixels = i * CELL_HEIGHT
          const distance = Math.abs(targetPixels - startPixels)
          const duration = 1000 * (1 - 1 / (1 + distance / 1067))
          if (duration < 16) {
            applyPixelScroll(targetPixels)
            return true
          }
          const startTime = performance.now()
          let lastLine = Math.floor(startPixels / CELL_HEIGHT)
          const animate = () => {
            if (cancelled) return
            const t = Math.min((performance.now() - startTime) / duration, 1)
            const eased = 1 - Math.pow(1 - t, 3)
            const pixels = startPixels + (targetPixels - startPixels) * eased
            const maxPixels = (term.buffer.active.length - term.rows) * CELL_HEIGHT
            const clamped = Math.max(0, Math.min(pixels, maxPixels))
            const line = Math.floor(clamped / CELL_HEIGHT)
            const remainder = clamped - line * CELL_HEIGHT
            if (line !== lastLine) {
              // Line boundary crossed: update viewport but skip CSS transform
              // this frame. xterm's RenderDebouncer defers row rendering to its
              // own rAF, so setting the transform now would apply it to stale
              // rows for one frame. Leaving the old transform in place keeps
              // the visual position stable until xterm renders.
              term.scrollToLine(line)
              lastLine = line
            } else {
              pixelOffsetRef.current = remainder
              screenEl.style.transform = remainder !== 0
                ? `translateY(${-remainder}px)`
                : ''
            }
            if (t < 1) {
              requestAnimationFrame(animate)
            } else {
              // Final frame: snap to exact target
              applyPixelScroll(targetPixels)

              // Flash highlight on the plan heading text
              const planText = "Here is Claude's plan:"
              const lineContent = buffer.getLine(i)?.translateToString() || ''
              const col = lineContent.indexOf(planText)
              const marker = term.registerMarker(i - (buffer.baseY + buffer.cursorY))
              if (marker) {
                const decoration = term.registerDecoration({
                  marker,
                  x: col >= 0 ? col : 0,
                  width: col >= 0 ? planText.length : term.cols,
                  height: 1,
                })
                decoration?.onRender((el) => {
                  el.classList.add('plan-jump-flash')
                })
                setTimeout(() => decoration?.dispose(), 490)
              }
            }
          }
          requestAnimationFrame(animate)
          return true
        }
      }
      return false
    })

    return () => {
      cancelled = true
      // Flush scroll position before teardown
      const finalPixels = term.buffer.active.viewportY * CELL_HEIGHT + pixelOffsetRef.current
      saveTerminalScroll(sessionId, finalPixels)
      if (scrollSaveTimer !== undefined) clearTimeout(scrollSaveTimer)
      pixelOffsetRef.current = 0
      container.removeEventListener('copy', handleCopy)
      if (readyTimeout !== undefined) clearTimeout(readyTimeout)
      if (onRenderDisposable) onRenderDisposable.dispose()
      terminalSelectionGetters.delete(id)
      terminalSearchOpeners.delete(id)
      terminalSearchClosers.delete(id)
      terminalPlanJumpers.delete(id)
      searchAddonRef.current = null
      cleanupData()
      cleanupExit()
      term.dispose()
    }
  }, [focused, sessionId])

  // Subscribe to claude context updates (always, not just when focused)
  useEffect(() => {
    const cleanup = window.api.pty.onClaudeContext(sessionId, (percent) => {
      setClaudeContextPercent(percent)
    })
    // Also fetch current value on mount
    window.api.pty.attach(sessionId).then((result) => {
      if (result.claudeContextPercent !== undefined) {
        setClaudeContextPercent(result.claudeContextPercent)
      }
      if (result.claudeSessionLineCount !== undefined) {
        setClaudeSessionLineCount(result.claudeSessionLineCount)
      }
    }).catch(() => {})
    return cleanup
  }, [sessionId])

  // Subscribe to claude session line count updates (always, not just when focused)
  useEffect(() => {
    return window.api.pty.onClaudeSessionLineCount(sessionId, (lineCount) => {
      setClaudeSessionLineCount(lineCount)
    })
  }, [sessionId])

  // Subscribe to plan cache updates (always, not just when focused)
  useEffect(() => {
    return window.api.pty.onPlanCacheUpdate(sessionId, (_count, files) => {
      setPlanCacheFiles(files)
    })
  }, [sessionId])

  // Tint xterm background to match color preset
  useEffect(() => {
    const term = terminalRef.current
    if (!term) return
    const bg = preset?.terminalBg ?? DEFAULT_BG
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

  // Auto-scroll to plan when focusing a terminal in waiting_plan state
  useEffect(() => {
    if (!focused) {
      autoJumpedRef.current = false
      return
    }
    if (xtermReady && claudeState === 'waiting_plan' && !autoJumpedRef.current) {
      autoJumpedRef.current = true
      terminalPlanJumpers.get(id)?.()
    }
  }, [focused, xtermReady, claudeState, id])

  // Notify parent when focused node size is known (mount or resize)
  useEffect(() => {
    if (!focused) return
    const { width, height } = terminalPixelSize(cols, rows)
    propsRef.current.onNodeReady?.(id, { x: propsRef.current.x - width / 2, y: propsRef.current.y - height / 2, width, height })
  }, [focused, cols, rows, id])

  // --- Snapshot mode (only when unfocused) ---

  const paintCanvas = (snapshot: SnapshotMessage) => {
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

    const bgColor = preset?.terminalBg ?? DEFAULT_BG
    ctx.fillStyle = bgColor
    ctx.fillRect(0, 0, cw, ch)

    for (let y = 0; y < snapshot.lines.length; y++) {
      const row = snapshot.lines[y]
      let xOffset = 0

      for (const span of row) {
        const spanWidth = span.text.length * CELL_WIDTH

        if (span.bg !== bgColor && span.bg !== DEFAULT_BG) {
          ctx.fillStyle = span.bg
          ctx.fillRect(xOffset, y * CELL_HEIGHT, spanWidth, CELL_HEIGHT)
        }

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
      paintCanvas(snapshot)
    })

    return () => {
      cleanup()
    }
  }, [focused, sessionId])

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

  const dragOccurredRef = useRef(false)

  // Mousedown handler: drag-to-move or click-to-hard-focus
  const handleMouseDown = (e: React.MouseEvent) => {
    // Don't interfere with header buttons or color picker
    if ((e.target as HTMLElement).closest('.node-titlebar__close, .node-titlebar__color-btn, .node-titlebar__color-picker, .node-titlebar__archive-btn, .node-titlebar__sessions-btn, .node-titlebar__reparent-btn, .archive-body, .terminal-search-bar')) return

    const isInteractiveTitle = !!(e.target as HTMLElement).closest('.terminal-card__left-area')

    const isHeader = !!(e.target as HTMLElement).closest('.card-shell__head')

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
    const currentZoom = cameraRef.current.z
    const ctrlAtStart = e.ctrlKey
    let dragging = false

    const onMouseMove = (ev: MouseEvent) => {
      const dx = ev.clientX - startScreenX
      const dy = ev.clientY - startScreenY

      if (!dragging && Math.abs(dx) + Math.abs(dy) > DRAG_THRESHOLD) {
        dragging = true
        onDragStart?.(id, ev.metaKey, ctrlAtStart, ev.shiftKey)
        if (isInteractiveTitle && document.activeElement instanceof HTMLElement) {
          document.activeElement.blur()
        }
      }

      if (dragging && !bodyClickWhileFocused) {
        onMove(id, startX + dx / currentZoom, startY + dy / currentZoom, ev.metaKey)
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
      } else if (useReparentStore.getState().reparentingNodeId) {
        onReparentTarget?.(id)
      } else {
        onFocus(id)
      }
    }

    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
  }

  const focusClass = focused
    ? scrollMode
      ? 'terminal-card--focused terminal-card--scroll-mode'
      : 'terminal-card--focused'
    : selected ? 'terminal-card--selected' : ''
  const focusGlowColor = focused ? angleBorderColor(x, y, scrollMode ? 1.3 : 1) : undefined
  const crabAppearance = deriveCrabAppearance(claudeState, claudeStatusUnread ?? false, (claudeSessionHistory?.length ?? 0) > 0)
  useCrabDance(behindCrabRef, crabAppearance?.unviewed ?? false, 2.5)

  const claudeStateLabel = (state?: string): string => {
    switch (state) {
      case 'working': return 'Claude is working'
      case 'stuck': return 'Claude appears stuck'
      case 'waiting_permission': return 'Claude is awaiting permission'
      case 'waiting_question': return 'Claude is asking a question'
      case 'waiting_plan': return 'Claude is awaiting plan approval'
      default: return 'Claude is stopped'
    }
  }

  const pastSessions = terminalSessions ?? []
  const currentSessionIndex = terminalSessions ? terminalSessions.length - 1 : -1

  const lastClaudeSession = claudeSessionHistory && claudeSessionHistory.length > 0
    ? claudeSessionHistory[claudeSessionHistory.length - 1]
    : null

  const handleDiffPlans = planCacheFiles.length >= 2 ? () => {
    const [prev, curr] = planCacheFiles.slice(-2)
    window.api.diffFiles(prev, curr)
  } : undefined

  const reparentingNodeId = useReparentStore(s => s.reparentingNodeId)

  return (
    <CardShell
      nodeId={id}
      x={x - width / 2}
      y={y - height / 2}
      width={width}
      height={height}
      zIndex={zIndex}
      focused={focused}
      headVariant="visible"
      titleContent={
        <TerminalTitleBarContent
          name={name}
          shellTitleHistory={shellTitleHistory}
          preset={preset}
          id={id}
          isClaudeSurface={hasFooter}
          onRename={onRename}
          canStartEdit={() => !dragOccurredRef.current}
        />
      }
      headStyle={preset ? {
        backgroundColor: preset.titleBarBg,
        color: preset.titleBarFg,
        borderBottomColor: preset.titleBarBg
      } : undefined}
      preset={preset}
      archivedChildren={archivedChildren}
      pastSessions={pastSessions}
      currentSessionIndex={currentSessionIndex}
      onSessionRevive={onSessionRevive}
      onClose={onClose}
      onColorChange={onColorChange}
      onUnarchive={onUnarchive}
      onArchiveDelete={onArchiveDelete}
      onOpenArchiveSearch={onOpenArchiveSearch}
      onMouseDown={handleMouseDown}
      onStartReparent={onStartReparent}
      onFork={claudeSessionHistory && claudeSessionHistory.length > 0 ? onFork : undefined}
      onExtraCliArgs={claudeSessionHistory && claudeSessionHistory.length > 0 ? onExtraCliArgs : undefined}
      extraCliArgs={extraCliArgs}
      onDiffPlans={handleDiffPlans}
      onAddNode={onAddNode}
      isReparenting={reparentingNodeId === id}
      className={`terminal-card ${focusClass}`}
      style={focusGlowColor ? { borderColor: focusGlowColor, boxShadow: `0 0 4px ${focusGlowColor}` } : undefined}
      cardRef={cardRef}
      onMouseEnter={() => {
        if (reparentingNodeId) useReparentStore.getState().setHoveredNode(id)
        useHoveredCardStore.getState().setHoveredNode(id)
      }}
      onMouseLeave={() => {
        if (reparentingNodeId) useReparentStore.getState().setHoveredNode(null)
        useHoveredCardStore.getState().setHoveredNode(null)
      }}
      behindContent={
        crabAppearance ? (
          <div
            ref={behindCrabRef}
            className="terminal-card__crab-behind"
            style={{
              maskImage: `url(${crabIcon})`,
              WebkitMaskImage: `url(${crabIcon})`,
              backgroundColor: CRAB_COLORS[crabAppearance.color],
            }}
          />
        ) : undefined
      }
    >
      {searchOpen && searchAddonRef.current && (
        <TerminalSearchBar searchAddon={searchAddonRef.current} onClose={closeSearch} />
      )}
      <div className="terminal-card__body" ref={containerRef} style={{ display: focused ? undefined : 'none', flex: 'none', height: rows * CELL_HEIGHT + BODY_PADDING_TOP }} />
      <div style={
        !focused
          ? { position: 'relative' as const, padding: '2px 2px 0 2px', flex: 'none', height: rows * CELL_HEIGHT + BODY_PADDING_TOP }
          : xtermReady
            ? { display: 'none' }
            : { position: 'absolute' as const, inset: 0, top: BODY_PADDING_TOP, zIndex: 1, pointerEvents: 'none' as const, padding: '2px 2px 0 2px' }
      }>
        <canvas
          ref={canvasRef}
          style={{
            width: Math.ceil(cols * CELL_WIDTH),
            height: Math.ceil(rows * CELL_HEIGHT),
            display: 'block'
          }}
        />
      </div>
      {lastClaudeSession && (() => {
        const pct = Math.max(0, Math.min(100, claudeContextPercent ?? 100))
        const bright = preset ? preset.titleBarBg : '#181825'
        const dark = preset ? preset.terminalBg : '#181825'
        const abbrevCwd = cwd?.replace(/^\/Users\/[^/]+/, '~').replace(/^\/home\/[^/]+/, '~')
        const footerContent = (
          <>
            {abbrevCwd && <><span>{abbrevCwd}</span><span>&nbsp;|&nbsp;</span></>}
            <span>Surface ID:&nbsp;</span><span className="terminal-card__footer-id" onClick={(e) => {
              e.stopPropagation()
              let text = `${new Date().toISOString()} Surface ID: ${id}`
              if (lastClaudeSession) text += ` Claude session ID: ${lastClaudeSession.claudeSessionId}`
              text += ` Claude State: ${claudeState ?? 'stopped'} (${claudeStatusUnread ? 'unread' : 'read'})`
              navigator.clipboard.writeText(text)
              showToast(`Copied to clipboard: ${text}`)
            }} onMouseDown={(e) => e.stopPropagation()}>{id.slice(0, 8)}</span>
            <span>&nbsp;|&nbsp;Claude session ID:&nbsp;</span>
            <span className="terminal-card__footer-id" onClick={(e) => {
              e.stopPropagation()
              const text = `${new Date().toISOString()} Surface ID: ${id} Claude session ID: ${lastClaudeSession.claudeSessionId} Claude State: ${claudeState ?? 'stopped'} (${claudeStatusUnread ? 'unread' : 'read'})`
              navigator.clipboard.writeText(text)
              showToast(`Copied to clipboard: ${text}`)
            }} onMouseDown={(e) => e.stopPropagation()}>{lastClaudeSession.claudeSessionId.slice(0, 8)}</span>
            {claudeSessionLineCount != null && <span>&nbsp;({claudeSessionLineCount})</span>}
            <span>&nbsp;|&nbsp;</span>
            <span>{claudeStateLabel(claudeState)}</span>
            {claudeModel && <><span>&nbsp;|&nbsp;</span><span>{claudeModel}</span></>}
            {claudeContextPercent != null && (
              <span className="terminal-card__footer-context">Remaining context: {claudeContextPercent.toFixed(2)}%</span>
            )}
          </>
        )
        return (
      <div className="terminal-card__footer" style={{ backgroundColor: dark, borderTopColor: preset ? preset.titleBarBg : undefined }}>
        <span className="terminal-card__footer-content terminal-card__footer-content--light" style={{ color: bright }}>
          {footerContent}
        </span>
        <div className="terminal-card__footer-healthbar" style={{ width: `${pct}%`, backgroundColor: bright }} />
        <span className="terminal-card__footer-content terminal-card__footer-content--dark" style={{ color: preset ? preset.titleBarFg : undefined, clipPath: `inset(0 ${100 - pct}% 0 0)` }}>
          {footerContent}
        </span>
      </div>
        )
      })()}
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
    </CardShell>
  )
}
