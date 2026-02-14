import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { DEFAULT_COLS, DEFAULT_ROWS, GRID_GAP, GRID_COLS, MARKDOWN_DEFAULT_WIDTH, MARKDOWN_DEFAULT_HEIGHT, REMNANT_WIDTH, REMNANT_HEIGHT } from '../lib/constants'
import { terminalPixelSize } from '../lib/constants'

// --- Discriminated union node types ---

interface BaseNode {
  id: string
  type: 'terminal' | 'remnant' | 'markdown'
  parentId: string
  x: number
  y: number
  zIndex: number
  name?: string
  colorPresetId?: string
}

export interface TerminalNode extends BaseNode {
  type: 'terminal'
  cols: number
  rows: number
  shellTitle?: string
  shellTitleHistory?: string[]
  cwd?: string
  claudeSessionHistory?: ClaudeSessionEntry[]
  waitingForUser?: boolean
}

export interface RemnantNode extends BaseNode {
  type: 'remnant'
  exitCode: number
  shellTitleHistory?: string[]
  cwd?: string
  claudeSessionHistory?: ClaudeSessionEntry[]
}

export interface MarkdownNode extends BaseNode {
  type: 'markdown'
  width: number
  height: number
  content: string
}

export type TreeNode = TerminalNode | RemnantNode | MarkdownNode

export function nodePixelSize(node: TreeNode): { width: number; height: number } {
  switch (node.type) {
    case 'terminal': return terminalPixelSize(node.cols, node.rows)
    case 'remnant': return { width: REMNANT_WIDTH, height: REMNANT_HEIGHT }
    case 'markdown': return { width: node.width, height: node.height }
  }
}

// --- Helper ---

function gridPosition(index: number): { x: number; y: number } {
  const { width, height } = terminalPixelSize(DEFAULT_COLS, DEFAULT_ROWS)
  const col = index % GRID_COLS
  const row = Math.floor(index / GRID_COLS)
  return {
    x: col * (width + GRID_GAP),
    y: row * (height + GRID_GAP)
  }
}

// --- Hook ---

interface UseTerminalManagerOptions {
  savedNodes?: TreeNode[]
  savedTerminalPositions?: Record<string, { x: number; y: number; zIndex: number; name?: string; colorPresetId?: string; parentId?: string }>
  initialNextZIndex?: number
}

export function useTerminalManager(options?: UseTerminalManagerOptions) {
  const initialNodes = options?.savedNodes ?? []
  const [nodes, setNodes] = useState<TreeNode[]>(initialNodes)
  const nodesRef = useRef<TreeNode[]>(initialNodes)
  nodesRef.current = nodes
  const nextZIndex = useRef<number>(options?.initialNextZIndex ?? 1)

  // Derived arrays for rendering (components still receive typed data)
  const terminals = useMemo(() => nodes.filter((n): n is TerminalNode => n.type === 'terminal'), [nodes])
  const remnants = useMemo(() => nodes.filter((n): n is RemnantNode => n.type === 'remnant'), [nodes])
  const markdowns = useMemo(() => nodes.filter((n): n is MarkdownNode => n.type === 'markdown'), [nodes])

  // On mount, discover existing sessions from the server
  useEffect(() => {
    let cancelled = false

    const restore = async () => {
      try {
        const sessions = await window.api.pty.list()
        if (cancelled || sessions.length === 0) return

        const saved = options?.savedTerminalPositions
        const restored: TerminalNode[] = sessions.map((s, i) => {
          if (saved && saved[s.sessionId]) {
            const entry = saved[s.sessionId]
            return {
              id: s.sessionId,
              type: 'terminal' as const,
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
          return { id: s.sessionId, type: 'terminal' as const, parentId: 'root', ...gridPosition(i), zIndex: 0, cols: s.cols, rows: s.rows, colorPresetId: 'default' }
        })

        setNodes(prev => [...prev, ...restored])
      } catch {
        // Server not connected yet — will restore on reconnect
      }
    }

    restore()

    return () => {
      cancelled = true
    }
  }, [])

  // --- Generic tree operations ---

  const removeNode = useCallback(async (id: string) => {
    const node = nodesRef.current.find(n => n.id === id)
    if (!node) return
    if (node.type === 'terminal') await window.api.pty.destroy(id)
    const newParent = node.parentId
    setNodes(prev => prev
      .filter(n => n.id !== id)
      .map(n => n.parentId === id ? { ...n, parentId: newParent } : n))
  }, [])

  const moveNode = useCallback((id: string, x: number, y: number) => {
    setNodes(prev => prev.map(n => n.id === id ? { ...n, x, y } : n))
  }, [])

  const batchMoveNodes = useCallback((moves: Array<{ id: string; dx: number; dy: number }>) => {
    if (moves.length === 0) return
    const moveMap = new Map(moves.map(m => [m.id, m]))
    setNodes(prev => prev.map(n => {
      const m = moveMap.get(n.id)
      return m ? { ...n, x: n.x + m.dx, y: n.y + m.dy } : n
    }))
  }, [])

  const bringToFront = useCallback((id: string) => {
    const z = nextZIndex.current++
    setNodes(prev => prev.map(n => n.id === id ? { ...n, zIndex: z } : n))
  }, [])

  const renameNode = useCallback((id: string, name: string) => {
    setNodes(prev => prev.map(n => n.id === id ? { ...n, name } : n))
  }, [])

  const setNodeColor = useCallback((id: string, colorPresetId: string) => {
    setNodes(prev => prev.map(n => n.id === id ? { ...n, colorPresetId } : n))
  }, [])

  // --- Terminal-specific operations ---

  const addTerminal = useCallback(async (position: { x: number; y: number }, parentId: string, options?: CreateOptions) => {
    const result = await window.api.pty.create(options)
    const z = nextZIndex.current++

    setNodes(prev => [...prev, {
      id: result.sessionId,
      type: 'terminal' as const,
      parentId,
      ...position,
      zIndex: z,
      cols: result.cols,
      rows: result.rows,
      cwd: result.cwd,
      colorPresetId: 'default'
    }])

    return { sessionId: result.sessionId, cols: result.cols, rows: result.rows }
  }, [])

  const resizeTerminal = useCallback((id: string, cols: number, rows: number) => {
    setNodes(prev => prev.map(n => n.id === id && n.type === 'terminal' ? { ...n, cols, rows } : n))
  }, [])

  const setShellTitle = useCallback((id: string, shellTitle: string) => {
    setNodes(prev => prev.map(n => n.id === id && n.type === 'terminal' ? { ...n, shellTitle } : n))
  }, [])

  const setShellTitleHistory = useCallback((id: string, shellTitleHistory: string[]) => {
    setNodes(prev => prev.map(n => n.id === id && n.type === 'terminal' ? { ...n, shellTitleHistory } : n))
  }, [])

  const setCwd = useCallback((id: string, cwd: string) => {
    setNodes(prev => prev.map(n => n.id === id && n.type === 'terminal' ? { ...n, cwd } : n))
  }, [])

  const setClaudeSessionHistory = useCallback((id: string, claudeSessionHistory: ClaudeSessionEntry[]) => {
    setNodes(prev => prev.map(n => n.id === id && n.type === 'terminal' ? { ...n, claudeSessionHistory } : n))
  }, [])

  const setWaitingForUser = useCallback((id: string, waitingForUser: boolean) => {
    setNodes(prev => prev.map(n => n.id === id && n.type === 'terminal' ? { ...n, waitingForUser } : n))
  }, [])

  const convertToRemnant = useCallback((id: string, exitCode: number) => {
    setNodes(prev => {
      const terminal = prev.find((n): n is TerminalNode => n.id === id && n.type === 'terminal')
      if (!terminal) return prev
      const remnant: RemnantNode = {
        id: terminal.id,
        type: 'remnant',
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
      // Replace the terminal node with the remnant node in-place
      // Children keep their parentId pointing at the same id (now a remnant)
      return prev.map(n => n.id === id ? remnant : n)
    })
  }, [])

  // --- Markdown-specific operations ---

  const addMarkdown = useCallback((position: { x: number; y: number }, parentId: string) => {
    const id = crypto.randomUUID()
    const z = nextZIndex.current++
    const md: MarkdownNode = {
      id,
      type: 'markdown',
      parentId,
      ...position,
      zIndex: z,
      width: MARKDOWN_DEFAULT_WIDTH,
      height: MARKDOWN_DEFAULT_HEIGHT,
      content: '',
      colorPresetId: 'default'
    }
    setNodes(prev => [...prev, md])
    return id
  }, [])

  const resizeMarkdown = useCallback((id: string, width: number, height: number) => {
    setNodes(prev => prev.map(n => n.id === id && n.type === 'markdown' ? { ...n, width, height } : n))
  }, [])

  const moveAndResizeMarkdown = useCallback((id: string, x: number, y: number, width: number, height: number) => {
    setNodes(prev => prev.map(n => n.id === id && n.type === 'markdown' ? { ...n, x, y, width, height } : n))
  }, [])

  const updateMarkdownContent = useCallback((id: string, content: string) => {
    setNodes(prev => prev.map(n => n.id === id && n.type === 'markdown' ? { ...n, content } : n))
  }, [])

  return {
    nodes, nodesRef, terminals, remnants, markdowns,
    removeNode, moveNode, batchMoveNodes, bringToFront, renameNode, setNodeColor,
    addTerminal, resizeTerminal, setShellTitle, setShellTitleHistory, setCwd, setClaudeSessionHistory, setWaitingForUser,
    convertToRemnant,
    addMarkdown, resizeMarkdown, moveAndResizeMarkdown, updateMarkdownContent,
    nextZIndex
  }
}
