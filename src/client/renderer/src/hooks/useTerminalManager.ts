import { useCallback, useEffect, useRef, useState } from 'react'
import { DEFAULT_COLS, DEFAULT_ROWS, GRID_GAP, GRID_COLS, MARKDOWN_DEFAULT_WIDTH, MARKDOWN_DEFAULT_HEIGHT } from '../lib/constants'
import { terminalPixelSize } from '../lib/constants'

export interface TerminalInfo {
  sessionId: string
  parentId: string
  x: number
  y: number
  zIndex: number
  cols: number
  rows: number
  name?: string
  colorPresetId?: string
  shellTitle?: string
  shellTitleHistory?: string[]
  cwd?: string
  claudeSessionHistory?: ClaudeSessionEntry[]
}

export interface MarkdownInfo {
  id: string
  parentId: string
  x: number
  y: number
  zIndex: number
  width: number
  height: number
  content: string
  name?: string
  colorPresetId?: string
}

export interface RemnantInfo {
  sessionId: string
  parentId: string
  x: number
  y: number
  zIndex: number
  name?: string
  colorPresetId?: string
  shellTitleHistory?: string[]
  cwd?: string
  claudeSessionHistory?: ClaudeSessionEntry[]
  exitCode: number
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
  savedTerminals?: Record<string, { x: number; y: number; zIndex: number; name?: string; colorPresetId?: string; parentId?: string }>
  savedRemnants?: RemnantInfo[]
  savedMarkdowns?: MarkdownInfo[]
  initialNextZIndex?: number
}

export function useTerminalManager(options?: UseTerminalManagerOptions) {
  const [terminals, setTerminals] = useState<TerminalInfo[]>([])
  const [remnants, setRemnants] = useState<RemnantInfo[]>(options?.savedRemnants ?? [])
  const remnantRef = useRef<RemnantInfo[]>(options?.savedRemnants ?? [])
  remnantRef.current = remnants
  const [markdowns, setMarkdowns] = useState<MarkdownInfo[]>(options?.savedMarkdowns ?? [])
  const markdownRef = useRef<MarkdownInfo[]>(options?.savedMarkdowns ?? [])
  markdownRef.current = markdowns
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
              parentId: entry.parentId ?? 'root',
              x: entry.x,
              y: entry.y,
              zIndex: entry.zIndex,
              cols: s.cols,
              rows: s.rows,
              name: entry.name,
              colorPresetId: entry.colorPresetId
            }
          }
          return { sessionId: s.sessionId, parentId: 'root', ...gridPosition(i), zIndex: 0, cols: s.cols, rows: s.rows, colorPresetId: 'default' }
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

  const addTerminal = useCallback(async (position: { x: number; y: number }, parentId: string, options?: CreateOptions) => {
    const result = await window.api.pty.create(options)
    const z = nextZIndex.current++

    setTerminals((prev) => {
      return [...prev, { sessionId: result.sessionId, parentId, ...position, zIndex: z, cols: result.cols, rows: result.rows, cwd: result.cwd, colorPresetId: 'default' }]
    })

    return { sessionId: result.sessionId, cols: result.cols, rows: result.rows }
  }, [])

  const removeTerminal = useCallback(async (sessionId: string) => {
    await window.api.pty.destroy(sessionId)
    setTerminals((prev) => {
      const removed = prev.find((t) => t.sessionId === sessionId)
      const newParent = removed?.parentId ?? 'root'
      return prev
        .filter((t) => t.sessionId !== sessionId)
        .map((t) => t.parentId === sessionId ? { ...t, parentId: newParent } : t)
    })
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

  const setTerminalColor = useCallback((sessionId: string, colorPresetId: string) => {
    setTerminals((prev) =>
      prev.map((t) => (t.sessionId === sessionId ? { ...t, colorPresetId } : t))
    )
  }, [])

  const setShellTitle = useCallback((sessionId: string, shellTitle: string) => {
    setTerminals((prev) =>
      prev.map((t) => (t.sessionId === sessionId ? { ...t, shellTitle } : t))
    )
  }, [])

  const setShellTitleHistory = useCallback((sessionId: string, shellTitleHistory: string[]) => {
    setTerminals((prev) =>
      prev.map((t) => (t.sessionId === sessionId ? { ...t, shellTitleHistory } : t))
    )
  }, [])

  const setCwd = useCallback((sessionId: string, cwd: string) => {
    setTerminals((prev) =>
      prev.map((t) => (t.sessionId === sessionId ? { ...t, cwd } : t))
    )
  }, [])

  const setClaudeSessionHistory = useCallback((sessionId: string, claudeSessionHistory: ClaudeSessionEntry[]) => {
    setTerminals((prev) =>
      prev.map((t) => (t.sessionId === sessionId ? { ...t, claudeSessionHistory } : t))
    )
  }, [])

  const convertToRemnant = useCallback((sessionId: string, exitCode: number) => {
    setTerminals((prev) => {
      const terminal = prev.find((t) => t.sessionId === sessionId)
      if (!terminal) return prev
      const remnant: RemnantInfo = {
        sessionId: terminal.sessionId,
        parentId: terminal.parentId,
        x: terminal.x,
        y: terminal.y,
        zIndex: terminal.zIndex,
        name: terminal.name,
        colorPresetId: terminal.colorPresetId,
        shellTitleHistory: terminal.shellTitleHistory,
        cwd: terminal.cwd,
        claudeSessionHistory: terminal.claudeSessionHistory,
        exitCode
      }
      setRemnants((r) => [...r, remnant])
      // Children keep their parentId pointing at the same sessionId (now a remnant)
      return prev.filter((t) => t.sessionId !== sessionId)
    })
  }, [])

  const removeRemnant = useCallback((sessionId: string) => {
    setRemnants((prev) => {
      const removed = prev.find((r) => r.sessionId === sessionId)
      const newParent = removed?.parentId ?? 'root'
      // Re-parent remnant children in remnants array
      const updated = prev
        .filter((r) => r.sessionId !== sessionId)
        .map((r) => r.parentId === sessionId ? { ...r, parentId: newParent } : r)
      return updated
    })
    // Re-parent children in terminals array
    setTerminals((prev) => {
      const removedRemnant = remnantRef.current.find((r) => r.sessionId === sessionId)
      const newParent = removedRemnant?.parentId ?? 'root'
      return prev.map((t) => t.parentId === sessionId ? { ...t, parentId: newParent } : t)
    })
  }, [])

  const moveRemnant = useCallback((sessionId: string, x: number, y: number) => {
    setRemnants((prev) =>
      prev.map((r) => (r.sessionId === sessionId ? { ...r, x, y } : r))
    )
  }, [])

  const bringRemnantToFront = useCallback((sessionId: string) => {
    const z = nextZIndex.current++
    setRemnants((prev) =>
      prev.map((r) => (r.sessionId === sessionId ? { ...r, zIndex: z } : r))
    )
  }, [])

  const renameRemnant = useCallback((sessionId: string, name: string) => {
    setRemnants((prev) =>
      prev.map((r) => (r.sessionId === sessionId ? { ...r, name } : r))
    )
  }, [])

  const setRemnantColor = useCallback((sessionId: string, colorPresetId: string) => {
    setRemnants((prev) =>
      prev.map((r) => (r.sessionId === sessionId ? { ...r, colorPresetId } : r))
    )
  }, [])

  const addMarkdown = useCallback((position: { x: number; y: number }, parentId: string) => {
    const id = crypto.randomUUID()
    const z = nextZIndex.current++
    const md: MarkdownInfo = {
      id,
      parentId,
      ...position,
      zIndex: z,
      width: MARKDOWN_DEFAULT_WIDTH,
      height: MARKDOWN_DEFAULT_HEIGHT,
      content: '',
      colorPresetId: 'default'
    }
    setMarkdowns((prev) => [...prev, md])
    return id
  }, [])

  const removeMarkdown = useCallback((id: string) => {
    setMarkdowns((prev) => {
      const removed = prev.find((m) => m.id === id)
      const newParent = removed?.parentId ?? 'root'
      return prev
        .filter((m) => m.id !== id)
        .map((m) => m.parentId === id ? { ...m, parentId: newParent } : m)
    })
    // Re-parent terminal children
    setTerminals((prev) =>
      prev.map((t) => t.parentId === id ? { ...t, parentId: markdownRef.current.find((m) => m.id === id)?.parentId ?? 'root' } : t)
    )
    // Re-parent remnant children
    setRemnants((prev) =>
      prev.map((r) => r.parentId === id ? { ...r, parentId: markdownRef.current.find((m) => m.id === id)?.parentId ?? 'root' } : r)
    )
  }, [])

  const moveMarkdown = useCallback((id: string, x: number, y: number) => {
    setMarkdowns((prev) =>
      prev.map((m) => (m.id === id ? { ...m, x, y } : m))
    )
  }, [])

  const resizeMarkdown = useCallback((id: string, width: number, height: number) => {
    setMarkdowns((prev) =>
      prev.map((m) => (m.id === id ? { ...m, width, height } : m))
    )
  }, [])

  const updateMarkdownContent = useCallback((id: string, content: string) => {
    setMarkdowns((prev) =>
      prev.map((m) => (m.id === id ? { ...m, content } : m))
    )
  }, [])

  const bringMarkdownToFront = useCallback((id: string) => {
    const z = nextZIndex.current++
    setMarkdowns((prev) =>
      prev.map((m) => (m.id === id ? { ...m, zIndex: z } : m))
    )
  }, [])

  const renameMarkdown = useCallback((id: string, name: string) => {
    setMarkdowns((prev) =>
      prev.map((m) => (m.id === id ? { ...m, name } : m))
    )
  }, [])

  const setMarkdownColor = useCallback((id: string, colorPresetId: string) => {
    setMarkdowns((prev) =>
      prev.map((m) => (m.id === id ? { ...m, colorPresetId } : m))
    )
  }, [])

  return {
    terminals, addTerminal, removeTerminal, moveTerminal, resizeTerminal, bringToFront, renameTerminal, setTerminalColor, setShellTitle, setShellTitleHistory, setCwd, setClaudeSessionHistory,
    remnants, convertToRemnant, removeRemnant, moveRemnant, bringRemnantToFront, renameRemnant, setRemnantColor,
    markdowns, addMarkdown, removeMarkdown, moveMarkdown, resizeMarkdown, updateMarkdownContent, bringMarkdownToFront, renameMarkdown, setMarkdownColor,
    nextZIndex
  }
}
