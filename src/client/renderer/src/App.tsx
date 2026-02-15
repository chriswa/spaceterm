import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Canvas } from './components/Canvas'
import { Toast } from './components/Toast'
import { RootNode } from './components/RootNode'
import { TerminalCard, terminalSelectionGetters } from './components/TerminalCard'
import { RemnantCard } from './components/RemnantCard'
import { MarkdownCard } from './components/MarkdownCard'
import { DirectoryCard } from './components/DirectoryCard'
import { CanvasBackground } from './components/CanvasBackground'
import type { TreeLineNode } from './components/CanvasBackground'
import { ReparentPreviewLine } from './components/ReparentPreviewLine'
import { Toolbar } from './components/Toolbar'
import { useCamera } from './hooks/useCamera'
import { useTTS } from './hooks/useTTS'
import { useForceLayout } from './hooks/useForceLayout'
import { cameraToFitBounds, unionBounds } from './lib/camera'
import { CHILD_PLACEMENT_DISTANCE, ROOT_NODE_RADIUS, UNFOCUS_SNAP_ZOOM } from './lib/constants'
import { computeChildPlacement } from './lib/tree-placement'
import { isDescendantOf, getDescendantIds, getAncestorCwd } from './lib/tree-utils'
import { useNodeStore, nodePixelSize } from './stores/nodeStore'
import { useReparentStore } from './stores/reparentStore'
import { useShaderStore } from './stores/shaderStore'
import { useEdgesStore } from './stores/edgesStore'
import { initServerSync, sendMove, sendBatchMove, sendRename, sendSetColor, sendBringToFront, sendArchive, sendUnarchive, sendArchiveDelete, sendTerminalCreate, sendTerminalReincarnate, sendMarkdownAdd, sendMarkdownResize, sendMarkdownContent, sendTerminalResize, sendReparent, sendDirectoryAdd, sendDirectoryCwd } from './lib/server-sync'

const archiveDismissFlag = { active: false, timer: 0 }

function buildClaudeCodeOptions({ prompt, cwd, resumeSessionId }: { prompt?: string; cwd?: string; resumeSessionId?: string } = {}): CreateOptions {
  const statusLineSettings = JSON.stringify({
    statusLine: {
      type: 'command',
      command: 'src/claude-code-plugin/scripts/statusline-handler.sh'
    }
  })
  const args = ['--plugin-dir', 'src/claude-code-plugin', '--settings', statusLineSettings]
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
  const [toasts, setToasts] = useState<Array<{ id: number; message: string; exiting?: boolean }>>([])
  const toastIdRef = useRef(0)
  const focusRef = useRef<string | null>(focusedId)
  focusRef.current = focusedId

  const { speak, stop: ttsStop, isSpeaking } = useTTS()
  const { camera, cameraRef, surfaceRef, handleWheel, handlePanStart, resetCamera, flyTo, flyToUnfocusZoom, inputDevice, toggleInputDevice } = useCamera(undefined, focusRef)

  // Subscribe to store
  const nodes = useNodeStore(s => s.nodes)
  const nodeList = useNodeStore(s => s.nodeList)
  const liveTerminals = useNodeStore(s => s.liveTerminals)
  const deadTerminals = useNodeStore(s => s.deadTerminals)
  const markdowns = useNodeStore(s => s.markdowns)
  const directories = useNodeStore(s => s.directories)
  const rootArchivedChildren = useNodeStore(s => s.rootArchivedChildren)
  const moveNode = useNodeStore(s => s.moveNode)
  const batchMoveNodes = useNodeStore(s => s.batchMoveNodes)
  const renameNode = useNodeStore(s => s.renameNode)
  const setNodeColor = useNodeStore(s => s.setNodeColor)
  const bringToFront = useNodeStore(s => s.bringToFront)

  const treeLineNodes = useMemo(() =>
    nodeList.map((n): TreeLineNode => ({ id: n.id, parentId: n.parentId, x: n.x, y: n.y })),
    [nodeList]
  )
  const edgesRef = useRef<TreeLineNode[]>([])
  edgesRef.current = treeLineNodes

  const shadersEnabled = useShaderStore(s => s.shadersEnabled)
  const edgesEnabled = useEdgesStore(s => s.edgesEnabled)

  // Reparent mode state
  const reparentingNodeId = useReparentStore(s => s.reparentingNodeId)
  const reparentHoveredNodeId = useReparentStore(s => s.hoveredNodeId)

  // Initialize server sync on mount
  useEffect(() => {
    initServerSync()
  }, [])

  // Subscribe to server errors → toast notifications
  useEffect(() => {
    const cleanup = window.api.node.onServerError((message: string) => {
      console.error('[server]', message)
      const id = ++toastIdRef.current
      setToasts((prev) => [...prev, { id, message }])
      setTimeout(() => {
        setToasts((prev) => prev.map((t) => t.id === id ? { ...t, exiting: true } : t))
        setTimeout(() => {
          setToasts((prev) => prev.filter((t) => t.id !== id))
        }, 200)
      }, 5000)
    })
    return cleanup
  }, [])

  const dismissToast = useCallback((id: number) => {
    setToasts((prev) => prev.map((t) => t.id === id ? { ...t, exiting: true } : t))
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id))
    }, 200)
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
  const dragDescendantsRef = useRef<string[]>([])
  const { playing: forceLayoutPlaying, speed: forceLayoutSpeed, togglePlaying: forceLayoutToggle, increaseSpeed: forceLayoutIncrease, decreaseSpeed: forceLayoutDecrease } = useForceLayout({
    draggingRef,
    batchMoveNodes
  })

  const handleDragStart = useCallback((id: string) => {
    draggingRef.current.add(id)
    const descendants = getDescendantIds(useNodeStore.getState().nodes, id)
    dragDescendantsRef.current = descendants
    for (const d of descendants) {
      draggingRef.current.add(d)
    }
  }, [])

  const handleDragEnd = useCallback((id: string) => {
    const descendants = dragDescendantsRef.current
    draggingRef.current.delete(id)
    for (const d of descendants) {
      draggingRef.current.delete(d)
    }
    dragDescendantsRef.current = []

    // Send final positions to server for dragged node + descendants
    const allNodes = useNodeStore.getState().nodes
    const moves: Array<{ nodeId: string; x: number; y: number }> = []
    const node = allNodes[id]
    if (node) {
      moves.push({ nodeId: id, x: node.x, y: node.y })
    }
    for (const d of descendants) {
      const dn = allNodes[d]
      if (dn) {
        moves.push({ nodeId: d, x: dn.x, y: dn.y })
      }
    }
    if (moves.length > 0) {
      sendBatchMove(moves)
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
      cwd = getAncestorCwd(allNodes, parentId, cwdMapRef.current)

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

  const handleReparentTarget = useCallback((targetId: string) => {
    const srcId = useReparentStore.getState().reparentingNodeId
    if (!srcId) return

    const allNodes = useNodeStore.getState().nodes
    const srcNode = allNodes[srcId]
    const isInvalid = targetId === srcId || isDescendantOf(allNodes, targetId, srcId) || (srcNode && srcNode.parentId === targetId)

    if (isInvalid) {
      useReparentStore.getState().reset()
      handleNodeFocus(srcId)
      return
    }

    sendReparent(srcId, targetId)
    useReparentStore.getState().reset()

    // Fly camera to fit bounds of both nodes
    const viewport = document.querySelector('.canvas-viewport') as HTMLElement | null
    if (!viewport) return
    const tgtNode = allNodes[targetId]
    if (srcNode && tgtNode) {
      const srcSize = nodePixelSize(srcNode)
      const tgtSize = nodePixelSize(tgtNode)
      const bounds = unionBounds([
        { x: srcNode.x - srcSize.width / 2, y: srcNode.y - srcSize.height / 2, ...srcSize },
        { x: tgtNode.x - tgtSize.width / 2, y: tgtNode.y - tgtSize.height / 2, ...tgtSize },
      ])
      if (bounds) {
        flyTo(cameraToFitBounds(bounds, viewport.clientWidth, viewport.clientHeight, 0.05, UNFOCUS_SNAP_ZOOM))
      }
    }
  }, [flyTo, handleNodeFocus])

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

  const handleUnarchive = useCallback(async (parentNodeId: string, archivedNodeId: string) => {
    await sendUnarchive(parentNodeId, archivedNodeId)
  }, [])

  const handleArchiveDelete = useCallback(async (parentNodeId: string, archivedNodeId: string) => {
    await sendArchiveDelete(parentNodeId, archivedNodeId)
  }, [])

  const handleArchiveToggled = useCallback((nodeId: string, open: boolean) => {
    if (!open) {
      archiveDismissFlag.active = true
      clearTimeout(archiveDismissFlag.timer)
      archiveDismissFlag.timer = window.setTimeout(() => { archiveDismissFlag.active = false }, 500)
    }
    const viewport = document.querySelector('.canvas-viewport') as HTMLElement
    if (!viewport) return
    let bounds: { x: number; y: number; width: number; height: number }
    if (nodeId === 'root') {
      bounds = { x: -ROOT_NODE_RADIUS, y: -ROOT_NODE_RADIUS, width: ROOT_NODE_RADIUS * 2, height: ROOT_NODE_RADIUS * 2 }
    } else {
      const node = useNodeStore.getState().nodes[nodeId]
      if (!node) return
      const size = nodePixelSize(node)
      bounds = { x: node.x - size.width / 2, y: node.y - size.height / 2, ...size }
    }
    flyTo(cameraToFitBounds(bounds, viewport.clientWidth, viewport.clientHeight, 0.025))
  }, [flyTo])

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
    if (remnant?.type !== 'terminal') return
    const cwd = remnant.cwd

    const history = remnant.claudeSessionHistory ?? []
    const isMostRecent = history.length > 0 && history[history.length - 1].claudeSessionId === claudeSessionId

    if (isMostRecent) {
      // Reincarnate the remnant in-place with claude -r to resume the session
      await sendTerminalReincarnate(remnantId, buildClaudeCodeOptions({ cwd, resumeSessionId: claudeSessionId }))
      if (cwd) cwdMapRef.current.set(remnantId, cwd)
      handleNodeFocus(remnantId)
    } else {
      // Spawn a new terminal surface for older sessions
      const { position } = computeChildPosition(remnant.parentId)
      const result = await sendTerminalCreate(
        remnant.parentId,
        position.x, position.y,
        buildClaudeCodeOptions({ cwd, resumeSessionId: claudeSessionId }),
        remnant.shellTitleHistory
      )
      if (cwd) cwdMapRef.current.set(result.sessionId, cwd)
      handleNodeFocus(result.sessionId)
    }
  }, [handleNodeFocus, computeChildPosition])

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

  const handleStartReparent = useCallback((nodeId: string) => {
    useReparentStore.getState().startReparent(nodeId)
    handleUnfocus()
    flyToUnfocusZoom()
  }, [handleUnfocus, flyToUnfocusZoom])

  const handleDisableScrollMode = useCallback(() => {
    setScrollMode(false)
  }, [])

  // Handlers that send mutations to server
  const handleMove = useCallback((id: string, x: number, y: number) => {
    const currentNode = useNodeStore.getState().nodes[id]
    const descendants = dragDescendantsRef.current
    if (currentNode && descendants.length > 0) {
      const dx = x - currentNode.x
      const dy = y - currentNode.y
      moveNode(id, x, y)
      batchMoveNodes(descendants.map(d => ({ id: d, dx, dy })))
    } else {
      moveNode(id, x, y)
    }
  }, [moveNode, batchMoveNodes])

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

  const handleDirectoryCwdChange = useCallback((id: string, newCwd: string) => {
    cwdMapRef.current.set(id, newCwd)
    sendDirectoryCwd(id, newCwd)
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
      }

      if (e.metaKey && e.key === 'd') {
        e.preventDefault()
        e.stopPropagation()
        if (!focusRef.current) return
        const { position, cwd } = computeChildPosition(focusRef.current)
        await sendDirectoryAdd(focusRef.current, position.x, position.y, cwd ?? '~')
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

      // Escape: cancel reparent mode or stop TTS
      if (e.key === 'Escape') {
        const srcId = useReparentStore.getState().reparentingNodeId
        if (srcId) {
          useReparentStore.getState().reset()
          handleNodeFocus(srcId)
          return
        }
        if (isSpeaking()) {
          ttsStop()
        }
      }
    }
    window.addEventListener('keydown', handleKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true })
  }, [computeChildPosition, handleNodeFocus, speak, ttsStop, isSpeaking])

  // Globally suppress Chromium's Tab focus navigation.
  // Bubble phase so xterm / CodeMirror process the key first.
  useEffect(() => {
    const suppressTab = (e: KeyboardEvent) => {
      if (e.key === 'Tab') e.preventDefault()
    }
    window.addEventListener('keydown', suppressTab)
    return () => window.removeEventListener('keydown', suppressTab)
  }, [])

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
    if (archiveDismissFlag.active) {
      handlePanStart(e)
      return
    }
    if (focusRef.current) {
      handleUnfocus()
      flyToUnfocusZoom()
    }
    handlePanStart(e)
  }, [handlePanStart, flyToUnfocusZoom, handleUnfocus])

  const handleCanvasUnfocus = useCallback(() => {
    if (archiveDismissFlag.active) {
      archiveDismissFlag.active = false
      return
    }
    const srcId = useReparentStore.getState().reparentingNodeId
    if (srcId) {
      useReparentStore.getState().reset()
      handleNodeFocus(srcId)
      return
    }
    handleUnfocus()
    flyToUnfocusZoom()
  }, [handleUnfocus, flyToUnfocusZoom, handleNodeFocus])

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
      <Canvas camera={camera} surfaceRef={surfaceRef} onWheel={handleCanvasWheel} onPanStart={handleCanvasPanStart} onCanvasClick={handleCanvasUnfocus} onDoubleClick={fitAllNodes} background={(shadersEnabled || edgesEnabled) ? <CanvasBackground camera={camera} cameraRef={cameraRef} edgesRef={edgesRef} edgesEnabled={edgesEnabled} shadersEnabled={shadersEnabled} /> : null}>
        <RootNode
          focused={focusedId === 'root'}
          onClick={() => handleNodeFocus('root')}
          archivedChildren={rootArchivedChildren}
          onUnarchive={handleUnarchive}
          onArchiveDelete={handleArchiveDelete}
          onArchiveToggled={handleArchiveToggled}
        />
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
            archivedChildren={t.archivedChildren}
            onColorChange={handleColorChange}
            onUnarchive={handleUnarchive}
            onArchiveDelete={handleArchiveDelete}
            onArchiveToggled={handleArchiveToggled}
            onCwdChange={handleCwdChange}
            onShellTitleChange={handleShellTitleChange}
            onShellTitleHistoryChange={handleShellTitleHistoryChange}
            claudeSessionHistory={t.claudeSessionHistory}
            onClaudeSessionHistoryChange={handleClaudeSessionHistoryChange}
            claudeState={t.claudeState}
            onExit={handleTerminalExit}
            onNodeReady={handleNodeReady}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
            onStartReparent={handleStartReparent}
            onReparentTarget={handleReparentTarget}
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
            archivedChildren={r.archivedChildren}
            shellTitleHistory={r.shellTitleHistory}
            cwd={r.cwd}
            claudeSessionHistory={r.claudeSessionHistory}
            terminalSessions={r.terminalSessions}
            exitCode={r.exitCode ?? 0}
            focused={focusedId === r.id}
            onFocus={handleNodeFocus}
            onClose={handleRemoveNode}
            onMove={handleMove}
            onRename={handleRename}
            onColorChange={handleColorChange}
            onUnarchive={handleUnarchive}
            onArchiveDelete={handleArchiveDelete}
            onArchiveToggled={handleArchiveToggled}
            onResumeSession={handleResumeSession}
            onNodeReady={handleNodeReady}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
            onStartReparent={handleStartReparent}
            onReparentTarget={handleReparentTarget}
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
            archivedChildren={m.archivedChildren}
            focused={focusedId === m.id}
            onFocus={handleNodeFocus}
            onClose={handleRemoveNode}
            onMove={handleMove}
            onResize={handleResizeMarkdown}
            onContentChange={handleMarkdownContent}
            onRename={handleRename}
            onColorChange={handleColorChange}
            onUnarchive={handleUnarchive}
            onArchiveDelete={handleArchiveDelete}
            onArchiveToggled={handleArchiveToggled}
            onNodeReady={handleNodeReady}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
            onStartReparent={handleStartReparent}
            onReparentTarget={handleReparentTarget}
          />
        ))}
        {directories.map((d) => (
          <DirectoryCard
            key={d.id}
            id={d.id}
            x={d.x}
            y={d.y}
            zIndex={d.zIndex}
            zoom={camera.z}
            cwd={d.cwd}
            colorPresetId={d.colorPresetId}
            archivedChildren={d.archivedChildren}
            focused={focusedId === d.id}
            onFocus={handleNodeFocus}
            onClose={handleRemoveNode}
            onMove={handleMove}
            onCwdChange={handleDirectoryCwdChange}
            onColorChange={handleColorChange}
            onUnarchive={handleUnarchive}
            onArchiveDelete={handleArchiveDelete}
            onArchiveToggled={handleArchiveToggled}
            onNodeReady={handleNodeReady}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
            onStartReparent={handleStartReparent}
            onReparentTarget={handleReparentTarget}
          />
        ))}
        {edgesEnabled && reparentingNodeId && reparentHoveredNodeId && (() => {
          const allNodes = useNodeStore.getState().nodes
          const srcNode = allNodes[reparentingNodeId]
          const isInvalid = reparentHoveredNodeId === reparentingNodeId || isDescendantOf(allNodes, reparentHoveredNodeId, reparentingNodeId) || (srcNode && srcNode.parentId === reparentHoveredNodeId)
          if (isInvalid) return null
          const tgtNode = allNodes[reparentHoveredNodeId]
          if (!srcNode || !tgtNode) return null
          return <ReparentPreviewLine fromX={tgtNode.x} fromY={tgtNode.y} toX={srcNode.x} toY={srcNode.y} />
        })()}
      </Canvas>
      <Toast toasts={toasts} onDismiss={dismissToast} />
    </div>
  )
}
