import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Canvas } from './components/Canvas'
import { Toast } from './components/Toast'
import { onToast, showToast } from './lib/toast'
import { RootNode } from './components/RootNode'
import { TerminalCard, terminalSelectionGetters, terminalSearchOpeners, terminalSearchClosers, terminalPlanJumpers } from './components/TerminalCard'
import { MarkdownCard } from './components/MarkdownCard'
import { DirectoryCard } from './components/DirectoryCard'
import { FileCard } from './components/FileCard'
import { TitleCard } from './components/TitleCard'
import type { AddNodeType } from './components/AddNodeBody'
import { CanvasBackground } from './components/CanvasBackground'
import type { TreeLineNode, MaskRect, ReparentEdge } from './components/CanvasBackground'
import { Toolbar } from './components/Toolbar'
import { FloatingToolbar } from './components/FloatingToolbar'
import { EdgeSplitMenu } from './components/EdgeSplitMenu'
import { SearchModal } from './components/SearchModal'
import { HelpModal } from './components/HelpModal'
import { KeycastOverlay } from './components/KeycastOverlay'
import { useCamera } from './hooks/useCamera'
import { useTTS } from './hooks/useTTS'
import { useEdgeHover } from './hooks/useEdgeHover'
import { cameraToFitBounds, cameraToFitBoundsWithCenter, unionBounds, screenToCanvas, computeFlyToDuration, computeFlyToSpeed } from './lib/camera'
import { ROOT_NODE_RADIUS, UNFOCUS_SNAP_ZOOM, ARCHIVE_BODY_MIN_WIDTH, ARCHIVE_POPUP_MAX_HEIGHT, DEFAULT_COLS, DEFAULT_ROWS, terminalPixelSize } from './lib/constants'
import { createWheelAccumulator, classifyWheelEvent } from './lib/wheel-gesture'
import { nodeDisplayTitle } from './lib/node-title'
import { isDescendantOf, getDescendantIds, getAncestorCwd, resolveInheritedPreset } from './lib/tree-utils'
import { DEFAULT_PRESET } from './lib/color-presets'
import { useNodeStore, nodePixelSize } from './stores/nodeStore'
import { useReparentStore } from './stores/reparentStore'
import { useAudioStore } from './stores/audioStore'
import { initServerSync, sendMove, sendBatchMove, sendRename, sendSetColor, sendBringToFront, sendArchive, sendUnarchive, sendArchiveDelete, sendTerminalCreate, sendMarkdownAdd, sendMarkdownResize, sendMarkdownContent, sendMarkdownSetMaxWidth, sendTerminalResize, sendReparent, sendDirectoryAdd, sendDirectoryCwd, sendFileAdd, sendFilePath, sendTitleAdd, sendTitleText, sendForkSession, sendTerminalRestart, sendCrabReorder } from './lib/server-sync'
import { initTooltips } from './lib/tooltip'
import { adjacentCrab, highestPriorityCrab } from './lib/crab-nav'
import { isDisposable } from '../../../shared/node-utils'
import { pushArchiveUndo, popArchiveUndo } from './lib/undo-archive'
import { pushCameraHistory, goBack, goForward } from './lib/camera-history'
import type { CrabEntry } from './lib/crab-nav'
import { deriveCrabAppearance } from './lib/crab-nav'
import { saveFocusState, loadFocusState, cleanupStaleScrollEntries, markSessionForScrollRestore } from './lib/focus-storage'

function tieredZIndex(type: import('../../../../shared/state').NodeData['type'], z: number): number {
  if (type === 'title') return z + 2_000_000
  if (type === 'directory') return z + 1_000_000
  return z
}

function getMarkdownSpawnInfo(parentNode: import('../../../../shared/state').NodeData | undefined): {
  initialInput?: string; initialName?: string; x?: number; y?: number
} {
  if (!parentNode || parentNode.type !== 'markdown' || !parentNode.content.trim()) return {}
  const content = parentNode.content.trim()
  const lines = content.split('\n')
  const headingMatch = lines[0].match(/^#+\s+(.+)/)
  const initialName = headingMatch ? headingMatch[1].trim() : undefined
  const commandLines = headingMatch ? lines.slice(1).join('\n').trim() : content
  const initialInput = commandLines || undefined
  const termSize = terminalPixelSize(DEFAULT_COLS, DEFAULT_ROWS)
  const gap = 20
  const x = parentNode.x
  const y = parentNode.y + parentNode.height / 2 + gap + termSize.height / 2
  return { initialInput, initialName, x, y }
}

const archiveDismissFlag = { active: false, timer: 0 }
const archiveWheelAcc = createWheelAccumulator()

export function App() {
  const [focusedId, setFocusedId] = useState<string | null>(null)
  const [scrollMode, setScrollMode] = useState(false)
  const [searchVisible, setSearchVisible] = useState(false)
  const searchVisibleRef = useRef(false)
  searchVisibleRef.current = searchVisible
  const [helpVisible, setHelpVisible] = useState(false)
  const helpVisibleRef = useRef(false)
  helpVisibleRef.current = helpVisible
  const [keycastEnabled, setKeycastEnabled] = useState(false)
  const [toasts, setToasts] = useState<Array<{ id: number; message: string; createdAt: number }>>([])
  const toastIdRef = useRef(0)
  const focusRef = useRef<string | null>(focusedId)
  focusRef.current = focusedId
  const navBlockUntilRef = useRef(0)
  const onCameraEvent = useCallback((cam: import('./lib/camera').Camera, type: 'flyTo' | 'settle' | 'snapback') => {
    if (type === 'snapback') return
    if (Date.now() < navBlockUntilRef.current) return
    pushCameraHistory({ camera: cam, focusedId: focusRef.current })
  }, [])
  const [selection, setSelection] = useState<string | null>(null)
  const selectionRef = useRef<string | null>(null)
  selectionRef.current = selection
  const lastFocusedRef = useRef<string | null>(null)
  const lastCrabRef = useRef<{ nodeId: string; createdAt: string } | null>(null)
  const focusRestoredRef = useRef(false)
  const [quickActions, setQuickActions] = useState<{ nodeId: string; screenX: number; screenY: number } | null>(null)
  const [edgeSplit, setEdgeSplit] = useState<{ parentId: string; childId: string; worldPoint: { x: number; y: number }; screenX: number; screenY: number } | null>(null)
  const cmdClickPendingRef = useRef<{ nodeId: string; screenX: number; screenY: number } | null>(null)
  const { speak, stop: ttsStop, isSpeaking } = useTTS()
  const { camera, cameraRef, surfaceRef, handleWheel, handlePanStart, resetCamera, flyTo, snapToTarget, flyToUnfocusZoom, rotationalFlyTo, hopFlyTo, shakeCamera, inputDevice, toggleInputDevice, restoredFromStorageRef, captureDebugState } = useCamera(undefined, focusRef, onCameraEvent)

  // Subscribe to store
  const nodes = useNodeStore(s => s.nodes)
  const nodeList = useNodeStore(s => s.nodeList)
  const liveTerminals = useNodeStore(s => s.liveTerminals)
  const markdowns = useNodeStore(s => s.markdowns)
  const directories = useNodeStore(s => s.directories)
  const files = useNodeStore(s => s.files)
  const titles = useNodeStore(s => s.titles)
  const fileContents = useNodeStore(s => s.fileContents)
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

  const maskRects = useMemo(() => {
    const rects: MaskRect[] = markdowns.map((n): MaskRect => ({ x: n.x, y: n.y, width: n.width, height: n.height }))
    for (const t of titles) {
      const size = nodePixelSize(t)
      rects.push({ x: t.x, y: t.y, width: size.width, height: size.height })
    }
    return rects
  }, [markdowns, titles])
  const maskRectsRef = useRef<MaskRect[]>([])
  maskRectsRef.current = maskRects

  // Reparent preview edge for WebGL rendering
  const reparentEdgeRef = useRef<ReparentEdge | null>(null)

  // Resolve inherited color presets for all nodes (+ root which isn't in the store)
  const resolvedPresets = useMemo(() => {
    const map: Record<string, import('./lib/color-presets').ColorPreset> = {}
    map['root'] = DEFAULT_PRESET
    for (const id in nodes) {
      map[id] = resolveInheritedPreset(nodes, id)
    }
    return map
  }, [nodes])

  // Derive crab indicators for toolbar
  const crabs = useMemo(() => {
    const entries: CrabEntry[] = []

    for (const node of Object.values(nodes)) {
      if (node.type !== 'terminal') continue
      const appearance = deriveCrabAppearance(node.claudeState, node.claudeStatusUnread, node.claudeSessionHistory.length > 0)
      if (appearance) {
        const createdAt = node.terminalSessions[0]?.startedAt ?? ''
        entries.push({ nodeId: node.id, color: appearance.color, unviewed: appearance.unviewed, createdAt, sortOrder: node.sortOrder, title: nodeDisplayTitle(node), claudeStateDecidedAt: node.claudeStateDecidedAt })
      }
    }

    entries.sort((a, b) => a.sortOrder - b.sortOrder)
    return entries
  }, [nodes])
  const crabsRef = useRef<CrabEntry[]>([])
  crabsRef.current = crabs

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
    // Root node lives at (0,0) and isn't in the node store
    const tgtNode = reparentHoveredNodeId === 'root'
      ? { x: 0, y: 0 }
      : allNodes[reparentHoveredNodeId]
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
  const { hoveredEdge, hoveredEdgeRef, clearHoveredEdge } = useEdgeHover(cameraRef, edgesRef, !!reparentingNodeId)

  // Toggle cursor when hovering an edge
  useEffect(() => {
    const viewport = document.querySelector('.canvas-viewport') as HTMLElement | null
    if (!viewport) return
    if (hoveredEdge) {
      viewport.style.cursor = 'pointer'
      return () => { viewport.style.cursor = '' }
    }
  }, [hoveredEdge])

  // Initialize tooltips on mount
  useEffect(() => {
    initTooltips()
  }, [])

  // Detect cmd+click on canvas nodes — record pending so handleNodeFocus can intercept
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (!e.metaKey) return
      const canvasNode = (e.target as HTMLElement).closest('.canvas-node') as HTMLElement | null
      if (!canvasNode) return
      const nodeId = canvasNode.dataset.nodeId
      if (!nodeId) return
      if (nodeId === focusRef.current) return
      cmdClickPendingRef.current = { nodeId, screenX: e.clientX, screenY: e.clientY }
    }
    window.addEventListener('mousedown', handler, { capture: true })
    return () => window.removeEventListener('mousedown', handler, { capture: true })
  }, [])

  // Initialize audio beat detection
  useEffect(() => {
    const cleanup = useAudioStore.getState().init()
    return cleanup
  }, [])

  // Persist focus state to localStorage (skip until initial restore is done)
  useEffect(() => {
    if (!focusRestoredRef.current) return
    saveFocusState(focusedId, scrollMode)
  }, [focusedId, scrollMode])

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

  // Track last-visited crab for Cmd+Left/Right navigation when unfocused
  useEffect(() => {
    if (!focusedId) return
    const crab = crabs.find(c => c.nodeId === focusedId)
    if (crab) lastCrabRef.current = { nodeId: crab.nodeId, createdAt: crab.createdAt }
  }, [focusedId, crabs])

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
      if (!viewport) { focusRestoredRef.current = true; return }
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
          // User can see something — keep restored camera. Restore focus state.
          const savedFocus = loadFocusState()
          if (savedFocus?.focusedId) {
            const allNodesMap = useNodeStore.getState().nodes
            const node = allNodesMap[savedFocus.focusedId]
            if (node) {
              setFocusedId(savedFocus.focusedId)
              setSelection(savedFocus.focusedId)
              lastFocusedRef.current = savedFocus.focusedId
              sendBringToFront(savedFocus.focusedId)
              bringToFront(savedFocus.focusedId)
              if (node.type === 'terminal' && node.alive) {
                markSessionForScrollRestore(node.sessionId)
                if (savedFocus.scrollMode) {
                  setScrollMode(true)
                }
              }
            }
          }

          // Clean up stale scroll entries for sessions that no longer exist
          const validSessionIds = new Set(
            allNodes
              .filter((n): n is import('../../../../shared/state').TerminalNodeData => n.type === 'terminal')
              .map(n => n.sessionId)
          )
          cleanupStaleScrollEntries(validSessionIds)

          focusRestoredRef.current = true
          return
        }
      }

      // Nothing visible (or no stored camera) → teleport to origin zoomed in, fly out
      focusRestoredRef.current = true
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

  const draggingRef = useRef(new Set<string>())
  const dragDescendantsRef = useRef<string[]>([])

  // Snap-to-align state
  const ctrlAtStartRef = useRef(false)
  const metaKeyWasReleasedRef = useRef(false)
  const snapStateRef = useRef<{ nodeId: string; axis: 'x' | 'y' } | null>(null)
  const snapGuideRef = useRef<HTMLDivElement>(null)

  // Rotational drag state (Shift+drag)
  const rotationalDragRef = useRef<{
    pivotX: number
    pivotY: number
    initialAngle: number
    initialOffsets: Map<string, { dx: number; dy: number }>
  } | null>(null)

  const handleDragStart = useCallback((id: string, solo?: boolean, ctrlAtStart?: boolean, shiftAtStart?: boolean) => {
    ctrlAtStartRef.current = !!ctrlAtStart
    metaKeyWasReleasedRef.current = false
    snapStateRef.current = null
    rotationalDragRef.current = null

    draggingRef.current.add(id)
    if (solo) {
      dragDescendantsRef.current = []
    } else {
      const allNodes = useNodeStore.getState().nodes
      const descendants = getDescendantIds(allNodes, id)
      dragDescendantsRef.current = descendants
      for (const d of descendants) {
        draggingRef.current.add(d)
      }

      // Set up rotational drag if Shift was held
      if (shiftAtStart && descendants.length > 0) {
        const node = allNodes[id]
        if (node) {
          const parent = node.parentId === 'root' ? null : allNodes[node.parentId]
          const pivotX = parent ? parent.x : 0
          const pivotY = parent ? parent.y : 0
          const initialAngle = Math.atan2(node.y - pivotY, node.x - pivotX)
          const initialOffsets = new Map<string, { dx: number; dy: number }>()
          for (const d of descendants) {
            const dn = allNodes[d]
            if (dn) {
              initialOffsets.set(d, { dx: dn.x - node.x, dy: dn.y - node.y })
            }
          }
          rotationalDragRef.current = { pivotX, pivotY, initialAngle, initialOffsets }
        }
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

    // Clear snap-to-align and rotational drag state
    ctrlAtStartRef.current = false
    metaKeyWasReleasedRef.current = false
    snapStateRef.current = null
    rotationalDragRef.current = null
    const guide = snapGuideRef.current
    if (guide) guide.style.display = 'none'

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

  // CWD tracking — ref so optimistic writes (spawnNode, createChildNode) don't trigger re-renders.
  // getAncestorCwd falls back to node.cwd from the store when cwdMapRef has no entry.
  const cwdMapRef = useRef(new Map<string, string>())

  const getParentCwd = useCallback((parentId: string): string | undefined => {
    if (parentId === 'root') return undefined
    const allNodes = useNodeStore.getState().nodes
    return getAncestorCwd(allNodes, parentId, cwdMapRef.current)
  }, [])

  const flashNode = useCallback((nodeId: string) => {
    const el = document.querySelector(`[data-node-id="${nodeId}"]`)?.firstElementChild as HTMLElement | null
    if (!el) return
    el.classList.remove('card-shell--selection-flash')
    void el.offsetWidth
    el.classList.add('card-shell--selection-flash')
  }, [])

  const navigateHistory = useCallback((direction: 'back' | 'forward') => {
    const entry = direction === 'back' ? goBack() : goForward()
    if (!entry) {
      shakeCamera()
      return
    }
    const viewport = document.querySelector('.canvas-viewport') as HTMLElement | null
    const vw = viewport?.clientWidth ?? window.innerWidth
    const vh = viewport?.clientHeight ?? window.innerHeight
    const sourceCenter = screenToCanvas({ x: vw / 2, y: vh / 2 }, cameraRef.current)
    const targetCenter = screenToCanvas({ x: vw / 2, y: vh / 2 }, entry.camera)
    const dist = Math.hypot(targetCenter.x - sourceCenter.x, targetCenter.y - sourceCenter.y)

    navBlockUntilRef.current = Date.now() + computeFlyToDuration(dist) + 20

    // Restore focus state directly
    const nodeId = entry.focusedId
    focusRef.current = nodeId
    setFocusedId(nodeId)

    if (nodeId) {
      const node = useNodeStore.getState().nodes[nodeId]
      if (node) {
        setSelection(nodeId)
        setScrollMode(node.type === 'terminal' && node.alive)
        bringToFront(nodeId)
        sendBringToFront(nodeId)
        flashNode(nodeId)
      } else {
        // Node was archived/deleted — clear focus state
        setSelection(null)
        setScrollMode(false)
      }
    } else {
      setSelection(null)
      setScrollMode(false)
    }

    flyTo(entry.camera, computeFlyToSpeed(dist))
  }, [shakeCamera, flyTo, bringToFront, flashNode, cameraRef])

  const handleNodeFocus = useCallback((nodeId: string) => {
    // Cmd+click without drag → show floating quick-actions toolbar instead of focusing
    const pending = cmdClickPendingRef.current
    cmdClickPendingRef.current = null
    if (pending && pending.nodeId === nodeId) {
      setQuickActions({ nodeId, screenX: pending.screenX, screenY: pending.screenY })
      return
    }

    flashNode(nodeId)
    setFocusedId(nodeId)
    setSelection(nodeId)
    lastFocusedRef.current = nodeId

    // Clear unread flag on every click, even if already focused
    const node = useNodeStore.getState().nodes[nodeId]
    if (node?.type === 'terminal' && node.claudeStatusUnread) {
      window.api.node.setClaudeStatusUnread(node.sessionId, false)
    }

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

    const targetCamera = cameraToFitBounds(bounds, viewport.clientWidth, viewport.clientHeight, padding)
    const sourceCenter = screenToCanvas({ x: viewport.clientWidth / 2, y: viewport.clientHeight / 2 }, cameraRef.current)
    const targetCenter = screenToCanvas({ x: viewport.clientWidth / 2, y: viewport.clientHeight / 2 }, targetCamera)
    const dist = Math.hypot(targetCenter.x - sourceCenter.x, targetCenter.y - sourceCenter.y)
    flyTo(targetCamera, computeFlyToSpeed(dist))
  }, [bringToFront, flyTo, cameraRef, flashNode])

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
    setSelection(nodeId)
    lastFocusedRef.current = nodeId

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
      flyTo(targetCamera, computeFlyToSpeed(dist))
      return
    }

    const topLeft = screenToCanvas({ x: 0, y: 0 }, cameraRef.current)
    const bottomRight = screenToCanvas({ x: viewport.clientWidth, y: viewport.clientHeight }, cameraRef.current)
    const targetInViewport =
      targetBounds.x >= topLeft.x &&
      targetBounds.y >= topLeft.y &&
      targetBounds.x + targetBounds.width <= bottomRight.x &&
      targetBounds.y + targetBounds.height <= bottomRight.y

    if (targetInViewport) {
      flyTo(targetCamera, computeFlyToSpeed(dist))
    } else {
      hopFlyTo({ targetCamera, targetBounds, duration: computeFlyToDuration(dist) })
    }
  }, [flashNode, bringToFront, flyTo, hopFlyTo, cameraRef])

  // Initialize server sync on mount — placed after getParentCwd/navigateToNode/cwdMapRef
  // so the fork-detection interceptor closure can reference them.
  useEffect(() => {
    initServerSync((nodeId, fields, prevNode) => {
      // Fork detection: when claudeSessionHistory grows with a 'fork' entry,
      // spawn a new terminal that resumes the previous Claude session.
      if (!('claudeSessionHistory' in fields) || !prevNode || prevNode.type !== 'terminal') return
      const history = (fields as { claudeSessionHistory: ClaudeSessionEntry[] }).claudeSessionHistory
      if (history.length <= prevNode.claudeSessionHistory.length || history.length < 2) return
      const latestEntry = history[history.length - 1]
      if (latestEntry.reason !== 'fork') return
      const resumeSessionId = history[history.length - 2].claudeSessionId
      const cwd = getParentCwd(nodeId)
      const parentNode = useNodeStore.getState().nodes[nodeId]
      const titleHistory = parentNode?.type === 'terminal' ? parentNode.shellTitleHistory : undefined
      const parentName = parentNode?.name
      sendTerminalCreate(nodeId, { cwd, claude: { resumeSessionId } }, titleHistory, parentName).then((result) => {
        if (cwd) cwdMapRef.current.set(result.sessionId, cwd)
        navigateToNode(result.sessionId)
      })
    })
  }, [])

  const handleCrabClick = useCallback((nodeId: string) => {
    setSearchVisible(false)
    setHelpVisible(false)
    if (nodeId === 'root') {
      handleNodeFocus(nodeId)
      return
    }
    // If already focused, toggle unread state
    if (focusedId === nodeId) {
      const node = useNodeStore.getState().nodes[nodeId]
      if (node?.type === 'terminal') {
        window.api.node.setClaudeStatusUnread(node.sessionId, !node.claudeStatusUnread)
      }
      return
    }
    navigateToNode(nodeId)
  }, [focusedId, handleNodeFocus, navigateToNode])

  const handleCrabReorder = useCallback((order: string[]) => {
    // Optimistically update sortOrder on affected nodes in the store
    const store = useNodeStore.getState()
    for (let i = 0; i < order.length; i++) {
      const node = store.nodes[order[i]]
      if (node && node.type === 'terminal' && node.sortOrder !== i) {
        store.applyServerNodeUpdate(order[i], { sortOrder: i })
      }
    }
    sendCrabReorder(order)
  }, [])

  const handleDebugCapture = useCallback(() => {
    const state = captureDebugState()
    const json = JSON.stringify(state, null, 2)
    navigator.clipboard.writeText(json).then(
      () => showToast('Debug state copied to clipboard'),
      () => showToast('Failed to copy debug state')
    )
  }, [captureDebugState])

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


  const handleUnarchive = useCallback(async (parentNodeId: string, archivedNodeId: string) => {
    await sendUnarchive(parentNodeId, archivedNodeId)
  }, [])

  const handleReviveNode = useCallback(async (archiveParentId: string, archivedNodeId: string) => {
    setSearchVisible(false)
    await sendUnarchive(archiveParentId, archivedNodeId)
    await navigateToNode(archivedNodeId)
  }, [navigateToNode])

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
      let popupLeft: number
      if (bounds.width < ARCHIVE_BODY_MIN_WIDTH) {
        // Narrow card: popup is centered under it
        const cardCenterX = bounds.x + bounds.width / 2
        popupLeft = cardCenterX - popupWidth / 2
      } else {
        // Wide card: popup is right-aligned
        popupLeft = bounds.x + bounds.width - popupWidth
      }
      const popupRight = popupLeft + popupWidth
      bounds = {
        x: Math.min(bounds.x, popupLeft),
        y: bounds.y,
        width: Math.max(popupRight, bounds.x + bounds.width) - Math.min(bounds.x, popupLeft),
        height: Math.max(bounds.height, ARCHIVE_POPUP_MAX_HEIGHT),
      }
    }
    flyTo(cameraToFitBounds(bounds, viewport.clientWidth, viewport.clientHeight, 0.025))
  }, [flyTo])

  const handleSessionRevive = useCallback(async (nodeId: string, session: import('../../../shared/state').TerminalSessionEntry) => {
    if (!session.claudeSessionId) return
    const cwd = getParentCwd(nodeId)
    const result = await sendTerminalCreate(
      nodeId,
      { cwd, claude: { resumeSessionId: session.claudeSessionId } },
      session.shellTitleHistory
    )
    if (cwd) cwdMapRef.current.set(result.sessionId, cwd)
    navigateToNode(result.sessionId)
  }, [getParentCwd, navigateToNode])

  const handleForkSession = useCallback(async (nodeId: string) => {
    try {
      const result = await sendForkSession(nodeId)
      navigateToNode(result.sessionId)
    } catch (err: any) {
      console.error(`Fork session failed: ${err.message}`)
    }
  }, [navigateToNode])

  const handleExtraCliArgs = useCallback(async (nodeId: string, extraCliArgs: string) => {
    try {
      await sendTerminalRestart(nodeId, extraCliArgs)
    } catch (err: any) {
      console.error(`Terminal restart failed: ${err.message}`)
    }
  }, [])

  const handleRemoveNode = useCallback(async (id: string) => {
    cwdMapRef.current.delete(id)
    const { nodes } = useNodeStore.getState()
    const node = nodes[id]
    if (node && !isDisposable(node)) {
      const reparentedChildIds = Object.keys(nodes).filter(k => nodes[k].parentId === id)
      pushArchiveUndo({ nodeId: id, parentId: node.parentId, reparentedChildIds })
    }
    await sendArchive(id)
    // Focus cleanup + fly-to handled by Zustand subscription when node-removed arrives
  }, [])

  const handleShipIt = useCallback((nodeId: string) => {
    const { nodes } = useNodeStore.getState()
    const node = nodes[nodeId]
    if (!node || node.type !== 'markdown') return
    const parent = nodes[node.parentId]
    if (!parent || parent.type !== 'terminal' || !parent.alive) {
      shakeCamera()
      return
    }
    // Bracketed paste into parent terminal, then submit.
    // Convert \n to \r to match xterm's prepareTextForTerminal behavior —
    // Ink/Claude Code expects \r for line breaks inside bracketed paste.
    const content = node.content.replace(/\r?\n/g, '\r')
    const sessionId = parent.sessionId
    window.api.pty.write(sessionId, '\x1b[200~' + content + '\x1b[201~')
    setTimeout(() => window.api.pty.write(sessionId, '\r'), 200)
    handleRemoveNode(nodeId)
  }, [shakeCamera, handleRemoveNode])

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

  const flyToSelection = useCallback((nodeId: string) => {
    const viewport = document.querySelector('.canvas-viewport') as HTMLElement | null
    if (!viewport) return
    const vw = viewport.clientWidth
    const vh = viewport.clientHeight
    const allNodes = useNodeStore.getState().nodes

    // Center = node center, rects = node + all immediate children
    let center: { x: number; y: number }
    const rects: Array<{ x: number; y: number; width: number; height: number }> = []

    if (nodeId === 'root') {
      center = { x: 0, y: 0 }
      rects.push({ x: -ROOT_NODE_RADIUS, y: -ROOT_NODE_RADIUS, width: ROOT_NODE_RADIUS * 2, height: ROOT_NODE_RADIUS * 2 })
    } else {
      const node = allNodes[nodeId]
      if (!node) return
      center = { x: node.x, y: node.y }
      const size = nodePixelSize(node)
      rects.push({ x: node.x - size.width / 2, y: node.y - size.height / 2, ...size })
    }

    // Add immediate children
    for (const node of Object.values(allNodes)) {
      if (node.parentId === nodeId) {
        const size = nodePixelSize(node)
        rects.push({ x: node.x - size.width / 2, y: node.y - size.height / 2, ...size })
      }
    }

    flyTo(cameraToFitBoundsWithCenter(center, rects, vw, vh, 0.05, UNFOCUS_SNAP_ZOOM))
  }, [flyTo])

  // Detect when focused node disappears (e.g. archived by server on terminal exit)
  useEffect(() => {
    const unsub = useNodeStore.subscribe((state, prevState) => {
      // Clear selection when selected node is removed
      const sel = selectionRef.current
      if (sel && sel !== 'root' && !state.nodes[sel] && prevState.nodes[sel]) {
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
        setSelection(parentId)
        flashNode(parentId)
        flyToSelection(parentId)
      }
    })
    return unsub
  }, [flyToSelection])

  // Clear unread flag on server when a terminal is focused
  useEffect(() => {
    if (!focusedId) return
    const node = useNodeStore.getState().nodes[focusedId]
    if (node?.type === 'terminal' && node.claudeStatusUnread) {
      window.api.node.setClaudeStatusUnread(node.sessionId, false)
    }
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
  const handleMove = useCallback((id: string, x: number, y: number, metaKey?: boolean) => {
    // Track Command key releases for fresh-press detection
    if (!metaKey) {
      metaKeyWasReleasedRef.current = true
    }

    let finalX = x
    let finalY = y
    const shouldSnap = !!metaKey && metaKeyWasReleasedRef.current && !ctrlAtStartRef.current

    if (shouldSnap) {
      const allNodes = useNodeStore.getState().nodes
      const draggedNode = allNodes[id]
      if (draggedNode) {
        const draggedSize = nodePixelSize(draggedNode)
        const draggedHalfW = draggedSize.width / 2
        const draggedHalfH = draggedSize.height / 2

        const SNAP_THRESHOLD = 80
        const SNAP_BREAK_MULTIPLIER = 1.5
        const currentSnap = snapStateRef.current

        let bestDist = Infinity
        let bestNodeId: string | null = null
        let bestAxis: 'x' | 'y' = 'x'
        let bestSnapValue = 0

        for (const [otherId, otherNode] of Object.entries(allNodes)) {
          if (draggingRef.current.has(otherId)) continue

          const otherSize = nodePixelSize(otherNode)
          const otherHalfW = otherSize.width / 2
          const otherHalfH = otherSize.height / 2

          const edgeDistX = Math.max(0, Math.abs(x - otherNode.x) - draggedHalfW - otherHalfW)
          const edgeDistY = Math.max(0, Math.abs(y - otherNode.y) - draggedHalfH - otherHalfH)
          const dist = Math.sqrt(edgeDistX * edgeDistX + edgeDistY * edgeDistY)

          // Use higher threshold if this is the current snap target (hysteresis)
          const threshold = (currentSnap && currentSnap.nodeId === otherId)
            ? SNAP_THRESHOLD * SNAP_BREAK_MULTIPLIER
            : SNAP_THRESHOLD

          if (dist < threshold && dist < bestDist) {
            bestDist = dist
            bestNodeId = otherId

            // Snap to the axis where centers are already closer
            const centerDiffX = Math.abs(x - otherNode.x)
            const centerDiffY = Math.abs(y - otherNode.y)
            if (centerDiffX <= centerDiffY) {
              bestAxis = 'x'
              bestSnapValue = otherNode.x
            } else {
              bestAxis = 'y'
              bestSnapValue = otherNode.y
            }
          }
        }

        if (bestNodeId) {
          snapStateRef.current = { nodeId: bestNodeId, axis: bestAxis }
          if (bestAxis === 'x') {
            finalX = bestSnapValue
          } else {
            finalY = bestSnapValue
          }

          // Update guide line directly via DOM
          const guide = snapGuideRef.current
          if (guide) {
            const zoom = cameraRef.current.z
            guide.style.display = 'block'
            if (bestAxis === 'x') {
              guide.style.left = `${bestSnapValue}px`
              guide.style.top = '-99999px'
              guide.style.width = `${1 / zoom}px`
              guide.style.height = '199998px'
            } else {
              guide.style.left = '-99999px'
              guide.style.top = `${bestSnapValue}px`
              guide.style.width = '199998px'
              guide.style.height = `${1 / zoom}px`
            }
          }
        } else {
          snapStateRef.current = null
          const guide = snapGuideRef.current
          if (guide) guide.style.display = 'none'
        }
      }
    } else {
      if (snapStateRef.current) {
        snapStateRef.current = null
        const guide = snapGuideRef.current
        if (guide) guide.style.display = 'none'
      }
    }

    const allNodes = useNodeStore.getState().nodes
    const currentNode = allNodes[id]
    const descendants = dragDescendantsRef.current
    const rotational = rotationalDragRef.current

    if (currentNode && descendants.length > 0 && rotational) {
      // Rotational drag: rotate descendant offsets by the angle delta
      const newAngle = Math.atan2(finalY - rotational.pivotY, finalX - rotational.pivotX)
      const deltaAngle = newAngle - rotational.initialAngle
      const cosA = Math.cos(deltaAngle)
      const sinA = Math.sin(deltaAngle)

      moveNode(id, finalX, finalY)
      batchMoveNodes(descendants.map(d => {
        const offset = rotational.initialOffsets.get(d)
        if (!offset) return { id: d, dx: 0, dy: 0 }
        const rotatedDx = offset.dx * cosA - offset.dy * sinA
        const rotatedDy = offset.dx * sinA + offset.dy * cosA
        const desiredX = finalX + rotatedDx
        const desiredY = finalY + rotatedDy
        const dn = allNodes[d]
        return { id: d, dx: desiredX - (dn?.x ?? 0), dy: desiredY - (dn?.y ?? 0) }
      }))
    } else if (currentNode && descendants.length > 0) {
      // Normal drag: translate all descendants by the same delta
      const dx = finalX - currentNode.x
      const dy = finalY - currentNode.y
      moveNode(id, finalX, finalY)
      batchMoveNodes(descendants.map(d => ({ id: d, dx, dy })))
    } else {
      moveNode(id, finalX, finalY)
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

  const handleMaxWidthChange = useCallback((id: string, maxWidth: number) => {
    sendMarkdownSetMaxWidth(id, maxWidth)
  }, [])

  const handleDirectoryCwdChange = useCallback((id: string, newCwd: string) => {
    cwdMapRef.current.set(id, newCwd)
    sendDirectoryCwd(id, newCwd)
  }, [])

  const handleFilePathChange = useCallback((id: string, newFilePath: string) => {
    sendFilePath(id, newFilePath)
  }, [])

  const handleTitleTextChange = useCallback((id: string, text: string) => {
    sendTitleText(id, text)
  }, [])

  const spawnNode = useCallback(async (
    create: (parentId: string, cwd: string | undefined) => Promise<string>,
    parentIdOverride?: string
  ) => {
    const anchor = focusRef.current ?? selectionRef.current
    if (!anchor) return
    const parentId = parentIdOverride ?? anchor
    const cwd = getParentCwd(parentId)
    const nodeId = await create(parentId, cwd)
    if (cwd) cwdMapRef.current.set(nodeId, cwd)
    await navigateToNode(nodeId)
  }, [getParentCwd, navigateToNode])

  const createChildNode = useCallback(async (parentNodeId: string, type: AddNodeType, hint?: { x: number; y: number }): Promise<string> => {
    const cwd = getParentCwd(parentNodeId)
    let nodeId: string
    switch (type) {
      case 'claude': { const r = await sendTerminalCreate(parentNodeId, { cwd, claude: { appendSystemPrompt: false } }, undefined, undefined, hint?.x, hint?.y); nodeId = r.sessionId; break }
      case 'terminal': {
        const parentNode = useNodeStore.getState().nodes[parentNodeId]
        const { initialInput, initialName: mdName, x, y } = getMarkdownSpawnInfo(parentNode)
        const r = await sendTerminalCreate(parentNodeId, cwd ? { cwd } : undefined, undefined, mdName, hint?.x ?? x, hint?.y ?? y, initialInput)
        nodeId = r.sessionId
        break
      }
      case 'markdown': { const r = await sendMarkdownAdd(parentNodeId, hint?.x, hint?.y); nodeId = r.nodeId; break }
      case 'directory': { const r = await sendDirectoryAdd(parentNodeId, cwd ?? '~', hint?.x, hint?.y); nodeId = r.nodeId; break }
      case 'file': { const r = await sendFileAdd(parentNodeId, '', hint?.x, hint?.y); nodeId = r.nodeId; break }
      case 'title': { const r = await sendTitleAdd(parentNodeId, hint?.x, hint?.y); nodeId = r.nodeId; break }
    }
    if (cwd) cwdMapRef.current.set(nodeId, cwd)
    if (type === 'file' || type === 'title' || type === 'directory') {
      useNodeStore.getState().markFreshlyCreated(nodeId)
    }
    return nodeId
  }, [getParentCwd])

  const handleAddNode = useCallback(async (parentNodeId: string, type: AddNodeType) => {
    const nodeId = await createChildNode(parentNodeId, type)
    await navigateToNode(nodeId)
  }, [createChildNode, navigateToNode])

  const handleEdgeSplitSelect = useCallback(async (type: AddNodeType) => {
    const split = edgeSplit
    if (!split) return
    setEdgeSplit(null)

    // Sanity check: verify worldPoint lies on (or near) the edge line
    const allNodes = useNodeStore.getState().nodes
    const pn = allNodes[split.parentId]
    const cn = allNodes[split.childId]
    const ax = pn?.x ?? 0, ay = pn?.y ?? 0
    const bx = cn?.x ?? 0, by = cn?.y ?? 0
    const dx = bx - ax, dy = by - ay, lenSq = dx * dx + dy * dy
    if (lenSq > 0) {
      const t = Math.max(0, Math.min(1, ((split.worldPoint.x - ax) * dx + (split.worldPoint.y - ay) * dy) / lenSq))
      const dist = Math.hypot(split.worldPoint.x - (ax + t * dx), split.worldPoint.y - (ay + t * dy))
      if (dist > 2) window.api.log(`[edge-split] worldPoint is ${dist.toFixed(1)}px from edge line`)
    }

    const nodeId = await createChildNode(split.parentId, type, split.worldPoint)
    await sendReparent(split.childId, nodeId)
    await navigateToNode(nodeId)
  }, [edgeSplit, createChildNode, navigateToNode])

  // Global keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = async (e: KeyboardEvent) => {
      // Cmd+S / Cmd+K: toggle search modal (before isEditable guard so it works from search input)
      if (e.metaKey && !e.shiftKey && (e.key === 's' || e.key === 'k')) {
        e.preventDefault()
        e.stopPropagation()
        setSearchVisible(v => !v)
        return
      }

      // Cmd+? (Cmd+Shift+/ or Cmd+/): toggle help modal
      if (e.metaKey && (e.key === '?' || e.key === '/')) {
        e.preventDefault()
        e.stopPropagation()
        setHelpVisible(v => !v)
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
          // Allow Cmd+Arrow (word/line navigation), Escape (exit editing),
          // and Cmd+Z (native undo) to reach the control
          if (e.key === 'Escape' || (e.metaKey && (e.key.startsWith('Arrow') || e.key === 'z'))) return
        }
      }

      // Cmd+Z: undo archive (only when not in a text field — the isEditable guard above returns early)
      if (e.metaKey && e.key === 'z') {
        e.preventDefault()
        e.stopPropagation()
        const entry = popArchiveUndo()
        if (!entry) {
          shakeCamera()
          return
        }
        ;(async () => {
          await sendUnarchive(entry.parentId, entry.nodeId)
          const { nodes } = useNodeStore.getState()
          for (const childId of entry.reparentedChildIds) {
            const child = nodes[childId]
            if (child && child.parentId === entry.parentId) {
              sendReparent(childId, entry.nodeId)
            }
          }
          navigateToNode(entry.nodeId)
        })()
        return
      }

      // Cmd+W: archive the focused node
      if (e.metaKey && e.key === 'w') {
        e.preventDefault()
        e.stopPropagation()
        const id = focusRef.current
        if (id) {
          handleRemoveNode(id)
        } else {
          shakeCamera()
        }
        return
      }

      // Cmd+[/]: camera history back/forward
      if (e.metaKey && !e.shiftKey && (e.key === '[' || e.key === ']')) {
        e.preventDefault()
        e.stopPropagation()
        navigateHistory(e.key === '[' ? 'back' : 'forward')
        return
      }

      if (e.metaKey && e.key === 't') {
        e.preventDefault()
        e.stopPropagation()
        spawnNode(async (parentId, cwd) => {
          const parentNode = useNodeStore.getState().nodes[parentId]
          const { initialInput, initialName, x, y } = getMarkdownSpawnInfo(parentNode)
          const r = await sendTerminalCreate(parentId, cwd ? { cwd } : undefined, undefined, initialName, x, y, initialInput)
          return r.sessionId
        })
      }

      if (e.metaKey && e.key === 'e') {
        e.preventDefault()
        e.stopPropagation()
        spawnNode(async (parentId, cwd) => {
          const r = await sendTerminalCreate(parentId, { cwd, claude: { appendSystemPrompt: false } })
          return r.sessionId
        })
      }

      if (e.metaKey && e.key === 'm') {
        e.preventDefault()
        e.stopPropagation()
        spawnNode(async (parentId) => {
          const r = await sendMarkdownAdd(parentId)
          return r.nodeId
        })
      }


      // Cmd+D: fork the focused Claude session, or shake if not a Claude surface
      if (e.metaKey && e.key === 'd') {
        e.preventDefault()
        e.stopPropagation()
        const focusedId = focusRef.current
        if (focusedId) {
          const node = useNodeStore.getState().nodes[focusedId]
          if (node?.claudeSessionHistory && node.claudeSessionHistory.length > 0) {
            handleForkSession(focusedId)
          } else {
            shakeCamera()
          }
        } else {
          shakeCamera()
        }
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
            speak(selection).then((ok) => {
              if (!ok) showToast('Speech synthesis unavailable — see TTS-SETUP.md')
            })
          }
        }
      }

      // Cmd+Enter: focus the selected node
      if (e.metaKey && e.key === 'Enter') {
        e.preventDefault()
        e.stopPropagation()
        const sel = selectionRef.current
        if (sel) {
          handleNodeFocus(sel)
        }
        return
      }

      // Cmd+Up Arrow: select parent node (one press), or fitAll from root
      if (e.metaKey && e.key === 'ArrowUp') {
        e.preventDefault()
        e.stopPropagation()
        snapToTarget()
        const target = focusRef.current ?? selectionRef.current ?? lastFocusedRef.current
        if (!target) return

        // Unfocus
        focusRef.current = null
        setFocusedId(null)
        setScrollMode(false)

        const node = useNodeStore.getState().nodes[target]
        if (target === 'root' || !node || node.parentId === 'root') {
          // At root level → remember for fallback, clear selection, fit all
          lastFocusedRef.current = target
          setSelection(null)
          fitAllNodes()
          return
        }

        // Select parent
        setSelection(node.parentId)
        lastFocusedRef.current = node.parentId
        flashNode(node.parentId)
        flyToSelection(node.parentId)
      }

      // Cmd+Down Arrow: jump to highest-priority unattended crab
      if (e.metaKey && e.key === 'ArrowDown') {
        e.preventDefault()
        e.stopPropagation()
        snapToTarget()
        const best = highestPriorityCrab(crabsRef.current)
        if (!best || best.nodeId === focusRef.current) {
          shakeCamera()
        } else {
          navigateToNode(best.nodeId)
        }
      }

      // Cmd+Left/Right Arrow: cycle through crabs in toolbar order
      if (e.metaKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        e.preventDefault()
        e.stopPropagation()
        snapToTarget()
        const anchor = focusRef.current ?? lastCrabRef.current?.nodeId ?? null
        if (!anchor) {
          shakeCamera()
          return
        }
        const direction = e.key === 'ArrowRight' ? 'right' : 'left'
        const next = adjacentCrab(crabsRef.current, anchor, direction, lastCrabRef.current?.createdAt)
        if (!next) {
          shakeCamera()
        } else {
          lastCrabRef.current = { nodeId: next.nodeId, createdAt: next.createdAt }
          navigateToNode(next.nodeId)
        }
      }

      // Escape: close search/help modal, close terminal search, cancel reparent mode, or stop TTS
      if (e.key === 'Escape') {
        if (searchVisibleRef.current) {
          setSearchVisible(false)
          return
        }
        if (helpVisibleRef.current) {
          setHelpVisible(false)
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
  }, [spawnNode, handleNodeFocus, flyToSelection, fitAllNodes, snapToTarget, navigateToNode, navigateHistory, shakeCamera, bringToFront, speak, ttsStop, isSpeaking, handleForkSession])

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
    // Search/help modals handle their own wheel events
    if ((e.target as HTMLElement).closest('.search-modal') || (e.target as HTMLElement).closest('.help-modal')) return
    setSearchVisible(false)
    setHelpVisible(false)
    setQuickActions(null)
    setEdgeSplit(null)
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
    setHelpVisible(false)
    setQuickActions(null)
    setEdgeSplit(null)
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

  const handleCanvasUnfocus = useCallback((e: MouseEvent) => {
    setSearchVisible(false)
    setHelpVisible(false)
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
    // Edge split: cmd+click on a hovered edge to show node type picker
    const edge = hoveredEdgeRef.current
    if (edge && !focusRef.current) {
      if (e.metaKey) {
        clearHoveredEdge()
        setEdgeSplit({ parentId: edge.parentId, childId: edge.childId, worldPoint: edge.point, screenX: e.clientX, screenY: e.clientY })
      } else {
        // Fly camera to frame both parent and child nodes
        const viewport = document.querySelector('.canvas-viewport') as HTMLElement | null
        if (viewport) {
          const allNodes = useNodeStore.getState().nodes
          const rects: Array<{ x: number; y: number; width: number; height: number }> = []
          if (edge.parentId === 'root') {
            rects.push({ x: -ROOT_NODE_RADIUS, y: -ROOT_NODE_RADIUS, width: ROOT_NODE_RADIUS * 2, height: ROOT_NODE_RADIUS * 2 })
          } else {
            const parent = allNodes[edge.parentId]
            if (parent) {
              const size = nodePixelSize(parent)
              rects.push({ x: parent.x - size.width / 2, y: parent.y - size.height / 2, ...size })
            }
          }
          const child = allNodes[edge.childId]
          if (child) {
            const size = nodePixelSize(child)
            rects.push({ x: child.x - size.width / 2, y: child.y - size.height / 2, ...size })
          }
          const bounds = unionBounds(rects)
          if (bounds) {
            flyTo(cameraToFitBounds(bounds, viewport.clientWidth, viewport.clientHeight, 0.1, UNFOCUS_SNAP_ZOOM))
          }
        }
      }
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
  }, [handleUnfocus, flyToUnfocusZoom, handleNodeFocus, hoveredEdgeRef, clearHoveredEdge])

  return (
    <div className="app">
      <Canvas camera={camera} surfaceRef={surfaceRef} onWheel={handleCanvasWheel} onPanStart={handleCanvasPanStart} onCanvasClick={handleCanvasUnfocus} onDoubleClick={fitAllNodes} background={<CanvasBackground camera={camera} cameraRef={cameraRef} edgesRef={edgesRef} maskRectsRef={maskRectsRef} selectionRef={selectionRef} reparentEdgeRef={reparentEdgeRef} />} overlay={<><SearchModal visible={searchVisible} onDismiss={() => setSearchVisible(false)} onNavigateToNode={(id) => { setSearchVisible(false); handleNodeFocus(id) }} onReviveNode={handleReviveNode} /><HelpModal visible={helpVisible} onDismiss={() => setHelpVisible(false)} /></>}>
        <RootNode
          focused={focusedId === 'root'}
          selected={selection === 'root'}
          onClick={() => handleNodeFocus('root')}
          archivedChildren={rootArchivedChildren}
          onUnarchive={handleUnarchive}
          onArchiveDelete={handleArchiveDelete}
          onArchiveToggled={handleArchiveToggled}
          onAddNode={handleAddNode}
          onReparentTarget={handleReparentTarget}
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
            selected={selection === t.id}
            anyNodeFocused={focusedId !== null}
            claudeStatusUnread={t.claudeStatusUnread}
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
            claudeSessionHistory={t.claudeSessionHistory}
            claudeState={t.claudeState}
            claudeModel={t.claudeModel}
            onNodeReady={handleNodeReady}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
            onStartReparent={handleStartReparent}
            onReparentTarget={handleReparentTarget}
            terminalSessions={t.terminalSessions}
            onSessionRevive={handleSessionRevive}
            onFork={handleForkSession}
            onExtraCliArgs={handleExtraCliArgs}
            extraCliArgs={t.extraCliArgs}
            onAddNode={handleAddNode}
            cameraRef={cameraRef}
          />
        ))}
        {markdowns.map((m) => {
          const isFileBacked = !!m.fileBacked
          const parentNode = nodes[m.parentId]
          const fileError = isFileBacked && parentNode?.type !== 'file'
          const effectiveContent = isFileBacked ? (fileContents[m.id] ?? '') : m.content
          return (
            <MarkdownCard
              key={m.id}
              id={m.id}
              x={m.x}
              y={m.y}
              width={m.width}
              height={m.height}
              zIndex={m.zIndex}
              zoom={camera.z}
              content={effectiveContent}
              maxWidth={m.maxWidth}
              name={m.name}
              colorPresetId={m.colorPresetId}
              resolvedPreset={resolvedPresets[m.id]}
              archivedChildren={m.archivedChildren}
              focused={focusedId === m.id}
              selected={selection === m.id}
              onFocus={handleNodeFocus}
              onUnfocus={() => { handleUnfocus(); flyToUnfocusZoom() }}
              onClose={handleRemoveNode}
              onMove={handleMove}
              onResize={handleResizeMarkdown}
              onContentChange={handleMarkdownContent}
              onMaxWidthChange={handleMaxWidthChange}
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
              onShipIt={parentNode?.type === 'terminal' ? handleShipIt : undefined}
              fileBacked={isFileBacked}
              fileError={fileError}
              onAddNode={handleAddNode}
              cameraRef={cameraRef}
            />
          )
        })}
        {titles.map((t) => (
          <TitleCard
            key={t.id}
            id={t.id}
            x={t.x}
            y={t.y}
            zIndex={tieredZIndex('title', t.zIndex)}
            zoom={camera.z}
            text={t.text}
            colorPresetId={t.colorPresetId}
            resolvedPreset={resolvedPresets[t.id]}
            archivedChildren={t.archivedChildren}
            focused={focusedId === t.id}
            selected={selection === t.id}
            onFocus={handleNodeFocus}
            onClose={handleRemoveNode}
            onMove={handleMove}
            onTextChange={handleTitleTextChange}
            onColorChange={handleColorChange}
            onUnarchive={handleUnarchive}
            onArchiveDelete={handleArchiveDelete}
            onArchiveToggled={handleArchiveToggled}
            onNodeReady={handleNodeReady}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
            onStartReparent={handleStartReparent}
            onReparentTarget={handleReparentTarget}
            onAddNode={handleAddNode}
            cameraRef={cameraRef}
          />
        ))}
        {directories.map((d) => (
          <DirectoryCard
            key={d.id}
            id={d.id}
            x={d.x}
            y={d.y}
            zIndex={tieredZIndex('directory', d.zIndex)}
            zoom={camera.z}
            cwd={d.cwd}
            colorPresetId={d.colorPresetId}
            gitStatus={d.gitStatus}
            resolvedPreset={resolvedPresets[d.id]}
            archivedChildren={d.archivedChildren}
            focused={focusedId === d.id}
            selected={selection === d.id}
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
            onAddNode={handleAddNode}
            cameraRef={cameraRef}
          />
        ))}
        {files.map((f) => (
          <FileCard
            key={f.id}
            id={f.id}
            x={f.x}
            y={f.y}
            zIndex={f.zIndex}
            zoom={camera.z}
            filePath={f.filePath}
            inheritedCwd={getAncestorCwd(nodes, f.id, cwdMapRef.current)}
            colorPresetId={f.colorPresetId}
            resolvedPreset={resolvedPresets[f.id]}
            archivedChildren={f.archivedChildren}
            focused={focusedId === f.id}
            selected={selection === f.id}
            onFocus={handleNodeFocus}
            onClose={handleRemoveNode}
            onMove={handleMove}
            onFilePathChange={handleFilePathChange}
            onColorChange={handleColorChange}
            onUnarchive={handleUnarchive}
            onArchiveDelete={handleArchiveDelete}
            onArchiveToggled={handleArchiveToggled}
            onNodeReady={handleNodeReady}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
            onStartReparent={handleStartReparent}
            onReparentTarget={handleReparentTarget}
            onAddNode={handleAddNode}
            cameraRef={cameraRef}
          />
        ))}
        {hoveredEdge && (
          <div
            className="edge-split-indicator"
            style={{
              left: hoveredEdge.point.x,
              top: hoveredEdge.point.y,
            }}
          />
        )}
        <div
          ref={snapGuideRef}
          className="snap-guide"
          style={{ display: 'none', position: 'absolute', pointerEvents: 'none', zIndex: 999999 }}
        />
      </Canvas>
      <Toolbar
        inputDevice={inputDevice}
        onToggleInputDevice={toggleInputDevice}
        crabs={crabs}
        onCrabClick={handleCrabClick}
        onCrabReorder={handleCrabReorder}
        selectedNodeId={focusedId}
        zoom={camera.z}
        onHelpClick={() => setHelpVisible(v => !v)}
        keycastEnabled={keycastEnabled}
        onKeycastToggle={() => setKeycastEnabled(v => !v)}
        onDebugCapture={handleDebugCapture}
      />
      {quickActions && resolvedPresets[quickActions.nodeId] && (
        <FloatingToolbar
          nodeId={quickActions.nodeId}
          screenX={quickActions.screenX}
          screenY={quickActions.screenY}
          preset={resolvedPresets[quickActions.nodeId]}
          onDismiss={() => setQuickActions(null)}
        />
      )}
      {edgeSplit && (
        <EdgeSplitMenu
          screenX={edgeSplit.screenX}
          screenY={edgeSplit.screenY}
          onSelect={handleEdgeSplitSelect}
          onDismiss={() => setEdgeSplit(null)}
        />
      )}
      <Toast toasts={toasts} onExpire={expireToast} />
      {keycastEnabled && <KeycastOverlay />}
    </div>
  )
}
