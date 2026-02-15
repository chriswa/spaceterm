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
import { useForceLayout } from './hooks/useForceLayout'
import { cameraToFitBounds, unionBounds } from './lib/camera'
import { CHILD_PLACEMENT_DISTANCE, ROOT_NODE_RADIUS, UNFOCUS_SNAP_ZOOM } from './lib/constants'
import { computeChildPlacement } from './lib/tree-placement'
import { useNodeStore, nodePixelSize } from './stores/nodeStore'
import { initServerSync, sendMove, sendBatchMove, sendRename, sendSetColor, sendBringToFront, sendArchive, sendTerminalCreate, sendTerminalReincarnate, sendMarkdownAdd, sendMarkdownResize, sendMarkdownContent, sendTerminalResize } from './lib/server-sync'

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
  const [focusedId, setFocusedId] = useState<string | null>(null)
  const [scrollMode, setScrollMode] = useState(false)
  const focusRef = useRef<string | null>(focusedId)
  focusRef.current = focusedId

  const { speak, stop: ttsStop, isSpeaking } = useTTS()
  const { camera, handleWheel, handlePanStart, resetCamera, flyTo, flyToUnfocusZoom, inputDevice, toggleInputDevice } = useCamera(undefined, focusRef)
  const cameraRef = useRef(camera)
  cameraRef.current = camera

  // Subscribe to store
  const nodes = useNodeStore(s => s.nodes)
  const nodeList = useNodeStore(s => s.nodeList)
  const liveTerminals = useNodeStore(s => s.liveTerminals)
  const deadTerminals = useNodeStore(s => s.deadTerminals)
  const markdowns = useNodeStore(s => s.markdowns)
  const moveNode = useNodeStore(s => s.moveNode)
  const batchMoveNodes = useNodeStore(s => s.batchMoveNodes)
  const renameNode = useNodeStore(s => s.renameNode)
  const setNodeColor = useNodeStore(s => s.setNodeColor)
  const bringToFront = useNodeStore(s => s.bringToFront)

  // Initialize server sync on mount
  useEffect(() => {
    initServerSync()
  }, [])

  // Fit all nodes on initial load once server state has been received
  const initialSyncDone = useNodeStore(s => s.initialSyncDone)
  const initialFitDone = useRef(false)
  useEffect(() => {
    if (initialFitDone.current || !initialSyncDone) return
    initialFitDone.current = true
    requestAnimationFrame(() => {
      const allNodes = useNodeStore.getState().nodeList
      const rects = allNodes.map(n => {
        const size = nodePixelSize(n)
        return { x: n.x - size.width / 2, y: n.y - size.height / 2, ...size }
      })
      rects.push({ x: -ROOT_NODE_RADIUS, y: -ROOT_NODE_RADIUS, width: ROOT_NODE_RADIUS * 2, height: ROOT_NODE_RADIUS * 2 })
      const bounds = unionBounds(rects)
      if (!bounds) return
      const viewport = document.querySelector('.canvas-viewport') as HTMLElement | null
      if (!viewport) return
      flyTo(cameraToFitBounds(bounds, viewport.clientWidth, viewport.clientHeight, 0.05, UNFOCUS_SNAP_ZOOM))
    })
  }, [initialSyncDone, flyTo])

  // Force-directed layout
  const draggingRef = useRef(new Set<string>())
  const { playing: forceLayoutPlaying, speed: forceLayoutSpeed, togglePlaying: forceLayoutToggle, increaseSpeed: forceLayoutIncrease, decreaseSpeed: forceLayoutDecrease } = useForceLayout({
    draggingRef,
    batchMoveNodes
  })

  const handleDragStart = useCallback((id: string) => {
    draggingRef.current.add(id)
  }, [])

  const handleDragEnd = useCallback((id: string) => {
    draggingRef.current.delete(id)
    // Send final position to server
    const node = useNodeStore.getState().nodes[id]
    if (node) {
      sendMove(id, node.x, node.y)
    }
  }, [])

  // CWD tracking — ref so updates don't trigger re-renders
  const cwdMapRef = useRef(new Map<string, string>())
  const forkHistoryLengthRef = useRef(new Map<string, number>())

  const handleCwdChange = useCallback((id: string, cwd: string) => {
    cwdMapRef.current.set(id, cwd)
  }, [])

  const handleShellTitleChange = useCallback((id: string, title: string) => {
    const stripped = title.replace(/^[^\x20-\x7E]+\s*/, '').trim()
    if (!stripped) return
    // Title is handled by the server now, no client state update needed
  }, [])

  const handleShellTitleHistoryChange = useCallback((_id: string, _history: string[]) => {
    // Handled by server → store
  }, [])

  const computeChildPosition = useCallback((parentId: string) => {
    const allNodes = useNodeStore.getState().nodes
    const allNodeList = Object.values(allNodes)

    let parentCenter: { x: number; y: number }
    let grandparentCenter: { x: number; y: number } | null = null
    let cwd: string | undefined

    if (parentId === 'root') {
      parentCenter = { x: 0, y: 0 }
    } else {
      const parent = allNodes[parentId]
      if (!parent) return { position: { x: 0, y: 0 }, cwd: undefined }

      parentCenter = { x: parent.x, y: parent.y }
      cwd = cwdMapRef.current.get(parentId) ?? (parent.type === 'terminal' ? parent.cwd : undefined)

      if (parent.parentId === 'root') {
        grandparentCenter = { x: 0, y: 0 }
      } else {
        const gp = allNodes[parent.parentId]
        if (gp) {
          grandparentCenter = { x: gp.x, y: gp.y }
        }
      }
    }

    const siblings = allNodeList.filter(n => n.parentId === parentId)
    const siblingCenters = siblings.map(s => ({ x: s.x, y: s.y }))

    const position = computeChildPlacement(parentCenter, grandparentCenter, siblingCenters, CHILD_PLACEMENT_DISTANCE)
    return { position, cwd }
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
      const node = useNodeStore.getState().nodes[nodeId]
      if (!node) {
        // Node not in state yet (newly created).
        setScrollMode(false)
        return
      }
      const size = nodePixelSize(node)
      bounds = { x: node.x - size.width / 2, y: node.y - size.height / 2, ...size }
      setScrollMode(node.type === 'terminal' && node.alive)
      sendBringToFront(nodeId)
      bringToFront(nodeId)
    }

    flyTo(cameraToFitBounds(bounds, viewport.clientWidth, viewport.clientHeight, padding))
  }, [bringToFront, flyTo])

  const handleClaudeSessionHistoryChange = useCallback((id: string, history: ClaudeSessionEntry[]) => {
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
        sendTerminalCreate(id, position.x, position.y, buildClaudeCodeOptions({ cwd, resumeSessionId })).then((result) => {
          if (cwd) cwdMapRef.current.set(result.sessionId, cwd)
          handleNodeFocus(result.sessionId)
        })
      }
    }
  }, [computeChildPosition, handleNodeFocus])

  const handleRemoveNode = useCallback(async (id: string) => {
    cwdMapRef.current.delete(id)
    if (focusRef.current === id) {
      focusRef.current = null
      setFocusedId(null)
      setScrollMode(false)
    }
    await sendArchive(id)
  }, [])

  const handleTerminalExit = useCallback((id: string, _exitCode: number) => {
    // Server handles state transition (alive → false) via node-updated broadcast.
    // We just handle focus cleanup here.
    if (focusRef.current === id) {
      focusRef.current = null
      setFocusedId(null)
      setScrollMode(false)
    }
  }, [])

  const addTerminalAsChild = useCallback(async (parentId: string) => {
    const { position, cwd } = computeChildPosition(parentId)
    const result = await sendTerminalCreate(parentId, position.x, position.y, cwd ? { cwd } : undefined)
    if (cwd) cwdMapRef.current.set(result.sessionId, cwd)
  }, [computeChildPosition])

  const addClaudeCodeAsChild = useCallback(async (parentId: string) => {
    const { position, cwd } = computeChildPosition(parentId)
    const result = await sendTerminalCreate(parentId, position.x, position.y, buildClaudeCodeOptions({ cwd }))
    if (cwd) cwdMapRef.current.set(result.sessionId, cwd)
  }, [computeChildPosition])

  const handleResumeSession = useCallback(async (remnantId: string, claudeSessionId: string) => {
    const remnant = useNodeStore.getState().nodes[remnantId]
    const cwd = remnant?.type === 'terminal' ? remnant.cwd : undefined
    // Reincarnate the remnant in-place with claude -r to resume the session
    await sendTerminalReincarnate(remnantId, buildClaudeCodeOptions({ cwd, resumeSessionId: claudeSessionId }))
    if (cwd) cwdMapRef.current.set(remnantId, cwd)
    // The node-updated broadcast will flip alive=true and set sessionId
    handleNodeFocus(remnantId)
  }, [handleNodeFocus])

  const fitAllNodes = useCallback(() => {
    const allNodeList = useNodeStore.getState().nodeList
    const rects = allNodeList.map(n => {
      const size = nodePixelSize(n)
      return { x: n.x - size.width / 2, y: n.y - size.height / 2, ...size }
    })
    // Include root node in bounds
    rects.push({ x: -ROOT_NODE_RADIUS, y: -ROOT_NODE_RADIUS, width: ROOT_NODE_RADIUS * 2, height: ROOT_NODE_RADIUS * 2 })
    const bounds = unionBounds(rects)
    if (!bounds) return
    const viewport = document.querySelector('.canvas-viewport') as HTMLElement | null
    if (!viewport) return
    const target = cameraToFitBounds(bounds, viewport.clientWidth, viewport.clientHeight, 0.05, UNFOCUS_SNAP_ZOOM)
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

  // Handlers that send mutations to server
  const handleMove = useCallback((id: string, x: number, y: number) => {
    moveNode(id, x, y)
  }, [moveNode])

  const handleRename = useCallback((id: string, name: string) => {
    renameNode(id, name)
    sendRename(id, name)
  }, [renameNode])

  const handleColorChange = useCallback((id: string, colorPresetId: string) => {
    setNodeColor(id, colorPresetId)
    sendSetColor(id, colorPresetId)
  }, [setNodeColor])

  const handleResizeTerminal = useCallback((id: string, cols: number, rows: number) => {
    sendTerminalResize(id, cols, rows)
  }, [])

  const handleResizeMarkdown = useCallback((id: string, width: number, height: number) => {
    sendMarkdownResize(id, width, height)
  }, [])

  const handleMarkdownContent = useCallback((id: string, content: string) => {
    sendMarkdownContent(id, content)
  }, [])

  // Global keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = async (e: KeyboardEvent) => {
      if (e.metaKey && e.key === 't') {
        e.preventDefault()
        e.stopPropagation()
        if (!focusRef.current) return
        const { position, cwd } = computeChildPosition(focusRef.current)
        const result = await sendTerminalCreate(focusRef.current, position.x, position.y, cwd ? { cwd } : undefined)
        if (cwd) cwdMapRef.current.set(result.sessionId, cwd)
        handleNodeFocus(result.sessionId)
      }

      if (e.metaKey && e.key === 'e') {
        e.preventDefault()
        e.stopPropagation()
        if (!focusRef.current) return
        const { position, cwd } = computeChildPosition(focusRef.current)
        const result = await sendTerminalCreate(focusRef.current, position.x, position.y, buildClaudeCodeOptions({ cwd }))
        if (cwd) cwdMapRef.current.set(result.sessionId, cwd)
        handleNodeFocus(result.sessionId)
      }

      if (e.metaKey && e.key === 'm') {
        e.preventDefault()
        e.stopPropagation()
        const parentId = focusRef.current ?? 'root'
        const { position } = computeChildPosition(parentId)
        await sendMarkdownAdd(parentId, position.x, position.y)
        // The node will be added via server broadcast → store
        // We can't focus it yet since we don't know its ID
        // The server will broadcast node-added with the ID
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
  }, [computeChildPosition, handleNodeFocus, speak, ttsStop, isSpeaking])

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
        <TreeLines nodes={nodeList.map((n): TreeLineNode => (
          { id: n.id, parentId: n.parentId, x: n.x, y: n.y }
        ))} />
        <RootNode focused={focusedId === 'root'} onClick={() => handleNodeFocus('root')} />
        {liveTerminals.map((t) => (
          <TerminalCard
            key={t.id}
            id={t.id}
            sessionId={t.sessionId}
            x={t.x}
            y={t.y}
            cols={t.cols}
            rows={t.rows}
            zIndex={t.zIndex}
            zoom={camera.z}
            name={t.name}
            colorPresetId={t.colorPresetId}
            shellTitleHistory={t.shellTitleHistory}
            cwd={t.cwd}
            focused={focusedId === t.id}
            scrollMode={scrollMode}
            onFocus={handleNodeFocus}
            onUnfocus={handleUnfocus}
            onDisableScrollMode={handleDisableScrollMode}
            onClose={handleRemoveNode}
            onMove={handleMove}
            onResize={handleResizeTerminal}
            onRename={handleRename}
            onColorChange={handleColorChange}
            onCwdChange={handleCwdChange}
            onShellTitleChange={handleShellTitleChange}
            onShellTitleHistoryChange={handleShellTitleHistoryChange}
            claudeSessionHistory={t.claudeSessionHistory}
            onClaudeSessionHistoryChange={handleClaudeSessionHistoryChange}
            waitingForUser={t.waitingForUser}
            onExit={handleTerminalExit}
            onNodeReady={handleNodeReady}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
          />
        ))}
        {deadTerminals.map((r) => (
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
            exitCode={r.exitCode ?? 0}
            focused={focusedId === r.id}
            onFocus={handleNodeFocus}
            onClose={handleRemoveNode}
            onMove={handleMove}
            onRename={handleRename}
            onColorChange={handleColorChange}
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
            onMove={handleMove}
            onResize={handleResizeMarkdown}
            onContentChange={handleMarkdownContent}
            onRename={handleRename}
            onColorChange={handleColorChange}
            onNodeReady={handleNodeReady}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
          />
        ))}
      </Canvas>
    </div>
  )
}
