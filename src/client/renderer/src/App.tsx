import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Canvas } from './components/Canvas'
import { Toast } from './components/Toast'
import { RootNode } from './components/RootNode'
import { TerminalCard, terminalSelectionGetters } from './components/TerminalCard'
import { MarkdownCard } from './components/MarkdownCard'
import { DirectoryCard } from './components/DirectoryCard'
import { CanvasBackground } from './components/CanvasBackground'
import type { TreeLineNode, MaskRect } from './components/CanvasBackground'
import { ReparentPreviewLine } from './components/ReparentPreviewLine'
import { Toolbar } from './components/Toolbar'
import { useCamera } from './hooks/useCamera'
import { useTTS } from './hooks/useTTS'
import { useEdgeHover } from './hooks/useEdgeHover'
import { useForceLayout } from './hooks/useForceLayout'
import { useBeatPulse } from './hooks/useBeatPulse'
import { cameraToFitBounds, unionBounds, screenToCanvas } from './lib/camera'
import { CHILD_PLACEMENT_DISTANCE, ROOT_NODE_RADIUS, UNFOCUS_SNAP_ZOOM } from './lib/constants'
import { computeChildPlacement } from './lib/tree-placement'
import { isDescendantOf, getDescendantIds, getAncestorCwd, resolveInheritedPreset } from './lib/tree-utils'
import { useNodeStore, nodePixelSize } from './stores/nodeStore'
import { useReparentStore } from './stores/reparentStore'
import { useShaderStore } from './stores/shaderStore'
import { useEdgesStore } from './stores/edgesStore'
import { useAudioStore } from './stores/audioStore'
import { initServerSync, sendMove, sendBatchMove, sendRename, sendSetColor, sendBringToFront, sendArchive, sendUnarchive, sendArchiveDelete, sendTerminalCreate, sendMarkdownAdd, sendMarkdownResize, sendMarkdownContent, sendTerminalResize, sendReparent, sendDirectoryAdd, sendDirectoryCwd } from './lib/server-sync'

interface CrabEntry { nodeId: string; color: 'white' | 'red' | 'purple' | 'orange'; addedAt: number }

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
  // Track "stopped unviewed" state for terminal animations
  const prevClaudeStatesRef = useRef<Map<string, string>>(new Map())
  const [stoppedUnviewedIds, setStoppedUnviewedIds] = useState<Set<string>>(new Set())
  const focusRef = useRef<string | null>(focusedId)
  focusRef.current = focusedId
  const lastFocusedRef = useRef<string | null>(null)
  const navStackRef = useRef<string[]>([])
  const crabTimestampsRef = useRef<Map<string, number>>(new Map())

  const { speak, stop: ttsStop, isSpeaking } = useTTS()
  const { camera, cameraRef, surfaceRef, handleWheel, handlePanStart, resetCamera, flyTo, snapToTarget, flyToUnfocusZoom, rotationalFlyTo, inputDevice, toggleInputDevice, restoredFromStorageRef } = useCamera(undefined, focusRef)

  // Subscribe to store
  const nodes = useNodeStore(s => s.nodes)
  const nodeList = useNodeStore(s => s.nodeList)
  const liveTerminals = useNodeStore(s => s.liveTerminals)
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

  const maskRects = useMemo(() =>
    markdowns.map((n): MaskRect => ({ x: n.x, y: n.y, width: n.width, height: n.height })),
    [markdowns]
  )
  const maskRectsRef = useRef<MaskRect[]>([])
  maskRectsRef.current = maskRects

  // Resolve inherited color presets for all nodes
  const resolvedPresets = useMemo(() => {
    const map: Record<string, import('./lib/color-presets').ColorPreset> = {}
    for (const id in nodes) {
      map[id] = resolveInheritedPreset(nodes, id)
    }
    return map
  }, [nodes])

  const shadersEnabled = useShaderStore(s => s.shadersEnabled)
  const edgesEnabled = useEdgesStore(s => s.edgesEnabled)

  // Derive crab indicators for toolbar
  const crabs = useMemo(() => {
    const timestamps = crabTimestampsRef.current
    const entries: CrabEntry[] = []
    const activeIds = new Set<string>()

    for (const node of Object.values(nodes)) {
      if (node.type !== 'terminal') continue
      let color: CrabEntry['color'] | null = null
      if (node.claudeState === 'working') {
        color = 'orange'
      } else if (node.claudeState === 'waiting_permission') {
        color = 'red'
      } else if (node.claudeState === 'waiting_plan') {
        color = 'purple'
      } else if (node.claudeState === 'stopped' && stoppedUnviewedIds.has(node.id)) {
        color = 'white'
      }
      if (color) {
        activeIds.add(node.id)
        if (!timestamps.has(node.id)) timestamps.set(node.id, Date.now())
        entries.push({ nodeId: node.id, color, addedAt: timestamps.get(node.id)! })
      }
    }

    // Clean up timestamps for nodes that no longer have a crab
    for (const id of timestamps.keys()) {
      if (!activeIds.has(id)) timestamps.delete(id)
    }

    // Sort: working (orange) crabs first, then by arrival time
    entries.sort((a, b) => {
      const aWorking = a.color === 'orange' ? 0 : 1
      const bWorking = b.color === 'orange' ? 0 : 1
      if (aWorking !== bWorking) return aWorking - bWorking
      return a.addedAt - b.addedAt
    })
    return entries
  }, [nodes, stoppedUnviewedIds])

  // Reparent mode state
  const reparentingNodeId = useReparentStore(s => s.reparentingNodeId)
  const reparentHoveredNodeId = useReparentStore(s => s.hoveredNodeId)

  // Edge hover detection for edge splitting
  const { hoveredEdge, hoveredEdgeRef } = useEdgeHover(cameraRef, edgesRef, edgesEnabled, !!reparentingNodeId)

  // Toggle cursor when hovering an edge
  useEffect(() => {
    const viewport = document.querySelector('.canvas-viewport') as HTMLElement | null
    if (!viewport) return
    if (hoveredEdge) {
      viewport.style.cursor = 'pointer'
      return () => { viewport.style.cursor = '' }
    }
  }, [hoveredEdge])

  // Initialize server sync on mount
  useEffect(() => {
    initServerSync()
  }, [])

  // Initialize audio beat detection
  useEffect(() => {
    const cleanup = useAudioStore.getState().init()
    return cleanup
  }, [])

  // Drive pulse CSS vars from beat detection
  useBeatPulse()

  // Track the focused node's parent so we can fly to it if the focused node disappears
  const focusedParentRef = useRef<string | null>(null)
  useEffect(() => {
    if (!focusedId) {
      focusedParentRef.current = null
      return
    }
    const node = useNodeStore.getState().nodes[focusedId]
    focusedParentRef.current = node ? node.parentId : null
  }, [focusedId])

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
      const viewport = document.querySelector('.canvas-viewport') as HTMLElement | null
      if (!viewport) return
      const vw = viewport.clientWidth
      const vh = viewport.clientHeight

      if (restoredFromStorageRef.current) {
        // Camera was restored from localStorage — check if any nodes are visible
        const cam = cameraRef.current
        const topLeft = screenToCanvas({ x: 0, y: 0 }, cam)
        const bottomRight = screenToCanvas({ x: vw, y: vh }, cam)
        const allNodes = useNodeStore.getState().nodeList

        const hasVisibleNode = allNodes.some(n => {
          const size = nodePixelSize(n)
          const half = { w: size.width / 2, h: size.height / 2 }
          return (n.x + half.w > topLeft.x && n.x - half.w < bottomRight.x &&
                  n.y + half.h > topLeft.y && n.y - half.h < bottomRight.y)
        })
        // Also check root node at origin
        if (hasVisibleNode ||
            (ROOT_NODE_RADIUS > topLeft.x && -ROOT_NODE_RADIUS < bottomRight.x &&
             ROOT_NODE_RADIUS > topLeft.y && -ROOT_NODE_RADIUS < bottomRight.y)) {
          return  // User can see something — keep restored camera
        }
      }

      // Nothing visible (or no stored camera) → teleport to origin zoomed in, fly out
      const allNodes = useNodeStore.getState().nodeList
      const rects = allNodes.map(n => {
        const size = nodePixelSize(n)
        return { x: n.x - size.width / 2, y: n.y - size.height / 2, ...size }
      })
      rects.push({ x: -ROOT_NODE_RADIUS, y: -ROOT_NODE_RADIUS, width: ROOT_NODE_RADIUS * 2, height: ROOT_NODE_RADIUS * 2 })
      const bounds = unionBounds(rects)
      if (!bounds) return

      resetCamera()  // instant teleport to origin, zoomed in at z:10
      flyTo(cameraToFitBounds(bounds, vw, vh, 0.05, UNFOCUS_SNAP_ZOOM))
    })
  }, [initialSyncDone, flyTo, resetCamera])

  // Force-directed layout
  const draggingRef = useRef(new Set<string>())
  const dragDescendantsRef = useRef<string[]>([])
  const { playing: forceLayoutPlaying, speed: forceLayoutSpeed, togglePlaying: forceLayoutToggle, increaseSpeed: forceLayoutIncrease, decreaseSpeed: forceLayoutDecrease } = useForceLayout({
    draggingRef,
    batchMoveNodes
  })

  const handleDragStart = useCallback((id: string, solo?: boolean) => {
    draggingRef.current.add(id)
    if (solo) {
      dragDescendantsRef.current = []
    } else {
      const descendants = getDescendantIds(useNodeStore.getState().nodes, id)
      dragDescendantsRef.current = descendants
      for (const d of descendants) {
        draggingRef.current.add(d)
      }
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

  const flashNode = useCallback((nodeId: string) => {
    const el = document.querySelector(`[data-node-id="${nodeId}"]`)?.firstElementChild as HTMLElement | null
    if (!el) return
    el.classList.remove('card-shell--selection-flash')
    void el.offsetWidth
    el.classList.add('card-shell--selection-flash')
  }, [])

  const handleNodeFocus = useCallback((nodeId: string) => {
    flashNode(nodeId)
    setFocusedId(nodeId)
    lastFocusedRef.current = nodeId
    navStackRef.current = []

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
    await sendArchive(id)
    // Focus cleanup + fly-to handled by Zustand subscription when node-removed arrives
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

  const flyToParentAndChildren = useCallback((parentId: string) => {
    const viewport = document.querySelector('.canvas-viewport') as HTMLElement | null
    if (!viewport) return

    const allNodes = useNodeStore.getState().nodes
    const rects: Array<{ x: number; y: number; width: number; height: number }> = []

    if (parentId === 'root') {
      rects.push({ x: -ROOT_NODE_RADIUS, y: -ROOT_NODE_RADIUS, width: ROOT_NODE_RADIUS * 2, height: ROOT_NODE_RADIUS * 2 })
    } else {
      const parent = allNodes[parentId]
      if (parent) {
        const size = nodePixelSize(parent)
        rects.push({ x: parent.x - size.width / 2, y: parent.y - size.height / 2, ...size })
      }
    }

    // Include immediate children
    for (const node of Object.values(allNodes)) {
      if (node.parentId === parentId) {
        const size = nodePixelSize(node)
        rects.push({ x: node.x - size.width / 2, y: node.y - size.height / 2, ...size })
      }
    }

    const bounds = unionBounds(rects)
    if (!bounds) return
    flyTo(cameraToFitBounds(bounds, viewport.clientWidth, viewport.clientHeight, 0.05, UNFOCUS_SNAP_ZOOM))
  }, [flyTo])

  // Detect when focused node disappears (e.g. archived by server on terminal exit)
  useEffect(() => {
    const unsub = useNodeStore.subscribe((state, prevState) => {
      const focused = focusRef.current
      if (!focused || focused === 'root') return
      if (!state.nodes[focused] && prevState.nodes[focused]) {
        // Focused node was removed
        const parentId = focusedParentRef.current ?? 'root'
        focusRef.current = null
        setFocusedId(null)
        setScrollMode(false)
        lastFocusedRef.current = parentId
        flyToParentAndChildren(parentId)
      }
    })
    return unsub
  }, [flyToParentAndChildren])

  // Track claudeState transitions to detect "stopped unviewed" terminals
  useEffect(() => {
    const unsub = useNodeStore.subscribe((state) => {
      const prevStates = prevClaudeStatesRef.current
      const additions: string[] = []
      const removals: string[] = []

      for (const node of Object.values(state.nodes)) {
        if (node.type !== 'terminal') continue
        const prev = prevStates.get(node.id)
        if (prev === node.claudeState) continue

        prevStates.set(node.id, node.claudeState)

        if (node.claudeState === 'stopped' && prev !== undefined) {
          // Transitioned TO stopped from an active state
          additions.push(node.id)
        } else if (node.claudeState !== 'stopped') {
          // Transitioned AWAY from stopped (or new node with active state)
          removals.push(node.id)
        }
      }

      // Clean up removed nodes
      for (const id of prevStates.keys()) {
        if (!state.nodes[id]) {
          prevStates.delete(id)
          removals.push(id)
        }
      }

      if (additions.length > 0 || removals.length > 0) {
        setStoppedUnviewedIds(prev => {
          const next = new Set(prev)
          for (const id of additions) next.add(id)
          for (const id of removals) next.delete(id)
          return next
        })
      }
    })
    return unsub
  }, [])

  // Clear "stopped unviewed" flag when a terminal is focused
  useEffect(() => {
    if (!focusedId) return
    setStoppedUnviewedIds(prev => {
      if (!prev.has(focusedId)) return prev
      const next = new Set(prev)
      next.delete(focusedId)
      return next
    })
  }, [focusedId])


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

  const spawnNode = useCallback(async (
    create: (parentId: string, position: { x: number; y: number }, cwd: string | undefined) => Promise<string>
  ) => {
    if (!focusRef.current) return
    const parentId = focusRef.current
    const { position, cwd } = computeChildPosition(parentId)
    const nodeId = await create(parentId, position, cwd)
    if (cwd) cwdMapRef.current.set(nodeId, cwd)
    setFocusedId(null)
    setScrollMode(false)
    if (!useNodeStore.getState().nodes[nodeId]) {
      await new Promise<void>(resolve => {
        const unsub = useNodeStore.subscribe(state => {
          if (state.nodes[nodeId]) { unsub(); resolve() }
        })
      })
    }
    flyToParentAndChildren(parentId)
  }, [computeChildPosition, flyToParentAndChildren])

  // Global keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = async (e: KeyboardEvent) => {
      // Don't steal keys from real text-editing controls (inputs, CodeMirror, etc.)
      // Exclude xterm's hidden textarea — it's not a visible editing surface.
      const active = document.activeElement as HTMLElement | null
      if (active) {
        const isXterm = !!active.closest('.xterm')
        const isEditable = !isXterm && (
          active.tagName === 'INPUT' ||
          active.tagName === 'TEXTAREA' ||
          active.isContentEditable
        )
        if (isEditable) {
          // Allow Cmd+Arrow (word/line navigation) and Escape (exit editing) to reach the control
          if (e.key === 'Escape' || (e.metaKey && e.key.startsWith('Arrow'))) return
        }
      }

      if (e.metaKey && e.key === 't') {
        e.preventDefault()
        e.stopPropagation()
        spawnNode(async (parentId, pos, cwd) => {
          const r = await sendTerminalCreate(parentId, pos.x, pos.y, cwd ? { cwd } : undefined)
          return r.sessionId
        })
      }

      if (e.metaKey && e.key === 'e') {
        e.preventDefault()
        e.stopPropagation()
        spawnNode(async (parentId, pos, cwd) => {
          const r = await sendTerminalCreate(parentId, pos.x, pos.y, buildClaudeCodeOptions({ cwd }))
          return r.sessionId
        })
      }

      if (e.metaKey && e.key === 'm') {
        e.preventDefault()
        e.stopPropagation()
        spawnNode(async (parentId, pos) => {
          const r = await sendMarkdownAdd(parentId, pos.x, pos.y)
          return r.nodeId
        })
      }

      if (e.metaKey && e.key === 'd') {
        e.preventDefault()
        e.stopPropagation()
        spawnNode(async (parentId, pos, cwd) => {
          const r = await sendDirectoryAdd(parentId, pos.x, pos.y, cwd ?? '~')
          return r.nodeId
        })
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

      // Cmd+Up Arrow: navigate to parent node
      if (e.metaKey && e.key === 'ArrowUp') {
        e.preventDefault()
        e.stopPropagation()
        snapToTarget()
        const target = focusRef.current ?? lastFocusedRef.current
        if (!target) return
        focusRef.current = null
        setFocusedId(null)
        setScrollMode(false)
        navStackRef.current.push(target)
        if (target === 'root') {
          fitAllNodes()
          lastFocusedRef.current = null
        } else {
          const node = useNodeStore.getState().nodes[target]
          if (!node) return
          flyToParentAndChildren(node.parentId)
          lastFocusedRef.current = node.parentId
          flashNode(node.parentId)
        }
      }

      // Cmd+Down Arrow: navigate back down the nav stack, or into first child
      if (e.metaKey && e.key === 'ArrowDown') {
        e.preventDefault()
        e.stopPropagation()
        snapToTarget()
        const stack = navStackRef.current
        const current = focusRef.current ?? lastFocusedRef.current
        if (stack.length === 0) {
          // Stack empty — navigate into the first child of the current node
          if (!current) return
          const allNodes = useNodeStore.getState().nodes
          const firstChild = Object.values(allNodes).find(n => n.parentId === current)
          if (!firstChild) {
            // No children — focus the current node directly
            handleNodeFocus(current)
            return
          }
          stack.push(current)
          focusRef.current = null
          setFocusedId(null)
          setScrollMode(false)
          flyToParentAndChildren(firstChild.id)
          lastFocusedRef.current = firstChild.id
          flashNode(firstChild.id)
          return
        }
        // If we navigated to a sibling (current differs from what's on the stack),
        // discard the stale stack and focus the current node instead
        const stackTop = stack[stack.length - 1]
        if (current && current !== stackTop) {
          stack.length = 0
          handleNodeFocus(current)
          return
        }
        const target = stack.pop()!
        focusRef.current = null
        setFocusedId(null)
        setScrollMode(false)
        if (stack.length === 0) {
          // Bottom of the stack — actually focus the original node
          handleNodeFocus(target)
        } else {
          // Still navigating — show target and its children
          flyToParentAndChildren(target)
          lastFocusedRef.current = target
          flashNode(target)
        }
      }

      // Cmd+Left/Right Arrow: cycle through siblings by angle around parent
      if (e.metaKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        e.preventDefault()
        e.stopPropagation()
        snapToTarget()
        const target = focusRef.current ?? lastFocusedRef.current
        if (!target || target === 'root') return
        const allNodes = useNodeStore.getState().nodes
        const node = allNodes[target]
        if (!node) return
        const parentId = node.parentId
        const parentCenter = parentId === 'root' ? { x: 0, y: 0 } : allNodes[parentId] ? { x: allNodes[parentId].x, y: allNodes[parentId].y } : null
        if (!parentCenter) return
        const siblings = Object.values(allNodes).filter(n => n.parentId === parentId)
        if (siblings.length <= 1) {
          // Only child — do a full 360° tour back to the same node
          const viewport = document.querySelector('.canvas-viewport') as HTMLElement | null
          if (!viewport) return
          const size = nodePixelSize(node)
          const bounds = { x: node.x - size.width / 2, y: node.y - size.height / 2, ...size }
          const targetCamera = cameraToFitBounds(bounds, viewport.clientWidth, viewport.clientHeight, 0.025)
          flashNode(target)
          setFocusedId(target)
          lastFocusedRef.current = target
          navStackRef.current = []
          setScrollMode(node.type === 'terminal' && node.alive)
          rotationalFlyTo({
            parentCenter,
            sourceCenter: { x: node.x, y: node.y },
            targetCenter: { x: node.x, y: node.y },
            targetCamera,
            direction: e.key === 'ArrowRight' ? 'cw' : 'ccw'
          })
          return
        }
        // Sort siblings by angle from parent (atan2), clockwise in screen coords
        const withAngles = siblings.map(s => ({
          id: s.id,
          angle: Math.atan2(s.y - parentCenter.y, s.x - parentCenter.x)
        }))
        withAngles.sort((a, b) => a.angle - b.angle)
        const idx = withAngles.findIndex(s => s.id === target)
        const len = withAngles.length
        const nextIdx = e.key === 'ArrowRight'
          ? (idx + 1) % len       // clockwise
          : (idx - 1 + len) % len // counterclockwise
        const nextId = withAngles[nextIdx].id
        const nextNode = allNodes[nextId]
        if (!nextNode) return

        // Compute target camera (where we'd end up focused on the next node)
        const viewport = document.querySelector('.canvas-viewport') as HTMLElement | null
        if (!viewport) return
        const size = nodePixelSize(nextNode)
        const bounds = { x: nextNode.x - size.width / 2, y: nextNode.y - size.height / 2, ...size }
        const targetCamera = cameraToFitBounds(bounds, viewport.clientWidth, viewport.clientHeight, 0.025)

        // Update focus state manually (same as handleNodeFocus but without flyTo)
        flashNode(nextId)
        setFocusedId(nextId)
        lastFocusedRef.current = nextId
        navStackRef.current = []
        setScrollMode(nextNode.type === 'terminal' && nextNode.alive)
        sendBringToFront(nextId)
        bringToFront(nextId)

        // Rotational fly-to: arc around the parent
        rotationalFlyTo({
          parentCenter,
          sourceCenter: { x: node.x, y: node.y },
          targetCenter: { x: nextNode.x, y: nextNode.y },
          targetCamera,
          direction: e.key === 'ArrowRight' ? 'cw' : 'ccw'
        })
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
  }, [spawnNode, handleNodeFocus, flyToParentAndChildren, fitAllNodes, snapToTarget, rotationalFlyTo, bringToFront, speak, ttsStop, isSpeaking])

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

  const handleEdgeSplit = useCallback(async (parentId: string, childId: string, point: { x: number; y: number }) => {
    const result = await sendMarkdownAdd(parentId, point.x, point.y)
    if (result?.nodeId) {
      await sendReparent(childId, result.nodeId)
    }
  }, [])

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
    // Edge split: click on a hovered edge to insert a markdown node
    const edge = hoveredEdgeRef.current
    if (edge && !focusRef.current) {
      hoveredEdgeRef.current = null
      handleEdgeSplit(edge.parentId, edge.childId, edge.point)
      return
    }
    handleUnfocus()
    flyToUnfocusZoom()
  }, [handleUnfocus, flyToUnfocusZoom, handleNodeFocus, handleEdgeSplit, hoveredEdgeRef])

  return (
    <div className="app">
      <Toolbar
        inputDevice={inputDevice}
        onAddTerminal={() => addTerminalAsChild('root')}
        onResetView={resetCamera}
        onToggleInputDevice={toggleInputDevice}
        forceLayoutPlaying={forceLayoutPlaying}
        forceLayoutSpeed={forceLayoutSpeed}
        onForceLayoutToggle={forceLayoutToggle}
        onForceLayoutIncrease={forceLayoutIncrease}
        onForceLayoutDecrease={forceLayoutDecrease}
        crabs={crabs}
        onCrabClick={handleNodeFocus}
      />
      <Canvas camera={camera} surfaceRef={surfaceRef} onWheel={handleCanvasWheel} onPanStart={handleCanvasPanStart} onCanvasClick={handleCanvasUnfocus} onDoubleClick={fitAllNodes} background={(shadersEnabled || edgesEnabled) ? <CanvasBackground camera={camera} cameraRef={cameraRef} edgesRef={edgesRef} maskRectsRef={maskRectsRef} edgesEnabled={edgesEnabled} shadersEnabled={shadersEnabled} /> : null}>
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
            resolvedPreset={resolvedPresets[t.id]}
            shellTitleHistory={t.shellTitleHistory}
            cwd={t.cwd}
            focused={focusedId === t.id}
            anyNodeFocused={focusedId !== null}
            stoppedUnviewed={stoppedUnviewedIds.has(t.id)}
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
            resolvedPreset={resolvedPresets[m.id]}
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
            resolvedPreset={resolvedPresets[d.id]}
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
        {hoveredEdge && (
          <div
            className="edge-split-indicator"
            style={{
              left: hoveredEdge.point.x,
              top: hoveredEdge.point.y,
              transform: `translate(-50%, -50%) scale(${1 / camera.z})`,
            }}
          />
        )}
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
