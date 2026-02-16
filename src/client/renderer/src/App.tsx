import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Canvas } from './components/Canvas'
import { Toast } from './components/Toast'
import { onToast, showToast } from './lib/toast'
import { RootNode } from './components/RootNode'
import { TerminalCard, terminalSelectionGetters, terminalSearchOpeners, terminalSearchClosers, terminalPlanJumpers } from './components/TerminalCard'
import { MarkdownCard } from './components/MarkdownCard'
import { DirectoryCard } from './components/DirectoryCard'
import { CanvasBackground } from './components/CanvasBackground'
import type { TreeLineNode, MaskRect, ReparentEdge, Selection } from './components/CanvasBackground'
import { Toolbar } from './components/Toolbar'
import { SearchModal } from './components/SearchModal'
import { useCamera } from './hooks/useCamera'
import { useTTS } from './hooks/useTTS'
import { useEdgeHover } from './hooks/useEdgeHover'
import { useForceLayout } from './hooks/useForceLayout'
import { useBeatPulse } from './hooks/useBeatPulse'
import { cameraToFitBounds, cameraToFitBoundsWithCenter, unionBounds, screenToCanvas } from './lib/camera'
import { CHILD_PLACEMENT_DISTANCE, ROOT_NODE_RADIUS, UNFOCUS_SNAP_ZOOM, ARCHIVE_BODY_MIN_WIDTH, ARCHIVE_POPUP_MAX_HEIGHT } from './lib/constants'
import { createWheelAccumulator, classifyWheelEvent } from './lib/wheel-gesture'
import { computeChildPlacement } from './lib/tree-placement'
import { isDescendantOf, getDescendantIds, getAncestorCwd, resolveInheritedPreset } from './lib/tree-utils'
import { useNodeStore, nodePixelSize } from './stores/nodeStore'
import { useReparentStore } from './stores/reparentStore'
import { useShaderStore } from './stores/shaderStore'
import { useEdgesStore } from './stores/edgesStore'
import { useAudioStore } from './stores/audioStore'
import { initServerSync, sendMove, sendBatchMove, sendRename, sendSetColor, sendBringToFront, sendArchive, sendUnarchive, sendArchiveDelete, sendTerminalCreate, sendMarkdownAdd, sendMarkdownResize, sendMarkdownContent, sendTerminalResize, sendReparent, sendDirectoryAdd, sendDirectoryCwd } from './lib/server-sync'

interface CrabEntry { nodeId: string; color: 'white' | 'red' | 'purple' | 'orange' | 'gray'; unviewed: boolean; createdAt: string }

const archiveDismissFlag = { active: false, timer: 0 }
const archiveWheelAcc = createWheelAccumulator()

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
  const [searchVisible, setSearchVisible] = useState(false)
  const searchVisibleRef = useRef(false)
  searchVisibleRef.current = searchVisible
  const [toasts, setToasts] = useState<Array<{ id: number; message: string; createdAt: number }>>([])
  const toastIdRef = useRef(0)
  // Track "stopped unviewed" state for terminal animations
  const prevClaudeStatesRef = useRef<Map<string, string>>(new Map())
  const [stoppedUnviewedIds, setStoppedUnviewedIds] = useState<Set<string>>(new Set())
  const [permissionUnviewedIds, setPermissionUnviewedIds] = useState<Set<string>>(new Set())
  const [planUnviewedIds, setPlanUnviewedIds] = useState<Set<string>>(new Set())
  const focusRef = useRef<string | null>(focusedId)
  focusRef.current = focusedId
  const [selection, setSelection] = useState<Selection | null>(null)
  const selectionRef = useRef<Selection | null>(null)
  selectionRef.current = selection
  const lastFocusedRef = useRef<string | null>(null)
  const navStackRef = useRef<Selection[]>([])
  const { speak, stop: ttsStop, isSpeaking } = useTTS()
  const { camera, cameraRef, surfaceRef, handleWheel, handlePanStart, resetCamera, flyTo, snapToTarget, flyToUnfocusZoom, rotationalFlyTo, hopFlyTo, shakeCamera, inputDevice, toggleInputDevice, restoredFromStorageRef } = useCamera(undefined, focusRef)

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

  // Reparent preview edge for WebGL rendering
  const reparentEdgeRef = useRef<ReparentEdge | null>(null)

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
    const entries: CrabEntry[] = []

    for (const node of Object.values(nodes)) {
      if (node.type !== 'terminal') continue
      let color: CrabEntry['color'] | null = null
      let unviewed = false
      if (node.claudeState === 'waiting_permission') {
        color = 'red'
        unviewed = permissionUnviewedIds.has(node.id)
      } else if (node.claudeState === 'waiting_plan') {
        color = 'purple'
        unviewed = planUnviewedIds.has(node.id)
      } else if (node.claudeState === 'working') {
        color = 'orange'
      } else if (node.claudeState === 'stopped' && stoppedUnviewedIds.has(node.id)) {
        color = 'white'
        unviewed = true
      } else if (node.claudeSessionHistory.length > 0) {
        color = 'gray'
      }
      if (color) {
        const createdAt = node.terminalSessions[0]?.startedAt ?? ''
        entries.push({ nodeId: node.id, color, unviewed, createdAt })
      }
    }

    entries.sort((a, b) => a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0)
    return entries
  }, [nodes, stoppedUnviewedIds, permissionUnviewedIds, planUnviewedIds])

  // Reparent mode state
  const reparentingNodeId = useReparentStore(s => s.reparentingNodeId)
  const reparentHoveredNodeId = useReparentStore(s => s.hoveredNodeId)

  // Update reparent edge ref for WebGL rendering (node-to-node hover)
  useEffect(() => {
    if (!reparentingNodeId) {
      reparentEdgeRef.current = null
      return
    }
    if (!reparentHoveredNodeId) return  // cursor-follow effect handles this case
    const allNodes = useNodeStore.getState().nodes
    const srcNode = allNodes[reparentingNodeId]
    const tgtNode = allNodes[reparentHoveredNodeId]
    const isInvalid = reparentHoveredNodeId === reparentingNodeId ||
      isDescendantOf(allNodes, reparentHoveredNodeId, reparentingNodeId) ||
      (srcNode && srcNode.parentId === reparentHoveredNodeId)
    if (isInvalid || !srcNode || !tgtNode) {
      reparentEdgeRef.current = null
      return
    }
    reparentEdgeRef.current = { fromX: tgtNode.x, fromY: tgtNode.y, toX: srcNode.x, toY: srcNode.y }
  }, [reparentingNodeId, reparentHoveredNodeId])

  // Draw reparent edge from reparenting node to mouse cursor over empty canvas
  useEffect(() => {
    if (!reparentingNodeId) return

    const viewport = document.querySelector('.canvas-viewport') as HTMLElement | null
    if (!viewport) return

    let mouseX = 0
    let mouseY = 0
    let hasMousePos = false
    let rafId = 0

    const onMouseMove = (e: MouseEvent) => {
      mouseX = e.clientX
      mouseY = e.clientY
      hasMousePos = true
    }

    const onMouseLeave = () => {
      hasMousePos = false
      reparentEdgeRef.current = null
    }

    const loop = () => {
      rafId = requestAnimationFrame(loop)

      // If hovering a card, the node-to-node effect handles it
      if (useReparentStore.getState().hoveredNodeId) return

      if (!hasMousePos) {
        reparentEdgeRef.current = null
        return
      }

      // Check if cursor is directly over a canvas-node element
      const elUnder = document.elementFromPoint(mouseX, mouseY)
      if (elUnder && elUnder.closest('.canvas-node')) return

      const srcNode = useNodeStore.getState().nodes[reparentingNodeId]
      if (!srcNode) return

      const cam = cameraRef.current
      const rect = viewport.getBoundingClientRect()
      const worldX = (mouseX - rect.left - cam.x) / cam.z
      const worldY = (mouseY - rect.top - cam.y) / cam.z

      reparentEdgeRef.current = { fromX: worldX, fromY: worldY, toX: srcNode.x, toY: srcNode.y }
    }

    viewport.addEventListener('mousemove', onMouseMove)
    viewport.addEventListener('mouseleave', onMouseLeave)
    rafId = requestAnimationFrame(loop)

    return () => {
      cancelAnimationFrame(rafId)
      viewport.removeEventListener('mousemove', onMouseMove)
      viewport.removeEventListener('mouseleave', onMouseLeave)
      reparentEdgeRef.current = null
    }
  }, [reparentingNodeId, cameraRef])

  // Edge hover detection for edge splitting
  const { hoveredEdge, hoveredEdgeRef, clearHoveredEdge } = useEdgeHover(cameraRef, edgesRef, edgesEnabled, !!reparentingNodeId)

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

  const expireToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])

  // Subscribe to global toast emitter
  useEffect(() => {
    return onToast((message) => {
      const id = ++toastIdRef.current
      setToasts((prev) => [...prev, { id, message, createdAt: Date.now() }])
    })
  }, [])

  // Subscribe to server errors → toast notifications
  useEffect(() => {
    const cleanup = window.api.node.onServerError((message: string) => {
      console.error('[server]', message)
      showToast(message)
    })
    return cleanup
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
    setSelection({ id: nodeId, type: 'node' })
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

  const navigateToNode = useCallback(async (nodeId: string) => {
    // Wait for node to appear in store if not yet present
    if (!useNodeStore.getState().nodes[nodeId]) {
      await new Promise<void>(resolve => {
        const unsub = useNodeStore.subscribe(state => {
          if (state.nodes[nodeId]) { unsub(); resolve() }
        })
      })
    }

    flashNode(nodeId)
    setFocusedId(nodeId)
    setSelection({ id: nodeId, type: 'node' })
    lastFocusedRef.current = nodeId
    navStackRef.current = []

    const node = useNodeStore.getState().nodes[nodeId]
    if (!node) return

    const viewport = document.querySelector('.canvas-viewport') as HTMLElement | null
    if (!viewport) return

    const size = nodePixelSize(node)
    const targetBounds = { x: node.x - size.width / 2, y: node.y - size.height / 2, ...size }
    const targetCamera = cameraToFitBounds(targetBounds, viewport.clientWidth, viewport.clientHeight, 0.025)

    setScrollMode(node.type === 'terminal' && node.alive)
    sendBringToFront(nodeId)
    bringToFront(nodeId)

    const sourceCenter = screenToCanvas({ x: viewport.clientWidth / 2, y: viewport.clientHeight / 2 }, cameraRef.current)
    const targetCenter = screenToCanvas({ x: viewport.clientWidth / 2, y: viewport.clientHeight / 2 }, targetCamera)
    const dist = Math.hypot(targetCenter.x - sourceCenter.x, targetCenter.y - sourceCenter.y)

    if (dist < 50) {
      flyTo(targetCamera)
      return
    }

    hopFlyTo({ targetCamera, targetBounds })
  }, [flashNode, bringToFront, flyTo, hopFlyTo, cameraRef])

  const handleCrabClick = useCallback((nodeId: string) => {
    setSearchVisible(false)
    if (nodeId === 'root') {
      handleNodeFocus(nodeId)
      return
    }
    navigateToNode(nodeId)
  }, [handleNodeFocus, navigateToNode])

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
          navigateToNode(result.sessionId)
        })
      }
    }
  }, [computeChildPosition, navigateToNode])

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
    if (open) {
      const popupWidth = Math.max(ARCHIVE_BODY_MIN_WIDTH, bounds.width)
      const cardRight = bounds.x + bounds.width
      const popupLeft = cardRight - popupWidth
      bounds = {
        x: Math.min(bounds.x, popupLeft),
        y: bounds.y,
        width: Math.max(bounds.width, popupWidth),
        height: Math.max(bounds.height, ARCHIVE_POPUP_MAX_HEIGHT),
      }
    }
    flyTo(cameraToFitBounds(bounds, viewport.clientWidth, viewport.clientHeight, 0.025))
  }, [flyTo])

  const handleSessionRevive = useCallback((_session: import('../../../shared/state').TerminalSessionEntry) => {
    // No-op for now — plumbing in place for future implementation
  }, [])

  const handleRemoveNode = useCallback(async (id: string) => {
    cwdMapRef.current.delete(id)
    await sendArchive(id)
    // Focus cleanup + fly-to handled by Zustand subscription when node-removed arrives
  }, [])

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

  const flyToSelection = useCallback((sel: Selection) => {
    const viewport = document.querySelector('.canvas-viewport') as HTMLElement | null
    if (!viewport) return
    const vw = viewport.clientWidth
    const vh = viewport.clientHeight
    const allNodes = useNodeStore.getState().nodes

    if (sel.type === 'node') {
      // Center = node center, rects = node + all immediate children
      let center: { x: number; y: number }
      const rects: Array<{ x: number; y: number; width: number; height: number }> = []

      if (sel.id === 'root') {
        center = { x: 0, y: 0 }
        rects.push({ x: -ROOT_NODE_RADIUS, y: -ROOT_NODE_RADIUS, width: ROOT_NODE_RADIUS * 2, height: ROOT_NODE_RADIUS * 2 })
      } else {
        const node = allNodes[sel.id]
        if (!node) return
        center = { x: node.x, y: node.y }
        const size = nodePixelSize(node)
        rects.push({ x: node.x - size.width / 2, y: node.y - size.height / 2, ...size })
      }

      // Add immediate children
      for (const node of Object.values(allNodes)) {
        if (node.parentId === sel.id) {
          const size = nodePixelSize(node)
          rects.push({ x: node.x - size.width / 2, y: node.y - size.height / 2, ...size })
        }
      }

      flyTo(cameraToFitBoundsWithCenter(center, rects, vw, vh, 0.05, UNFOCUS_SNAP_ZOOM))
    } else {
      // Edge: center = midpoint of parent and child, rects = parent + child bboxes
      const childNode = allNodes[sel.id]
      if (!childNode) return

      let parentCenter: { x: number; y: number }
      const rects: Array<{ x: number; y: number; width: number; height: number }> = []

      if (childNode.parentId === 'root') {
        parentCenter = { x: 0, y: 0 }
        rects.push({ x: -ROOT_NODE_RADIUS, y: -ROOT_NODE_RADIUS, width: ROOT_NODE_RADIUS * 2, height: ROOT_NODE_RADIUS * 2 })
      } else {
        const parent = allNodes[childNode.parentId]
        if (!parent) return
        parentCenter = { x: parent.x, y: parent.y }
        const parentSize = nodePixelSize(parent)
        rects.push({ x: parent.x - parentSize.width / 2, y: parent.y - parentSize.height / 2, ...parentSize })
      }

      const childSize = nodePixelSize(childNode)
      rects.push({ x: childNode.x - childSize.width / 2, y: childNode.y - childSize.height / 2, ...childSize })

      const center = { x: (parentCenter.x + childNode.x) / 2, y: (parentCenter.y + childNode.y) / 2 }
      flyTo(cameraToFitBoundsWithCenter(center, rects, vw, vh, 0.05, UNFOCUS_SNAP_ZOOM))
    }
  }, [flyTo])

  // Detect when focused node disappears (e.g. archived by server on terminal exit)
  useEffect(() => {
    const unsub = useNodeStore.subscribe((state, prevState) => {
      // Clear selection when selected node is removed
      const sel = selectionRef.current
      if (sel && sel.id !== 'root' && !state.nodes[sel.id] && prevState.nodes[sel.id]) {
        setSelection(null)
      }

      const focused = focusRef.current
      if (!focused || focused === 'root') return
      if (!state.nodes[focused] && prevState.nodes[focused]) {
        // Focused node was removed
        const parentId = focusedParentRef.current ?? 'root'
        focusRef.current = null
        setFocusedId(null)
        setScrollMode(false)
        lastFocusedRef.current = parentId
        const parentSel: Selection = { id: parentId, type: 'node' }
        setSelection(parentSel)
        flashNode(parentId)
        flyToSelection(parentSel)
      }
    })
    return unsub
  }, [flyToSelection])

  // Track claudeState transitions to detect "stopped unviewed" terminals
  useEffect(() => {
    const unsub = useNodeStore.subscribe((state) => {
      const prevStates = prevClaudeStatesRef.current
      const stoppedAdd: string[] = []
      const stoppedRem: string[] = []
      const permAdd: string[] = []
      const permRem: string[] = []
      const planAdd: string[] = []
      const planRem: string[] = []

      for (const node of Object.values(state.nodes)) {
        if (node.type !== 'terminal') continue
        const prev = prevStates.get(node.id)
        if (prev === node.claudeState) continue

        prevStates.set(node.id, node.claudeState)

        // Stopped transitions
        if (node.claudeState === 'stopped' && prev !== undefined) {
          stoppedAdd.push(node.id)
        } else if (node.claudeState !== 'stopped') {
          stoppedRem.push(node.id)
        }

        // Permission transitions
        if (node.claudeState === 'waiting_permission') {
          permAdd.push(node.id)
        } else if (prev === 'waiting_permission') {
          permRem.push(node.id)
        }

        // Plan transitions
        if (node.claudeState === 'waiting_plan') {
          planAdd.push(node.id)
        } else if (prev === 'waiting_plan') {
          planRem.push(node.id)
        }
      }

      // Clean up removed nodes
      for (const id of prevStates.keys()) {
        if (!state.nodes[id]) {
          prevStates.delete(id)
          stoppedRem.push(id)
          permRem.push(id)
          planRem.push(id)
        }
      }

      if (stoppedAdd.length > 0 || stoppedRem.length > 0) {
        setStoppedUnviewedIds(prev => {
          const next = new Set(prev)
          for (const id of stoppedAdd) next.add(id)
          for (const id of stoppedRem) next.delete(id)
          return next
        })
      }
      if (permAdd.length > 0 || permRem.length > 0) {
        setPermissionUnviewedIds(prev => {
          const next = new Set(prev)
          for (const id of permAdd) next.add(id)
          for (const id of permRem) next.delete(id)
          return next
        })
      }
      if (planAdd.length > 0 || planRem.length > 0) {
        setPlanUnviewedIds(prev => {
          const next = new Set(prev)
          for (const id of planAdd) next.add(id)
          for (const id of planRem) next.delete(id)
          return next
        })
      }
    })
    return unsub
  }, [])

  // Clear unviewed flags when a terminal is focused
  useEffect(() => {
    if (!focusedId) return
    setStoppedUnviewedIds(prev => {
      if (!prev.has(focusedId)) return prev
      const next = new Set(prev)
      next.delete(focusedId)
      return next
    })
    setPermissionUnviewedIds(prev => {
      if (!prev.has(focusedId)) return prev
      const next = new Set(prev)
      next.delete(focusedId)
      return next
    })
    setPlanUnviewedIds(prev => {
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

  const handleMarkUnread = useCallback((nodeId: string) => {
    const terminals = useNodeStore.getState().liveTerminals
    const t = terminals.find(n => n.id === nodeId)
    if (!t?.claudeState) return
    if (t.claudeState === 'stopped') {
      setStoppedUnviewedIds(prev => new Set(prev).add(nodeId))
    } else if (t.claudeState === 'waiting_permission') {
      setPermissionUnviewedIds(prev => new Set(prev).add(nodeId))
    } else if (t.claudeState === 'waiting_plan') {
      setPlanUnviewedIds(prev => new Set(prev).add(nodeId))
    }
  }, [])

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
    create: (parentId: string, position: { x: number; y: number }, cwd: string | undefined) => Promise<string>,
    parentIdOverride?: string
  ) => {
    if (!focusRef.current) return
    const parentId = parentIdOverride ?? focusRef.current
    const { position, cwd } = computeChildPosition(parentId)
    const nodeId = await create(parentId, position, cwd)
    if (cwd) cwdMapRef.current.set(nodeId, cwd)
    await navigateToNode(nodeId)
  }, [computeChildPosition, navigateToNode])

  // Global keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = async (e: KeyboardEvent) => {
      // Cmd+S: toggle search modal (before isEditable guard so it works from search input)
      if (e.metaKey && !e.shiftKey && e.key === 's') {
        e.preventDefault()
        e.stopPropagation()
        setSearchVisible(v => !v)
        return
      }

      // Cmd+F: open terminal search (before isEditable guard so it works from search input)
      if (e.metaKey && e.key === 'f') {
        const opener = terminalSearchOpeners.get(focusRef.current!)
        if (opener) {
          e.preventDefault()
          e.stopPropagation()
          opener()
          return
        }
      }

      // Cmd+P: jump to "Here is Claude's plan:" in focused terminal
      if (e.metaKey && e.key === 'p') {
        const jumper = terminalPlanJumpers.get(focusRef.current!)
        if (jumper) {
          e.preventDefault()
          e.stopPropagation()
          if (!jumper()) shakeCamera()
          return
        }
      }

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
        let parentOverride: string | undefined
        if (focusRef.current) {
          const node = useNodeStore.getState().nodes[focusRef.current]
          if (node?.type === 'terminal') {
            parentOverride = node.parentId
          }
        }
        spawnNode(async (parentId, pos, cwd) => {
          const r = await sendTerminalCreate(parentId, pos.x, pos.y, buildClaudeCodeOptions({ cwd }))
          return r.sessionId
        }, parentOverride)
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

      // Cmd+Enter: focus the selected node
      if (e.metaKey && e.key === 'Enter') {
        e.preventDefault()
        e.stopPropagation()
        const sel = selectionRef.current
        if (sel && sel.type === 'node') {
          handleNodeFocus(sel.id)
        }
        return
      }

      // Cmd+Up Arrow: navigate upward through edge → parent node → fitAll
      if (e.metaKey && e.key === 'ArrowUp') {
        e.preventDefault()
        e.stopPropagation()
        snapToTarget()
        const sel = selectionRef.current
        const target = sel?.id ?? focusRef.current ?? lastFocusedRef.current
        if (!target) return

        focusRef.current = null
        setFocusedId(null)
        setScrollMode(false)

        if (target === 'root') {
          // Root node → fit all nodes
          navStackRef.current.push({ id: 'root', type: 'node' })
          setSelection(null)
          fitAllNodes()
          lastFocusedRef.current = null
          return
        }

        const currentSel = sel ?? { id: target, type: 'node' as const }

        if (currentSel.type === 'node') {
          // Node selected → push, select edge (same id), fly to edge
          navStackRef.current.push(currentSel)
          const edgeSel: Selection = { id: currentSel.id, type: 'edge' }
          setSelection(edgeSel)
          lastFocusedRef.current = currentSel.id
          flyToSelection(edgeSel)
        } else {
          // Edge selected (child=id) → push, select parent node, fly to parent
          navStackRef.current.push(currentSel)
          const node = useNodeStore.getState().nodes[currentSel.id]
          if (!node) return
          const parentSel: Selection = { id: node.parentId, type: 'node' }
          setSelection(parentSel)
          lastFocusedRef.current = node.parentId
          flashNode(node.parentId)
          flyToSelection(parentSel)
        }
      }

      // Cmd+Down Arrow: edge → child node, node → child edge
      if (e.metaKey && e.key === 'ArrowDown') {
        e.preventDefault()
        e.stopPropagation()
        snapToTarget()
        const sel = selectionRef.current
        const stack = navStackRef.current

        if (sel && sel.type === 'edge') {
          // Edge selected → select child node, fly to it
          stack.push(sel)
          const nodeSel: Selection = { id: sel.id, type: 'node' }
          setSelection(nodeSel)
          focusRef.current = null
          setFocusedId(null)
          setScrollMode(false)
          lastFocusedRef.current = sel.id
          flashNode(sel.id)
          flyToSelection(nodeSel)
          return
        }

        // Node selected (or no selection) → select a child edge
        const current = sel?.id ?? focusRef.current ?? lastFocusedRef.current
        if (!current) return
        const allNodes = useNodeStore.getState().nodes
        const children = Object.values(allNodes).filter(n => n.parentId === current)
        if (children.length === 0) return

        // Prefer the child we previously navigated up from (stack hint)
        let preferredChild = children[0]
        if (stack.length > 0) {
          const stackTop = stack[stack.length - 1]
          // If the stack top is an edge whose parent is the current node, prefer that child
          if (stackTop.type === 'edge') {
            const hintNode = allNodes[stackTop.id]
            if (hintNode && hintNode.parentId === current) {
              preferredChild = hintNode
              stack.pop() // consume the hint
            }
          }
          // If the stack top is a node that is a child of current, prefer its edge
          if (stackTop.type === 'node') {
            const hintNode = allNodes[stackTop.id]
            if (hintNode && hintNode.parentId === current) {
              preferredChild = hintNode
              stack.pop() // consume the hint
            }
          }
        }

        stack.push(sel ?? { id: current, type: 'node' })
        const edgeSel: Selection = { id: preferredChild.id, type: 'edge' }
        setSelection(edgeSel)
        focusRef.current = null
        setFocusedId(null)
        setScrollMode(false)
        lastFocusedRef.current = preferredChild.id
        flyToSelection(edgeSel)
      }

      // Cmd+Left/Right Arrow: cycle through siblings by angle around parent
      if (e.metaKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        e.preventDefault()
        e.stopPropagation()
        snapToTarget()
        const sel = selectionRef.current
        const target = sel?.id ?? focusRef.current ?? lastFocusedRef.current
        if (!target || target === 'root') return
        const allNodes = useNodeStore.getState().nodes
        const node = allNodes[target]
        if (!node) return
        const parentId = node.parentId
        const parentCenter = parentId === 'root' ? { x: 0, y: 0 } : allNodes[parentId] ? { x: allNodes[parentId].x, y: allNodes[parentId].y } : null
        if (!parentCenter) return
        const siblings = Object.values(allNodes).filter(n => n.parentId === parentId)

        // Determine the selection type to maintain (node stays node, edge stays edge)
        const selType = sel?.type ?? 'node'

        if (siblings.length <= 1) {
          shakeCamera()
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

        // Compute target camera for the selection
        const viewport = document.querySelector('.canvas-viewport') as HTMLElement | null
        if (!viewport) return

        const newSel: Selection = { id: nextId, type: selType }
        const cameraTarget = selType === 'node'
          ? (() => {
              const size = nodePixelSize(nextNode)
              const bounds = { x: nextNode.x - size.width / 2, y: nextNode.y - size.height / 2, ...size }
              return cameraToFitBounds(bounds, viewport.clientWidth, viewport.clientHeight, 0.025)
            })()
          : (() => {
              const childSize = nodePixelSize(nextNode)
              const rects = [{ x: nextNode.x - childSize.width / 2, y: nextNode.y - childSize.height / 2, ...childSize }]
              if (parentId === 'root') {
                rects.push({ x: -ROOT_NODE_RADIUS, y: -ROOT_NODE_RADIUS, width: ROOT_NODE_RADIUS * 2, height: ROOT_NODE_RADIUS * 2 })
              } else {
                const parent = allNodes[parentId]
                if (parent) { const ps = nodePixelSize(parent); rects.push({ x: parent.x - ps.width / 2, y: parent.y - ps.height / 2, ...ps }) }
              }
              const center = { x: (parentCenter.x + nextNode.x) / 2, y: (parentCenter.y + nextNode.y) / 2 }
              return cameraToFitBoundsWithCenter(center, rects, viewport.clientWidth, viewport.clientHeight, 0.05, UNFOCUS_SNAP_ZOOM)
            })()

        // Does NOT focus — only updates selection
        setSelection(newSel)
        focusRef.current = null
        setFocusedId(null)
        setScrollMode(false)
        lastFocusedRef.current = nextId
        navStackRef.current = []
        if (selType === 'node') flashNode(nextId)

        if (selType === 'edge') {
          // Simple fly-to for edges (nodes are too close together for arc animation)
          flyTo(cameraTarget)
        } else {
          // Rotational fly-to: arc around the parent
          rotationalFlyTo({
            parentCenter,
            sourceCenter: { x: node.x, y: node.y },
            targetCenter: { x: nextNode.x, y: nextNode.y },
            targetCamera: cameraTarget,
            direction: e.key === 'ArrowRight' ? 'cw' : 'ccw'
          })
        }
      }

      // Escape: close search modal, close terminal search, cancel reparent mode, or stop TTS
      if (e.key === 'Escape') {
        if (searchVisibleRef.current) {
          setSearchVisible(false)
          return
        }
        if (focusRef.current) {
          const closer = terminalSearchClosers.get(focusRef.current)
          if (closer?.()) return
        }
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
  }, [spawnNode, handleNodeFocus, flyToSelection, fitAllNodes, snapToTarget, rotationalFlyTo, bringToFront, speak, ttsStop, isSpeaking])

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
    // Search modal handles its own wheel events
    if ((e.target as HTMLElement).closest('.search-modal')) return
    setSearchVisible(false)
    if ((e.target as HTMLElement).closest('.archive-body')) {
      const gesture = classifyWheelEvent(archiveWheelAcc, e)
      if (gesture === 'vertical') return  // let native CSS scroll handle it
      // horizontal or pinch: fall through to unfocus/pan below
    }
    if (focusRef.current) {
      e.preventDefault()
      handleUnfocus()
      flyToUnfocusZoom()
    }
    handleWheel(e)
  }, [handleWheel, flyToUnfocusZoom, handleUnfocus])

  const handleCanvasPanStart = useCallback((e: MouseEvent) => {
    setSearchVisible(false)
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
      await navigateToNode(result.nodeId)
    }
  }, [navigateToNode])

  const handleCanvasUnfocus = useCallback(() => {
    setSearchVisible(false)
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
      clearHoveredEdge()
      handleEdgeSplit(edge.parentId, edge.childId, edge.point)
      return
    }
    if (focusRef.current) {
      handleUnfocus()
      flyToUnfocusZoom()
    } else {
      setSelection(null)
      handleUnfocus()
      flyToUnfocusZoom()
    }
  }, [handleUnfocus, flyToUnfocusZoom, handleNodeFocus, handleEdgeSplit, hoveredEdgeRef, clearHoveredEdge])

  return (
    <div className="app">
      <Canvas camera={camera} surfaceRef={surfaceRef} onWheel={handleCanvasWheel} onPanStart={handleCanvasPanStart} onCanvasClick={handleCanvasUnfocus} onDoubleClick={fitAllNodes} background={(shadersEnabled || edgesEnabled) ? <CanvasBackground camera={camera} cameraRef={cameraRef} edgesRef={edgesRef} maskRectsRef={maskRectsRef} selectionRef={selectionRef} reparentEdgeRef={reparentEdgeRef} edgesEnabled={edgesEnabled} shadersEnabled={shadersEnabled} /> : null} overlay={<SearchModal visible={searchVisible} onDismiss={() => setSearchVisible(false)} onNavigateToNode={(id) => { setSearchVisible(false); handleNodeFocus(id) }} />}>
        <RootNode
          focused={focusedId === 'root'}
          selected={selection?.id === 'root' && selection?.type === 'node'}
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
            selected={selection?.id === t.id && selection?.type === 'node'}
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
            onMarkUnread={handleMarkUnread}
            isUnviewed={stoppedUnviewedIds.has(t.id) || permissionUnviewedIds.has(t.id) || planUnviewedIds.has(t.id)}
            terminalSessions={t.terminalSessions}
            onSessionRevive={handleSessionRevive}
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
            selected={selection?.id === m.id && selection?.type === 'node'}
            onFocus={handleNodeFocus}
            onUnfocus={() => { handleUnfocus(); flyToUnfocusZoom() }}
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
            selected={selection?.id === d.id && selection?.type === 'node'}
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
      </Canvas>
      <Toolbar
        inputDevice={inputDevice}
        onToggleInputDevice={toggleInputDevice}
        forceLayoutPlaying={forceLayoutPlaying}
        forceLayoutSpeed={forceLayoutSpeed}
        onForceLayoutToggle={forceLayoutToggle}
        onForceLayoutIncrease={forceLayoutIncrease}
        onForceLayoutDecrease={forceLayoutDecrease}
        crabs={crabs}
        onCrabClick={handleCrabClick}
        selectedNodeId={focusedId}
      />
      <Toast toasts={toasts} onExpire={expireToast} />
    </div>
  )
}
