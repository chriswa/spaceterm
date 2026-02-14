import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Canvas } from './components/Canvas'
import { RootNode } from './components/RootNode'
import { TerminalCard } from './components/TerminalCard'
import { RemnantCard } from './components/RemnantCard'
import { MarkdownCard } from './components/MarkdownCard'
import { TreeLines } from './components/TreeLines'
import type { TreeNode } from './components/TreeLines'
import { Toolbar } from './components/Toolbar'
import { useCamera } from './hooks/useCamera'
import { useTerminalManager } from './hooks/useTerminalManager'
import { cameraToFitBounds, unionBounds } from './lib/camera'
import { terminalPixelSize, CHILD_PLACEMENT_DISTANCE, ROOT_NODE_RADIUS, UNFOCUSED_MAX_ZOOM, REMNANT_WIDTH, REMNANT_HEIGHT, MARKDOWN_DEFAULT_WIDTH, MARKDOWN_DEFAULT_HEIGHT } from './lib/constants'
import { loadLayout, saveLayout } from './lib/layout-persistence'
import { computeChildPlacement, nodeCenter } from './lib/tree-placement'

const savedLayout = loadLayout()

function buildClaudeCodeOptions({ prompt, cwd, resumeSessionId }: { prompt?: string; cwd?: string; resumeSessionId?: string } = {}): CreateOptions {
  const args = ['--plugin-dir', 'src/claude-code-plugin']
  if (resumeSessionId) {
    args.push('-r', resumeSessionId)
  }
  if (prompt) {
    args.push('--', prompt)
  }
  return { cwd, command: 'claude', args }
}

export function App() {
  const savedTerminals = useMemo(() => {
    if (!savedLayout) return undefined
    const map: Record<string, { x: number; y: number; zIndex: number; name?: string; colorPresetId?: string; parentId?: string }> = {}
    for (const t of savedLayout.terminals) {
      map[t.sessionId] = { x: t.x, y: t.y, zIndex: t.zIndex, name: t.name, colorPresetId: t.colorPresetId, parentId: t.parentId }
    }
    return map
  }, [])

  const savedRemnants = useMemo(() => savedLayout?.remnants ?? [], [])
  const savedMarkdowns = useMemo(() => savedLayout?.markdowns?.map((m) => ({
    id: m.id,
    parentId: m.parentId,
    x: m.x,
    y: m.y,
    zIndex: m.zIndex,
    width: m.width,
    height: m.height,
    content: m.content,
    name: m.name,
    colorPresetId: m.colorPresetId
  })) ?? [], [])

  const [focusedId, setFocusedId] = useState<string | null>(null)
  const [scrollMode, setScrollMode] = useState(false)
  const focusRef = useRef<string | null>(focusedId)
  focusRef.current = focusedId

  const { camera, handleWheel, handlePanStart, resetCamera, flyTo, flyToUnfocusZoom, inputDevice, toggleInputDevice } = useCamera(savedLayout?.camera, focusRef)
  const cameraRef = useRef(camera)
  cameraRef.current = camera

  const {
    terminals, addTerminal, removeTerminal, moveTerminal, resizeTerminal, bringToFront, renameTerminal, setTerminalColor, setShellTitle, setShellTitleHistory, setCwd, setClaudeSessionHistory,
    remnants, convertToRemnant, removeRemnant, moveRemnant, bringRemnantToFront, renameRemnant, setRemnantColor,
    markdowns, addMarkdown, removeMarkdown, moveMarkdown, resizeMarkdown, updateMarkdownContent, bringMarkdownToFront, renameMarkdown, setMarkdownColor,
    nextZIndex
  } = useTerminalManager({
      savedTerminals,
      savedRemnants,
      savedMarkdowns,
      initialNextZIndex: savedLayout?.nextZIndex
    })

  const remnantsRef = useRef(remnants)
  remnantsRef.current = remnants
  const markdownsRef = useRef(markdowns)
  markdownsRef.current = markdowns

  // CWD tracking — ref so updates don't trigger re-renders
  const cwdMapRef = useRef(new Map<string, string>())
  const forkHistoryLengthRef = useRef(new Map<string, number>())
  const terminalsRef = useRef(terminals)
  terminalsRef.current = terminals

  const handleCwdChange = useCallback((sessionId: string, cwd: string) => {
    cwdMapRef.current.set(sessionId, cwd)
    setCwd(sessionId, cwd)
  }, [setCwd])

  const handleShellTitleChange = useCallback((sessionId: string, title: string) => {
    const stripped = title.replace(/^[^\x20-\x7E]+\s*/, '').trim()
    if (!stripped) return
    setShellTitle(sessionId, stripped)
  }, [setShellTitle])

  const handleShellTitleHistoryChange = useCallback((sessionId: string, history: string[]) => {
    setShellTitleHistory(sessionId, history)
  }, [setShellTitleHistory])

  const computeChildPosition = useCallback((parentId: string) => {
    const terms = terminalsRef.current

    // Parent center
    let parentCenter: { x: number; y: number }
    let grandparentCenter: { x: number; y: number } | null = null
    let cwd: string | undefined

    if (parentId === 'root') {
      parentCenter = { x: 0, y: 0 }
    } else {
      const parent = terms.find((t) => t.sessionId === parentId)
      const mdParent = !parent ? markdownsRef.current.find((m) => m.id === parentId) : undefined
      if (!parent && !mdParent) return { position: { x: 0, y: 0 }, cwd: undefined }
      if (parent) {
        const ps = terminalPixelSize(parent.cols, parent.rows)
        parentCenter = nodeCenter(parent.x, parent.y, ps.width, ps.height)
        cwd = cwdMapRef.current.get(parentId)
      } else {
        parentCenter = nodeCenter(mdParent!.x, mdParent!.y, mdParent!.width, mdParent!.height)
      }

      const actualParentId = parent?.parentId ?? mdParent!.parentId
      // Grandparent center
      if (actualParentId === 'root') {
        grandparentCenter = { x: 0, y: 0 }
      } else {
        const gp = terms.find((t) => t.sessionId === actualParentId)
        if (gp) {
          const gs = terminalPixelSize(gp.cols, gp.rows)
          grandparentCenter = nodeCenter(gp.x, gp.y, gs.width, gs.height)
        }
      }
    }

    // Sibling centers (include terminals, remnants, and markdowns)
    const siblings = terms.filter((t) => t.parentId === parentId)
    const siblingCenters = siblings.map((s) => {
      const ss = terminalPixelSize(s.cols, s.rows)
      return nodeCenter(s.x, s.y, ss.width, ss.height)
    })
    for (const m of markdownsRef.current.filter((m) => m.parentId === parentId)) {
      siblingCenters.push(nodeCenter(m.x, m.y, m.width, m.height))
    }

    const center = computeChildPlacement(parentCenter, grandparentCenter, siblingCenters, CHILD_PLACEMENT_DISTANCE)
    const { width, height } = terminalPixelSize(80, 24)
    return {
      position: { x: center.x - width / 2, y: center.y - height / 2 },
      cwd
    }
  }, [])

  const handleNodeFocus = useCallback((nodeId: string) => {
    setFocusedId(nodeId)

    const viewport = document.querySelector('.canvas-viewport') as HTMLElement | null
    if (!viewport) return

    let bounds: { x: number; y: number; width: number; height: number }
    let padding = 0.025

    if (nodeId === 'root') {
      bounds = { x: -200, y: -200, width: 400, height: 400 }
      padding = 0.05
      setScrollMode(false)
    } else {
      const terminal = terminalsRef.current.find(t => t.sessionId === nodeId)
      if (terminal) {
        const { width, height } = terminalPixelSize(terminal.cols, terminal.rows)
        bounds = { x: terminal.x, y: terminal.y, width, height }
        setScrollMode(true)
        bringToFront(nodeId)
      } else {
        const remnant = remnantsRef.current.find(r => r.sessionId === nodeId)
        if (remnant) {
          bounds = { x: remnant.x, y: remnant.y, width: REMNANT_WIDTH, height: REMNANT_HEIGHT }
          setScrollMode(false)
          bringRemnantToFront(nodeId)
        } else {
          const md = markdownsRef.current.find(m => m.id === nodeId)
          if (md) {
            bounds = { x: md.x, y: md.y, width: md.width, height: md.height }
            setScrollMode(false)
            bringMarkdownToFront(nodeId)
          } else {
            // Node not in state yet (newly created).
            // No flyTo — onNodeReady will fire when the node mounts.
            setScrollMode(false)
            return
          }
        }
      }
    }

    flyTo(cameraToFitBounds(bounds, viewport.clientWidth, viewport.clientHeight, padding))
  }, [bringToFront, bringRemnantToFront, bringMarkdownToFront, flyTo])

  const handleClaudeSessionHistoryChange = useCallback((sessionId: string, history: ClaudeSessionEntry[]) => {
    setClaudeSessionHistory(sessionId, history)

    const lastSeen = forkHistoryLengthRef.current.get(sessionId)
    forkHistoryLengthRef.current.set(sessionId, history.length)

    // First call for this session (initial attach): just record length
    if (lastSeen === undefined) return

    // New fork entry detected
    if (history.length > lastSeen && history.length >= 2) {
      const latestEntry = history[history.length - 1]
      if (latestEntry.reason === 'fork') {
        const resumeSessionId = history[history.length - 2].claudeSessionId
        const { position, cwd } = computeChildPosition(sessionId)
        addTerminal(position, sessionId, buildClaudeCodeOptions({ cwd, resumeSessionId })).then((result) => {
          if (cwd) handleCwdChange(result.sessionId, cwd)
          handleNodeFocus(result.sessionId)
        })
      }
    }
  }, [setClaudeSessionHistory, computeChildPosition, addTerminal, handleCwdChange, handleNodeFocus])

  const handleRemoveTerminal = useCallback(async (sessionId: string) => {
    cwdMapRef.current.delete(sessionId)
    await removeTerminal(sessionId)
  }, [removeTerminal])

  const handleTerminalExit = useCallback((sessionId: string, exitCode: number) => {
    if (focusRef.current === sessionId) {
      focusRef.current = null
      setFocusedId(null)
      setScrollMode(false)
    }
    convertToRemnant(sessionId, exitCode)
  }, [convertToRemnant])

  const handleRemoveRemnant = useCallback((sessionId: string) => {
    removeRemnant(sessionId)
  }, [removeRemnant])

  const handleRemoveMarkdown = useCallback((id: string) => {
    if (focusRef.current === id) {
      focusRef.current = null
      setFocusedId(null)
      setScrollMode(false)
    }
    removeMarkdown(id)
  }, [removeMarkdown])

  const addTerminalAsChild = useCallback(async (parentId: string) => {
    const { position, cwd } = computeChildPosition(parentId)
    const result = await addTerminal(position, parentId, cwd ? { cwd } : undefined)
    if (cwd) handleCwdChange(result.sessionId, cwd)
  }, [addTerminal, computeChildPosition, handleCwdChange])

  const addClaudeCodeAsChild = useCallback(async (parentId: string) => {
    const { position, cwd } = computeChildPosition(parentId)
    const result = await addTerminal(position, parentId, buildClaudeCodeOptions({ cwd }))
    if (cwd) handleCwdChange(result.sessionId, cwd)
  }, [addTerminal, computeChildPosition, handleCwdChange])

  const fitAllTerminals = useCallback(() => {
    const terms = terminalsRef.current
    const rems = remnantsRef.current
    const rects = terms.map((t) => {
      const { width, height } = terminalPixelSize(t.cols, t.rows)
      return { x: t.x, y: t.y, width, height }
    })
    // Include remnants in bounds
    for (const r of rems) {
      rects.push({ x: r.x, y: r.y, width: REMNANT_WIDTH, height: REMNANT_HEIGHT })
    }
    // Include markdowns in bounds
    for (const m of markdownsRef.current) {
      rects.push({ x: m.x, y: m.y, width: m.width, height: m.height })
    }
    // Include root node in bounds
    rects.push({ x: -ROOT_NODE_RADIUS, y: -ROOT_NODE_RADIUS, width: ROOT_NODE_RADIUS * 2, height: ROOT_NODE_RADIUS * 2 })
    const bounds = unionBounds(rects)
    if (!bounds) return
    const viewport = document.querySelector('.canvas-viewport') as HTMLElement | null
    if (!viewport) return
    const target = cameraToFitBounds(bounds, viewport.clientWidth, viewport.clientHeight, 0.05, UNFOCUSED_MAX_ZOOM)
    flyTo(target)
  }, [flyTo])

  const handleUnfocus = useCallback(() => {
    focusRef.current = null
    setFocusedId(null)
    setScrollMode(false)
  }, [])

  const handleDisableScrollMode = useCallback(() => {
    setScrollMode(false)
  }, [])

  // Global keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = async (e: KeyboardEvent) => {
      if (e.metaKey && e.key === 't') {
        e.preventDefault()
        e.stopPropagation()
        if (!focusRef.current) return
        const { position, cwd } = computeChildPosition(focusRef.current)
        const result = await addTerminal(position, focusRef.current, cwd ? { cwd } : undefined)
        if (cwd) handleCwdChange(result.sessionId, cwd)
        handleNodeFocus(result.sessionId)
      }

      if (e.metaKey && e.key === 'e') {
        e.preventDefault()
        e.stopPropagation()
        if (!focusRef.current) return
        const { position, cwd } = computeChildPosition(focusRef.current)
        const result = await addTerminal(position, focusRef.current, buildClaudeCodeOptions({ cwd }))
        if (cwd) handleCwdChange(result.sessionId, cwd)
        handleNodeFocus(result.sessionId)
      }

      if (e.metaKey && e.key === 'm') {
        e.preventDefault()
        e.stopPropagation()
        const parentId = focusRef.current ?? 'root'
        const { position } = computeChildPosition(parentId)
        const mdId = addMarkdown(position, parentId)
        handleNodeFocus(mdId)
      }

    }
    window.addEventListener('keydown', handleKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true })
  }, [addTerminal, addMarkdown, computeChildPosition, handleNodeFocus, handleCwdChange])

  // Debounced save of layout state
  useEffect(() => {
    const timeout = setTimeout(() => {
      saveLayout({
        camera,
        terminals: terminals.map((t) => ({
          sessionId: t.sessionId,
          x: t.x,
          y: t.y,
          zIndex: t.zIndex,
          name: t.name,
          colorPresetId: t.colorPresetId,
          parentId: t.parentId
        })),
        remnants: remnants.map((r) => ({
          sessionId: r.sessionId,
          x: r.x,
          y: r.y,
          zIndex: r.zIndex,
          name: r.name,
          colorPresetId: r.colorPresetId,
          parentId: r.parentId,
          shellTitleHistory: r.shellTitleHistory,
          cwd: r.cwd,
          exitCode: r.exitCode
        })),
        markdowns: markdowns.map((m) => ({
          id: m.id,
          x: m.x,
          y: m.y,
          zIndex: m.zIndex,
          width: m.width,
          height: m.height,
          content: m.content,
          name: m.name,
          colorPresetId: m.colorPresetId,
          parentId: m.parentId
        })),
        nextZIndex: nextZIndex.current
      })
    }, 500)
    return () => clearTimeout(timeout)
  }, [camera, terminals, remnants, markdowns])

  const handleNodeReady = useCallback((nodeId: string, bounds: { x: number; y: number; width: number; height: number }) => {
    if (focusRef.current !== nodeId) return
    const viewport = document.querySelector('.canvas-viewport') as HTMLElement | null
    if (!viewport) return
    flyTo(cameraToFitBounds(bounds, viewport.clientWidth, viewport.clientHeight, 0.025))
  }, [flyTo])

  const handleCanvasWheel = useCallback((e: WheelEvent) => {
    if (focusRef.current) {
      e.preventDefault()
      handleUnfocus()
      flyToUnfocusZoom()
    }
    handleWheel(e)
  }, [handleWheel, flyToUnfocusZoom, handleUnfocus])

  const handleCanvasPanStart = useCallback((e: MouseEvent) => {
    if (focusRef.current) {
      handleUnfocus()
      flyToUnfocusZoom()
    }
    handlePanStart(e)
  }, [handlePanStart, flyToUnfocusZoom, handleUnfocus])

  const handleCanvasUnfocus = useCallback(() => {
    handleUnfocus()
    flyToUnfocusZoom()
  }, [handleUnfocus, flyToUnfocusZoom])

  return (
    <div className="app">
      <Toolbar
        zoom={camera.z}
        cameraX={camera.x}
        cameraY={camera.y}
        inputDevice={inputDevice}
        onAddTerminal={() => addTerminalAsChild('root')}
        onResetView={resetCamera}
        onFitAll={fitAllTerminals}
        onToggleInputDevice={toggleInputDevice}
      />
      <Canvas camera={camera} onWheel={handleCanvasWheel} onPanStart={handleCanvasPanStart} onCanvasClick={handleCanvasUnfocus}>
        <TreeLines nodes={[
          ...terminals.map((t): TreeNode => {
            const { width, height } = terminalPixelSize(t.cols, t.rows)
            return { sessionId: t.sessionId, parentId: t.parentId, x: t.x, y: t.y, width, height }
          }),
          ...remnants.map((r): TreeNode => ({
            sessionId: r.sessionId, parentId: r.parentId, x: r.x, y: r.y, width: REMNANT_WIDTH, height: REMNANT_HEIGHT
          })),
          ...markdowns.map((m): TreeNode => ({
            sessionId: m.id, parentId: m.parentId, x: m.x, y: m.y, width: m.width, height: m.height
          }))
        ]} />
        <RootNode focused={focusedId === 'root'} onClick={() => handleNodeFocus('root')} />
        {terminals.map((t) => (
          <TerminalCard
            key={t.sessionId}
            sessionId={t.sessionId}
            x={t.x}
            y={t.y}
            cols={t.cols}
            rows={t.rows}
            zIndex={t.zIndex}
            zoom={camera.z}
            name={t.name}
            colorPresetId={t.colorPresetId}
            shellTitle={t.shellTitle}
            shellTitleHistory={t.shellTitleHistory}
            cwd={t.cwd}
            focused={focusedId === t.sessionId}
            scrollMode={focusedId === t.sessionId && scrollMode}
            onFocus={handleNodeFocus}
            onUnfocus={handleUnfocus}
            onDisableScrollMode={handleDisableScrollMode}
            onClose={handleRemoveTerminal}
            onMove={moveTerminal}
            onResize={resizeTerminal}
            onRename={renameTerminal}
            onColorChange={setTerminalColor}
            onCwdChange={handleCwdChange}
            onShellTitleChange={handleShellTitleChange}
            onShellTitleHistoryChange={handleShellTitleHistoryChange}
            claudeSessionHistory={t.claudeSessionHistory}
            onClaudeSessionHistoryChange={handleClaudeSessionHistoryChange}
            onExit={handleTerminalExit}
            onNodeReady={handleNodeReady}
          />
        ))}
        {remnants.map((r) => (
          <RemnantCard
            key={r.sessionId}
            sessionId={r.sessionId}
            x={r.x}
            y={r.y}
            zIndex={r.zIndex}
            zoom={camera.z}
            name={r.name}
            colorPresetId={r.colorPresetId}
            shellTitleHistory={r.shellTitleHistory}
            cwd={r.cwd}
            exitCode={r.exitCode}
            focused={focusedId === r.sessionId}
            onFocus={handleNodeFocus}
            onClose={handleRemoveRemnant}
            onMove={moveRemnant}
            onRename={renameRemnant}
            onColorChange={setRemnantColor}
            onNodeReady={handleNodeReady}
          />
        ))}
        {markdowns.map((m) => (
          <MarkdownCard
            key={m.id}
            id={m.id}
            x={m.x}
            y={m.y}
            width={m.width}
            height={m.height}
            zIndex={m.zIndex}
            zoom={camera.z}
            content={m.content}
            name={m.name}
            colorPresetId={m.colorPresetId}
            focused={focusedId === m.id}
            onFocus={handleNodeFocus}
            onClose={handleRemoveMarkdown}
            onMove={moveMarkdown}
            onResize={resizeMarkdown}
            onContentChange={updateMarkdownContent}
            onRename={renameMarkdown}
            onColorChange={setMarkdownColor}
            onNodeReady={handleNodeReady}
          />
        ))}
      </Canvas>
    </div>
  )
}
