import { useCallback, useEffect, useRef, useState } from 'react'
import { DEFAULT_COLS, DEFAULT_ROWS, GRID_GAP, GRID_COLS } from '../lib/constants'
import { terminalPixelSize } from '../lib/constants'

export interface TerminalInfo {
  sessionId: string
  x: number
  y: number
  zIndex: number
  cols: number
  rows: number
  name?: string
  headerColor?: string
}

function gridPosition(index: number): { x: number; y: number } {
  const { width, height } = terminalPixelSize(DEFAULT_COLS, DEFAULT_ROWS)
  const col = index % GRID_COLS
  const row = Math.floor(index / GRID_COLS)
  return {
    x: col * (width + GRID_GAP),
    y: row * (height + GRID_GAP)
  }
}

interface UseTerminalManagerOptions {
  savedTerminals?: Record<string, { x: number; y: number; zIndex: number; name?: string; headerColor?: string }>
  initialNextZIndex?: number
}

export function useTerminalManager(options?: UseTerminalManagerOptions) {
  const [terminals, setTerminals] = useState<TerminalInfo[]>([])
  const nextZIndex = useRef<number>(options?.initialNextZIndex ?? 1)

  // On mount, discover existing sessions from the server
  useEffect(() => {
    let cancelled = false

    const restore = async () => {
      try {
        const sessions = await window.api.pty.list()
        if (cancelled || sessions.length === 0) return

        const saved = options?.savedTerminals
        const restored: TerminalInfo[] = sessions.map((s, i) => {
          if (saved && saved[s.sessionId]) {
            const entry = saved[s.sessionId]
            return {
              sessionId: s.sessionId,
              x: entry.x,
              y: entry.y,
              zIndex: entry.zIndex,
              cols: s.cols,
              rows: s.rows,
              name: entry.name,
              headerColor: entry.headerColor
            }
          }
          return { sessionId: s.sessionId, ...gridPosition(i), zIndex: 0, cols: s.cols, rows: s.rows }
        })

        setTerminals(restored)
      } catch {
        // Server not connected yet — will restore on reconnect
      }
    }

    restore()

    return () => {
      cancelled = true
    }
  }, [])

  const addTerminal = useCallback(async (position?: { x: number; y: number }) => {
    const { sessionId, cols, rows } = await window.api.pty.create()
    const z = nextZIndex.current++

    setTerminals((prev) => {
      const pos = position ?? gridPosition(prev.length)
      return [...prev, { sessionId, ...pos, zIndex: z, cols, rows }]
    })
  }, [])

  const removeTerminal = useCallback(async (sessionId: string) => {
    await window.api.pty.destroy(sessionId)
    setTerminals((prev) => prev.filter((t) => t.sessionId !== sessionId))
  }, [])

  const moveTerminal = useCallback((sessionId: string, x: number, y: number) => {
    setTerminals((prev) =>
      prev.map((t) => (t.sessionId === sessionId ? { ...t, x, y } : t))
    )
  }, [])

  const resizeTerminal = useCallback((sessionId: string, cols: number, rows: number) => {
    setTerminals((prev) =>
      prev.map((t) => (t.sessionId === sessionId ? { ...t, cols, rows } : t))
    )
  }, [])

  const bringToFront = useCallback((sessionId: string) => {
    const z = nextZIndex.current++
    setTerminals((prev) =>
      prev.map((t) => (t.sessionId === sessionId ? { ...t, zIndex: z } : t))
    )
  }, [])

  const renameTerminal = useCallback((sessionId: string, name: string) => {
    setTerminals((prev) =>
      prev.map((t) => (t.sessionId === sessionId ? { ...t, name } : t))
    )
  }, [])

  const setTerminalColor = useCallback((sessionId: string, headerColor: string) => {
    setTerminals((prev) =>
      prev.map((t) => (t.sessionId === sessionId ? { ...t, headerColor } : t))
    )
  }, [])

  return { terminals, addTerminal, removeTerminal, moveTerminal, resizeTerminal, bringToFront, renameTerminal, setTerminalColor, nextZIndex }
}
