import { useCallback, useEffect, useRef, useState } from 'react'
import { Canvas } from './components/Canvas'
import { RootNode } from './components/RootNode'
import { TerminalCard, terminalSelectionGetters } from './components/TerminalCard'
import { RemnantCard } from './components/RemnantCard'
import { MarkdownCard } from './components/MarkdownCard'
import { TreeLines } from './components/TreeLines'
import type { TreeLineNode } from './components/TreeLines'
import { Toolbar } from './components/Toolbar'
import { useCamera } from './hooks/useCamera'
import { useTTS } from './hooks/useTTS'
import { useTerminalManager, nodePixelSize } from './hooks/useTerminalManager'
import { useForceLayout } from './hooks/useForceLayout'
import { cameraToFitBounds, unionBounds } from './lib/camera'
import { terminalPixelSize, CHILD_PLACEMENT_DISTANCE, ROOT_NODE_RADIUS, UNFOCUSED_MAX_ZOOM } from './lib/constants'
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
  const savedNodes = savedLayout?.nodes.filter(n => n.type !== 'terminal') ?? []
  const savedTerminalPositions = savedLayout?.terminalPositions

  const [focusedId, setFocusedId] = useState<string | null>(null)
  const [scrollMode, setScrollMode] = useState(false)
  const focusRef = useRef<string | null>(focusedId)
  focusRef.current = focusedId

  const { speak, stop: ttsStop, isSpeaking } = useTTS()
  const { camera, handleWheel, handlePanStart, resetCamera, flyTo, flyToUnfocusZoom, inputDevice, toggleInputDevice } = useCamera(savedLayout?.camera, focusRef)
  const cameraRef = useRef(camera)
  cameraRef.current = camera

  const {
    nodes, nodesRef, terminals, remnants, markdowns,
    removeNode, moveNode, batchMoveNodes, bringToFront, renameNode, setNodeColor,
    addTerminal, resizeTerminal, setShellTitle, setShellTitleHistory, setCwd, setClaudeSessionHistory, setWaitingForUser,
    convertToRemnant,
    addMarkdown, resizeMarkdown, moveAndResizeMarkdown, updateMarkdownContent,
    nextZIndex
  } = useTerminalManager({
    savedNodes,
    savedTerminalPositions,
    initialNextZIndex: savedLayout?.nextZIndex
  })

  // Force-directed layout
  const draggingRef = useRef(new Set<string>())
  const { playing: forceLayoutPlaying, speed: forceLayoutSpeed, togglePlaying: forceLayoutToggle, increaseSpeed: forceLayoutIncrease, decreaseSpeed: forceLayoutDecrease } = useForceLayout({
    nodesRef,
    draggingRef,
    batchMoveNodes
  })

  const handleDragStart = useCallback((id: string) => {
    draggingRef.current.add(id)
  }, [])

  const handleDragEnd = useCallback((id: string) => {
    draggingRef.current.delete(id)
  }, [])

  // CWD tracking — ref so updates don't trigger re-renders
  const cwdMapRef = useRef(new Map<string, string>())
  const forkHistoryLengthRef = useRef(new Map<string, number>())

  const handleCwdChange = useCallback((id: string, cwd: string) => {
    cwdMapRef.current.set(id, cwd)
    setCwd(id, cwd)
  }, [setCwd])

  const handleShellTitleChange = useCallback((id: string, title: string) => {
    const stripped = title.replace(/^[^\x20-\x7E]+\s*/, '').trim()
    if (!stripped) return
    setShellTitle(id, stripped)
  }, [setShellTitle])

  const handleShellTitleHistoryChange = useCallback((id: string, history: string[]) => {
    setShellTitleHistory(id, history)
  }, [setShellTitleHistory])

  const computeChildPosition = useCallback((parentId: string) => {
    const allNodes = nodesRef.current

    // Parent center
    let parentCenter: { x: number; y: number }
    let grandparentCenter: { x: number; y: number } | null = null
    let cwd: string | undefined

    if (parentId === 'root') {
      parentCenter = { x: 0, y: 0 }
    } else {
      const parent = allNodes.find(n => n.id === parentId)
      if (!parent) return { position: { x: 0, y: 0 }, cwd: undefined }

      const ps = nodePixelSize(parent)
      parentCenter = nodeCenter(parent.x, parent.y, ps.width, ps.height)
      cwd = cwdMapRef.current.get(parentId)

      // Grandparent center
      if (parent.parentId === 'root') {
        grandparentCenter = { x: 0, y: 0 }
      } else {
        const gp = allNodes.find(n => n.id === parent.parentId)
        if (gp) {
          const gs = nodePixelSize(gp)
          grandparentCenter = nodeCenter(gp.x, gp.y, gs.width, gs.height)
        }
      }
    }

    // Sibling centers
    const siblings = allNodes.filter(n => n.parentId === parentId)
    const siblingCenters = siblings.map(s => {
      const ss = nodePixelSize(s)
      return nodeCenter(s.x, s.y, ss.width, ss.height)
    })

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
      const node = nodesRef.current.find(n => n.id === nodeId)
      if (!node) {
        // Node not in state yet (newly created).
        // No flyTo — onNodeReady will fire when the node mounts.
        setScrollMode(false)
        return
      }
      const size = nodePixelSize(node)
      bounds = { x: node.x, y: node.y, ...size }
      setScrollMode(node.type === 'terminal')
      bringToFront(nodeId)
    }

    flyTo(cameraToFitBounds(bounds, viewport.clientWidth, viewport.clientHeight, padding))
  }, [bringToFront, flyTo])

  const handleClaudeSessionHistoryChange = useCallback((id: string, history: ClaudeSessionEntry[]) => {
    setClaudeSessionHistory(id, history)

    const lastSeen = forkHistoryLengthRef.current.get(id)
    forkHistoryLengthRef.current.set(id, history.length)

    // First call for this session (initial attach): just record length
    if (lastSeen === undefined) return

    // New fork entry detected
    if (history.length > lastSeen && history.length >= 2) {
      const latestEntry = history[history.length - 1]
      if (latestEntry.reason === 'fork') {
        const resumeSessionId = history[history.length - 2].claudeSessionId
        const { position, cwd } = computeChildPosition(id)
        addTerminal(position, id, buildClaudeCodeOptions({ cwd, resumeSessionId })).then((result) => {
          if (cwd) handleCwdChange(result.sessionId, cwd)
          handleNodeFocus(result.sessionId)
        })
      }
    }
  }, [setClaudeSessionHistory, computeChildPosition, addTerminal, handleCwdChange, handleNodeFocus])

  const handleRemoveNode = useCallback(async (id: string) => {
    cwdMapRef.current.delete(id)
    if (focusRef.current === id) {
      focusRef.current = null
      setFocusedId(null)
      setScrollMode(false)
    }
    await removeNode(id)
  }, [removeNode])

  const handleTerminalExit = useCallback((id: string, exitCode: number) => {
    if (focusRef.current === id) {
      focusRef.current = null
      setFocusedId(null)
      setScrollMode(false)
    }
    convertToRemnant(id, exitCode)
  }, [convertToRemnant])

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

  const handleResumeSession = useCallback(async (remnantId: string, claudeSessionId: string) => {
    const { position } = computeChildPosition(remnantId)
    const remnant = nodesRef.current.find(n => n.id === remnantId)
    const cwd = remnant?.cwd
    const result = await addTerminal(position, remnantId, buildClaudeCodeOptions({ cwd, resumeSessionId: claudeSessionId }))
    if (cwd) handleCwdChange(result.sessionId, cwd)
    handleNodeFocus(result.sessionId)
  }, [addTerminal, computeChildPosition, handleCwdChange, handleNodeFocus, nodesRef])

  const fitAllNodes = useCallback(() => {
    const rects = nodesRef.current.map(n => {
      const size = nodePixelSize(n)
      return { x: n.x, y: n.y, ...size }
    })
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

      // Cmd+Shift+S: speak selected text or stop speaking
      if (e.metaKey && e.shiftKey && e.key === 's') {
        e.preventDefault()
        e.stopPropagation()
        if (isSpeaking()) {
          ttsStop()
        } else if (focusRef.current) {
          const getter = terminalSelectionGetters.get(focusRef.current)
          const selection = getter?.()
          if (selection && selection.length > 0) {
            speak(selection)
          }
        }
      }

      // Escape: stop TTS if speaking
      if (e.key === 'Escape' && isSpeaking()) {
        ttsStop()
      }

    }
    window.addEventListener('keydown', handleKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true })
  }, [addTerminal, addMarkdown, computeChildPosition, handleNodeFocus, handleCwdChange, speak, ttsStop, isSpeaking])

  // Debounced save of layout state
  useEffect(() => {
    const timeout = setTimeout(() => {
      // Build terminal positions map for restoring PTY sessions on reload
      const terminalPositions: Record<string, { x: number; y: number; zIndex: number; name?: string; colorPresetId?: string; parentId?: string }> = {}
      for (const t of terminals) {
        terminalPositions[t.id] = { x: t.x, y: t.y, zIndex: t.zIndex, name: t.name, colorPresetId: t.colorPresetId, parentId: t.parentId }
      }

      saveLayout({
        version: 2,
        camera,
        nodes,
        nextZIndex: nextZIndex.current,
        terminalPositions
      })
    }, 500)
    return () => clearTimeout(timeout)
  }, [camera, nodes, terminals])

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
        onFitAll={fitAllNodes}
        onToggleInputDevice={toggleInputDevice}
        forceLayoutPlaying={forceLayoutPlaying}
        forceLayoutSpeed={forceLayoutSpeed}
        onForceLayoutToggle={forceLayoutToggle}
        onForceLayoutIncrease={forceLayoutIncrease}
        onForceLayoutDecrease={forceLayoutDecrease}
      />
      <Canvas camera={camera} onWheel={handleCanvasWheel} onPanStart={handleCanvasPanStart} onCanvasClick={handleCanvasUnfocus}>
        <TreeLines nodes={nodes.map((n): TreeLineNode => {
          const size = nodePixelSize(n)
          return { id: n.id, parentId: n.parentId, x: n.x, y: n.y, ...size }
        })} />
        <RootNode focused={focusedId === 'root'} onClick={() => handleNodeFocus('root')} />
        {terminals.map((t) => (
          <TerminalCard
            key={t.id}
            id={t.id}
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
            focused={focusedId === t.id}
            scrollMode={focusedId === t.id && scrollMode}
            onFocus={handleNodeFocus}
            onUnfocus={handleUnfocus}
            onDisableScrollMode={handleDisableScrollMode}
            onClose={handleRemoveNode}
            onMove={moveNode}
            onResize={resizeTerminal}
            onRename={renameNode}
            onColorChange={setNodeColor}
            onCwdChange={handleCwdChange}
            onShellTitleChange={handleShellTitleChange}
            onShellTitleHistoryChange={handleShellTitleHistoryChange}
            claudeSessionHistory={t.claudeSessionHistory}
            onClaudeSessionHistoryChange={handleClaudeSessionHistoryChange}
            waitingForUser={t.waitingForUser}
            onWaitingForUserChange={setWaitingForUser}
            onExit={handleTerminalExit}
            onNodeReady={handleNodeReady}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
          />
        ))}
        {remnants.map((r) => (
          <RemnantCard
            key={r.id}
            id={r.id}
            x={r.x}
            y={r.y}
            zIndex={r.zIndex}
            zoom={camera.z}
            name={r.name}
            colorPresetId={r.colorPresetId}
            shellTitleHistory={r.shellTitleHistory}
            cwd={r.cwd}
            claudeSessionHistory={r.claudeSessionHistory}
            exitCode={r.exitCode}
            focused={focusedId === r.id}
            onFocus={handleNodeFocus}
            onClose={handleRemoveNode}
            onMove={moveNode}
            onRename={renameNode}
            onColorChange={setNodeColor}
            onResumeSession={handleResumeSession}
            onNodeReady={handleNodeReady}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
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
            onClose={handleRemoveNode}
            onMove={moveNode}
            onResize={resizeMarkdown}
            onAutoResize={moveAndResizeMarkdown}
            onContentChange={updateMarkdownContent}
            onRename={renameNode}
            onColorChange={setNodeColor}
            onNodeReady={handleNodeReady}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
          />
        ))}
      </Canvas>
    </div>
  )
}
