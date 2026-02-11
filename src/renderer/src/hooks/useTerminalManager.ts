import { useCallback, useEffect, useState } from 'react'
import { TERMINAL_WIDTH, TERMINAL_HEIGHT, GRID_GAP, GRID_COLS } from '../lib/constants'

export interface TerminalInfo {
  sessionId: string
  x: number
  y: number
}

function gridPosition(index: number): { x: number; y: number } {
  const col = index % GRID_COLS
  const row = Math.floor(index / GRID_COLS)
  return {
    x: col * (TERMINAL_WIDTH + GRID_GAP),
    y: row * (TERMINAL_HEIGHT + GRID_GAP)
  }
}

export function useTerminalManager() {
  const [terminals, setTerminals] = useState<TerminalInfo[]>([])

  // On mount, discover existing sessions from the server
  useEffect(() => {
    let cancelled = false

    const restore = async () => {
      try {
        const sessions = await window.api.pty.list()
        if (cancelled || sessions.length === 0) return

        const restored: TerminalInfo[] = sessions.map((s, i) => ({
          sessionId: s.sessionId,
          ...gridPosition(i)
        }))

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

  const addTerminal = useCallback(async () => {
    const sessionId = await window.api.pty.create()

    setTerminals((prev) => {
      const pos = gridPosition(prev.length)
      return [...prev, { sessionId, ...pos }]
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

  return { terminals, addTerminal, removeTerminal, moveTerminal }
}
