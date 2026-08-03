import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Canvas } from './components/Canvas'
import { Toast } from './components/Toast'
import { onToast, showToast } from './lib/toast'
import { RootNode } from './components/RootNode'
import { TerminalCard, terminalSelectionGetters, terminalSearchOpeners, terminalSearchClosers } from './components/TerminalCard'
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
import { PeerCameraOverlay } from './components/PeerCameraOverlay'
import { ResizeGhost } from './components/ResizeGhost'
import { useCamera } from './hooks/useCamera'
import { useTTS } from './hooks/useTTS'
import { useEdgeHover } from './hooks/useEdgeHover'
import { useRtsSelect } from './hooks/useRtsSelect'
import { useInertiaBlock, dumpInertiaLog } from './hooks/useInertiaBlock'
import { useCardChromeVars, useFacet } from './hooks/useFacet'
import { loadClientMods } from './mods'
import { cameraToFitBounds, cameraToFitBoundsWithCenter, unionBounds, screenToCanvas, computeFlyToDuration, computeFlyToSpeed, expandCameraToInclude, focusZoomCeiling } from './lib/camera'
import { ROOT_NODE_RADIUS, ROOT_FOCUS_RADIUS, UNFOCUS_SNAP_ZOOM, DEFAULT_COLS, DEFAULT_ROWS, DIRECTORY_HEIGHT, terminalPixelSize, terminalSizeFromCorner, ZOOM_DRAG_SENSITIVITY } from './lib/constants'
import { nodeDisplayTitle } from './lib/node-title'
import { isDescendantOf, isImmediateChildOf, getDescendantIds, getAncestorCwd, resolveInheritedPreset } from './lib/tree-utils'
import { DEFAULT_PRESET } from './lib/color-presets'

import { useNodeStore, nodePixelSize } from './stores/nodeStore'
import { useSavedViewportStore } from './stores/savedViewportStore'
import { useReparentStore } from './stores/reparentStore'
import { useResizeStore } from './stores/resizeStore'
import { useCameraLockStore } from './stores/cameraLockStore'
import { initServerSync, destroyServerSync, sendMove, sendBatchMove, sendRename, sendSetColor, sendBringToFront, sendArchive, sendUnarchive, sendArchiveDelete, sendTerminalCreate, sendMarkdownAdd, sendMarkdownResize, sendMarkdownContent, sendMarkdownSetMaxWidth, sendTerminalResize, sendReparent, sendSwapParentChild, sendDirectoryAdd, sendDirectoryCwd, sendDirectoryWtSpawn, sendFileAdd, sendFilePath, sendTitleAdd, sendTitleText, sendForkSession, sendTerminalRestart, sendCrabReorder, sendUndoPush, sendUndoSetCursor, sendCameraBounds, sendSaveViewport } from './lib/server-sync'
import { initTooltips } from './lib/tooltip'
import { adjacentCrab, highestPriorityClaudeCrab } from './lib/crab-nav'
import { isDisposable } from '../../../shared/node-utils'
import { pushUndo, peekUndo, peekRedo, undoStep, redoStep, getCursor, getConfirmation, setConfirmation, clearConfirmation, setUndoInProgress, getUndoInProgress } from './lib/undo-buffer'
import { nodeUndoDescription } from './lib/node-title'
import type { UndoEntry, UndoMoveEntry, UndoArchiveEntry, UndoUnarchiveEntry, UndoResizeEntry } from '../../../shared/undo-types'
import { undoNeedsConfirmation, undoConfirmationVerb } from '../../../shared/undo-types'
import type { ClaudeSessionEntry } from '../../../shared/protocol'
import { pushCameraHistory, goBack, goForward } from './lib/camera-history'
import type { CrabEntry } from './lib/crab-nav'
import { deriveToolbarIndicator } from './lib/crab-nav'
import { saveFocusState, loadFocusState, cleanupStaleScrollEntries, markSessionForScrollRestore } from './lib/focus-storage'
import { playSummaryChatStartedCue } from './lib/summary-chat-wait-cue'
import { shouldYieldToFocusedEditor, viewportSlotFor } from './lib/keyboard'
import { tieredZIndex } from '../../../shared/card-types'
import type { NodeData } from '../../../shared/state'

function getMarkdownSpawnInfo(parentNode: import('../../../shared/state').NodeData | undefined): {
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

import type { SearchMode } from './lib/search'
import { ROOT_NODE_ID, asNodeId, nodeIdFromFirstPtySession, nodeIdsOf, type NodeId, type PtySessionId } from '../../../shared/ids'

export function App() {
  const [focusedId, setFocusedId] = useState<NodeId | null>(null)
  const [scrollMode, setScrollMode] = useState(false)
  const [searchVisible, setSearchVisible] = useState(false)
  const [searchMode, setSearchMode] = useState<SearchMode>({ kind: 'global' })
  const searchVisibleRef = useRef(false)
  searchVisibleRef.current = searchVisible
  const [helpVisible, setHelpVisible] = useState(false)
  const helpVisibleRef = useRef(false)
  helpVisibleRef.current = helpVisible
  const [keycastEnabled, setKeycastEnabled] = useState(() => localStorage.getItem('toolbar.keycast') === 'true')
  // Every mod registers, then every mod activates — before the first paint
  // that could read a facet. Idempotent, so strict mode and hot reload are fine.
  loadClientMods()
  // Publishes the active theme's card-chrome custom properties on :root.
  useCardChromeVars()
  // Fallback colour for nodes the user has not coloured — see the nodeTint facet.
  const nodeTint = useFacet('nodeTint')
  const [restartingSpaceterm, setRestartingSpaceterm] = useState(false)
  const [toasts, setToasts] = useState<Array<{ id: number; message: string; createdAt: number }>>([])
  const toastIdRef = useRef(0)
  const focusRef = useRef<NodeId | null>(focusedId)
  focusRef.current = focusedId
  const navBlockUntilRef = useRef(0)
  const onCameraEvent = useCallback((cam: import('./lib/camera').Camera, type: 'flyTo' | 'settle' | 'snapback') => {
    if (type === 'snapback') return
    if (Date.now() < navBlockUntilRef.current) return
    pushCameraHistory({ camera: cam, focusedId: focusRef.current })
  }, [])
  const [selection, setSelection] = useState<NodeId | null>(null)
  const selectionRef = useRef<NodeId | null>(null)
  selectionRef.current = selection
  const lastFocusedRef = useRef<NodeId | null>(null)
  const lastCrabRef = useRef<{ nodeId: NodeId; createdAt: string } | null>(null)
  const [crabNavEvent, setCrabNavEvent] = useState<{ fromNodeId: NodeId | null; toNodeId: NodeId; ts: number } | null>(null)
  const focusRestoredRef = useRef(false)
  const [quickActions, setQuickActions] = useState<{ nodeId: NodeId; screenX: number; screenY: number } | null>(null)
  const [edgeSplit, setEdgeSplit] = useState<{ parentId: NodeId; childId: NodeId; worldPoint: { x: number; y: number }; screenX: number; screenY: number } | null>(null)
  const cmdClickPendingRef = useRef<{ nodeId: NodeId; screenX: number; screenY: number } | null>(null)
  const shiftClickPendingRef = useRef(false)
  const pinnedFocusRef = useRef(false)
  const { speak, stop: ttsStop, isSpeaking } = useTTS()
  const { camera, cameraRef, surfaceRef, handleWheel, handlePanStart, userZoom, resetCamera, flyTo, snapToTarget, flyToUnfocusZoom, rotationalFlyTo, hopFlyTo, shakeCamera, restoredFromStorageRef, captureDebugState } = useCamera(undefined, focusRef, onCameraEvent)
  const inertiaBlock = useInertiaBlock()

  // Send camera bounding box to server whenever camera settles
  useEffect(() => {
    const viewport = document.querySelector('.canvas-viewport') as HTMLElement | null
    if (!viewport) return
    const topLeft = screenToCanvas({ x: 0, y: 0 }, camera)
    const bottomRight = screenToCanvas({ x: viewport.clientWidth, y: viewport.clientHeight }, camera)
    sendCameraBounds({
      x: topLeft.x,
      y: topLeft.y,
      width: bottomRight.x - topLeft.x,
      height: bottomRight.y - topLeft.y,
    })
  }, [camera])

  const { startDrag: startRtsSelect, overlayElement: rtsSelectOverlay } = useRtsSelect(cameraRef, (selectedNodeIds) => {
    const allNodes = useNodeStore.getState().nodes
    const rects = selectedNodeIds
      .map(id => {
        const node = allNodes[id]
        if (!node) return null
        const size = nodePixelSize(node)
        return { x: node.x - size.width / 2, y: node.y - size.height / 2, ...size }
      })
      .filter((r): r is { x: number; y: number; width: number; height: number } => r !== null)
    if (rects.length === 0) return
    const bounds = unionBounds(rects)
    if (!bounds) return
    const viewport = document.querySelector('.canvas-viewport') as HTMLElement | null
    if (!viewport) return
    // Unfocus before flying to selection
    focusRef.current = null
    pinnedFocusRef.current = false
    setFocusedId(null)
    setScrollMode(false)
    flyTo(cameraToFitBounds(bounds, viewport.clientWidth, viewport.clientHeight, 0))
  })

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
    for (const id of nodeIdsOf(nodes)) {
      map[id] = resolveInheritedPreset(nodes, id) ?? nodeTint.presetFor(nodes[id].x, nodes[id].y)
    }
    return map
  }, [nodes, nodeTint])

  // Derive crab indicators for toolbar
  const crabs = useMemo(() => {
    const entries: CrabEntry[] = []

    for (const node of Object.values(nodes)) {
      if (node.type !== 'terminal') continue
      const appearance = deriveToolbarIndicator(node.claudeState, node.claudeStatusUnread, node.claudeStatusAsleep ?? false, node.claudeSessionHistory.length > 0, node.agentType)
      const createdAt = node.terminalSessions[0]?.startedAt ?? ''
      entries.push({ nodeId: node.id, claudeSessionIds: node.claudeSessionHistory.map(e => e.claudeSessionId), kind: appearance.kind, color: appearance.color, unviewed: appearance.unviewed, asleep: appearance.asleep, createdAt, sortOrder: node.sortOrder, title: nodeDisplayTitle(node), claudeStateDecidedAt: node.claudeStateDecidedAt })
    }

    entries.sort((a, b) => a.sortOrder - b.sortOrder)
    return entries
  }, [nodes])
  const crabsRef = useRef<CrabEntry[]>([])
  crabsRef.current = crabs

  // Reparent mode state
  const reparentingNodeId = useReparentStore(s => s.reparentingNodeId)
  const reparentHoveredNodeId = useReparentStore(s => s.hoveredNodeId)

  // Resize mode state. Only the node id, deliberately: the draft size changes
  // with every pointer move and only the preview needs to re-render for it.
  const resizingNodeId = useResizeStore(s => s.resizingNodeId)

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
    const isImmediateChild = isImmediateChildOf(allNodes, reparentHoveredNodeId, reparentingNodeId)
    const isInvalid = reparentHoveredNodeId === reparentingNodeId ||
      (!isImmediateChild && isDescendantOf(allNodes, reparentHoveredNodeId, reparentingNodeId)) ||
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

  // Detect cmd+click / shift+click on canvas nodes — record pending so handleNodeFocus can intercept
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const canvasNode = (e.target as HTMLElement).closest('.canvas-node') as HTMLElement | null
      if (!canvasNode) return
      const nodeId = canvasNode.dataset.nodeId ? asNodeId(canvasNode.dataset.nodeId) : undefined
      if (!nodeId) return

      // Cmd+click: quick-actions toolbar (takes priority over shift)
      if (e.metaKey) {
        if (nodeId === focusRef.current) return
        cmdClickPendingRef.current = { nodeId, screenX: e.clientX, screenY: e.clientY }
        return
      }

      // Shift+click: pinned focus (no camera fly, pan/wheel keep focus)
      if (e.shiftKey) {
        shiftClickPendingRef.current = true
      }
    }
    window.addEventListener('mousedown', handler, { capture: true })
    return () => window.removeEventListener('mousedown', handler, { capture: true })
  }, [])

  // Persist focus state to localStorage (skip until initial restore is done)
  useEffect(() => {
    if (!focusRestoredRef.current) return
    saveFocusState(focusedId, scrollMode)
  }, [focusedId, scrollMode])

  // Track the focused node's parent so we can fly to it if the focused node disappears
  const focusedParentRef = useRef<NodeId | null>(null)
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
              .filter((n): n is import('../../../shared/state').TerminalNodeData => n.type === 'terminal')
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

  const draggingRef = useRef(new Set<NodeId>())
  const dragDescendantsRef = useRef<NodeId[]>([])

  // Snap-to-align state
  const ctrlAtStartRef = useRef(false)
  const metaKeyWasReleasedRef = useRef(false)
  const snapStateRef = useRef<{ nodeId: NodeId; axis: 'x' | 'y' } | null>(null)
  const snapGuideRef = useRef<HTMLDivElement>(null)

  // Undo: pre-drag position capture
  const preDragPositionsRef = useRef<Array<{ nodeId: NodeId; x: number; y: number }>>([])
  const preDragParentRef = useRef<NodeId>(ROOT_NODE_ID)
  const preDragDescriptionRef = useRef<string>('')

  // Rotational drag state (Shift+drag)
  const rotationalDragRef = useRef<{
    pivotX: number
    pivotY: number
    initialAngle: number
    initialOffsets: Map<NodeId, { dx: number; dy: number }>
  } | null>(null)

  const handleDragStart = useCallback((id: NodeId, solo?: boolean, ctrlAtStart?: boolean, shiftAtStart?: boolean) => {
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
          const initialOffsets = new Map<NodeId, { dx: number; dy: number }>()
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

    // Capture pre-drag positions for undo
    const allNodesForUndo = useNodeStore.getState().nodes
    const dragNode = allNodesForUndo[id]
    const positions: Array<{ nodeId: NodeId; x: number; y: number }> = []
    if (dragNode) {
      positions.push({ nodeId: id, x: dragNode.x, y: dragNode.y })
      preDragParentRef.current = dragNode.parentId
      preDragDescriptionRef.current = nodeUndoDescription(dragNode)
    }
    for (const d of dragDescendantsRef.current) {
      const dn = allNodesForUndo[d]
      if (dn) positions.push({ nodeId: d, x: dn.x, y: dn.y })
    }
    preDragPositionsRef.current = positions
  }, [])

  const handleDragEnd = useCallback((id: NodeId) => {
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
    const moves: Array<{ nodeId: NodeId; x: number; y: number }> = []
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

    // Push move undo entry if any position actually changed
    if (!getUndoInProgress() && preDragPositionsRef.current.length > 0) {
      const changed = preDragPositionsRef.current.some(pre => {
        const cur = allNodes[pre.nodeId]
        return cur && (Math.abs(cur.x - pre.x) > 0.5 || Math.abs(cur.y - pre.y) > 0.5)
      })
      if (changed) {
        const afterPositions = preDragPositionsRef.current.map(pre => {
          const cur = allNodes[pre.nodeId]
          return { nodeId: pre.nodeId, x: cur ? cur.x : pre.x, y: cur ? cur.y : pre.y }
        })
        const entry: UndoMoveEntry = {
          kind: 'move',
          ts: Date.now(),
          description: preDragDescriptionRef.current,
          positions: preDragPositionsRef.current,
          afterPositions,
          parentId: preDragParentRef.current
        }
        pushUndo(entry)
        sendUndoPush(entry)
      }
    }
    preDragPositionsRef.current = []
  }, [])

  // CWD tracking — ref so optimistic writes (spawnNode, createChildNode) don't trigger re-renders.
  // getAncestorCwd falls back to node.cwd from the store when cwdMapRef has no entry.
  // Keyed by NODE id: getAncestorCwd looks entries up while walking the parentId
  // chain. Spawn sites only have the new pty session id to hand, which is the
  // node's id because the terminal has just been created — hence the explicit
  // nodeIdFromFirstPtySession conversions below rather than a bare reuse.
  const cwdMapRef = useRef(new Map<NodeId, string>())

  const getParentCwd = useCallback((parentId: NodeId): string | undefined => {
    if (parentId === 'root') return undefined
    const allNodes = useNodeStore.getState().nodes
    return getAncestorCwd(allNodes, parentId, cwdMapRef.current)
  }, [])

  const flashNode = useCallback((nodeId: NodeId) => {
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

    inertiaBlock.activate()
    flyTo(entry.camera, computeFlyToSpeed(dist))
  }, [shakeCamera, flyTo, bringToFront, flashNode, cameraRef, inertiaBlock])

  const handleNodeFocus = useCallback((nodeId: NodeId) => {
    // Cmd+click without drag → show floating quick-actions toolbar instead of focusing
    const pending = cmdClickPendingRef.current
    cmdClickPendingRef.current = null
    if (pending && pending.nodeId === nodeId) {
      setQuickActions({ nodeId, screenX: pending.screenX, screenY: pending.screenY })
      return
    }

    // Shift+click: pin focus without camera animation
    const shiftPending = shiftClickPendingRef.current
    shiftClickPendingRef.current = false
    pinnedFocusRef.current = shiftPending

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

    if (nodeId === 'root') {
      setScrollMode(false)
    } else {
      const node = useNodeStore.getState().nodes[nodeId]
      if (!node) {
        // Node not in state yet (newly created).
        setScrollMode(false)
        return
      }
      setScrollMode(node.type === 'terminal' && node.alive)
      sendBringToFront(nodeId)
      bringToFront(nodeId)
    }

    if (!pinnedFocusRef.current) {
      inertiaBlock.activate()

      let bounds: { x: number; y: number; width: number; height: number }
      let padding = 0
      let maxZoom = focusZoomCeiling(null)

      if (nodeId === 'root') {
        bounds = { x: -ROOT_FOCUS_RADIUS, y: -ROOT_FOCUS_RADIUS, width: ROOT_FOCUS_RADIUS * 2, height: ROOT_FOCUS_RADIUS * 2 }
        padding = 0.05
      } else {
        const node = useNodeStore.getState().nodes[nodeId]!
        const size = nodePixelSize(node)
        bounds = { x: node.x - size.width / 2, y: node.y - size.height / 2, ...size }
        maxZoom = focusZoomCeiling(node.type)
      }

      const vw = viewport.clientWidth
      const vh = viewport.clientHeight

      if (useCameraLockStore.getState().locked) {
        const expanded = expandCameraToInclude(bounds, cameraRef.current, vw, vh, padding)
        if (expanded) {
          const sourceCenter = screenToCanvas({ x: vw / 2, y: vh / 2 }, cameraRef.current)
          const targetCenter = screenToCanvas({ x: vw / 2, y: vh / 2 }, expanded)
          const dist = Math.hypot(targetCenter.x - sourceCenter.x, targetCenter.y - sourceCenter.y)
          flyTo(expanded, computeFlyToSpeed(dist))
        }
      } else {
        const targetCamera = cameraToFitBounds(bounds, vw, vh, padding, maxZoom)
        const sourceCenter = screenToCanvas({ x: vw / 2, y: vh / 2 }, cameraRef.current)
        const targetCenter = screenToCanvas({ x: vw / 2, y: vh / 2 }, targetCamera)
        const dist = Math.hypot(targetCenter.x - sourceCenter.x, targetCenter.y - sourceCenter.y)
        flyTo(targetCamera, computeFlyToSpeed(dist))
      }
    }
  }, [bringToFront, flyTo, cameraRef, flashNode, inertiaBlock])

  const navigateToNode = useCallback(async (nodeId: NodeId) => {
    // Wait for node to appear in store if not yet present
    if (!useNodeStore.getState().nodes[nodeId]) {
      await new Promise<void>(resolve => {
        const unsub = useNodeStore.subscribe(state => {
          if (state.nodes[nodeId]) { unsub(); resolve() }
        })
      })
    }

    inertiaBlock.activate()
    flashNode(nodeId)
    setFocusedId(nodeId)
    setSelection(nodeId)
    lastFocusedRef.current = nodeId
    pinnedFocusRef.current = false

    const node = useNodeStore.getState().nodes[nodeId]
    if (!node) return

    const viewport = document.querySelector('.canvas-viewport') as HTMLElement | null
    if (!viewport) return

    const size = nodePixelSize(node)
    const targetBounds = { x: node.x - size.width / 2, y: node.y - size.height / 2, ...size }
    const targetCamera = cameraToFitBounds(targetBounds, viewport.clientWidth, viewport.clientHeight, 0, focusZoomCeiling(node.type))

    setScrollMode(node.type === 'terminal' && node.alive)
    sendBringToFront(nodeId)
    bringToFront(nodeId)

    const vw = viewport.clientWidth
    const vh = viewport.clientHeight

    if (useCameraLockStore.getState().locked) {
      const expanded = expandCameraToInclude(targetBounds, cameraRef.current, vw, vh, 0)
      if (expanded) {
        const sourceCenter = screenToCanvas({ x: vw / 2, y: vh / 2 }, cameraRef.current)
        const targetCenter = screenToCanvas({ x: vw / 2, y: vh / 2 }, expanded)
        const dist = Math.hypot(targetCenter.x - sourceCenter.x, targetCenter.y - sourceCenter.y)
        flyTo(expanded, computeFlyToSpeed(dist))
      }
    } else {
      const sourceCenter = screenToCanvas({ x: vw / 2, y: vh / 2 }, cameraRef.current)
      const targetCenter = screenToCanvas({ x: vw / 2, y: vh / 2 }, targetCamera)
      const dist = Math.hypot(targetCenter.x - sourceCenter.x, targetCenter.y - sourceCenter.y)

      if (dist < 50) {
        flyTo(targetCamera, computeFlyToSpeed(dist))
      } else {
        const topLeft = screenToCanvas({ x: 0, y: 0 }, cameraRef.current)
        const bottomRight = screenToCanvas({ x: vw, y: vh }, cameraRef.current)
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
      }
    }
  }, [flashNode, bringToFront, flyTo, hopFlyTo, cameraRef, inertiaBlock])

  // Focus a surface in response to an external `spaceterm-surface://` deep link.
  // The main process raises this window first; navigateToNode handles the rest.
  useEffect(() => {
    return window.api.window.onFocusNode((nodeId) => {
      navigateToNode(nodeId)
    })
  }, [navigateToNode])

  // Initialize server sync on mount — placed after getParentCwd/navigateToNode/cwdMapRef
  // so the fork-detection interceptor closure can reference them.
  useEffect(() => {
    initServerSync((nodeId, fields, prevNode) => {
      // Fork detection: when claudeSessionHistory grows with a 'fork' entry,
      // spawn a new terminal that resumes the previous Claude session.
      // Cursor has no fork — skip.
      if (!('claudeSessionHistory' in fields) || !prevNode || prevNode.type !== 'terminal') return
      // Cursor/Codex: no Claude-style in-TUI fork detection (Codex forks via native CLI + Spaceterm UI).
      if (prevNode.agentType === 'cursor' || prevNode.agentType === 'codex') return
      const history = (fields as { claudeSessionHistory: ClaudeSessionEntry[] }).claudeSessionHistory
      if (history.length <= prevNode.claudeSessionHistory.length || history.length < 2) return
      const latestEntry = history[history.length - 1]
      if (latestEntry.reason !== 'fork') return
      const resumeSessionId = history[history.length - 2].claudeSessionId
      const cwd = getParentCwd(nodeId)
      const parentNode = useNodeStore.getState().nodes[nodeId]
      const titleHistory = parentNode?.type === 'terminal' ? parentNode.shellTitleHistory : undefined
      const parentName = parentNode?.name ?? undefined
      sendTerminalCreate(nodeId, { cwd, claude: { resumeSessionId } }, titleHistory, parentName).then((result) => {
        if (cwd) cwdMapRef.current.set(nodeIdFromFirstPtySession(result.sessionId), cwd)
        navigateToNode(nodeIdFromFirstPtySession(result.sessionId))
      })
    })
    return destroyServerSync
  }, [])

  const handleCrabClick = useCallback((nodeId: NodeId, metaKey: boolean) => {
    setSearchVisible(false)
    setHelpVisible(false)
    if (nodeId === 'root') {
      handleNodeFocus(nodeId)
      return
    }
    // Cmd+click toggles asleep state
    if (metaKey) {
      const node = useNodeStore.getState().nodes[nodeId]
      if (node?.type === 'terminal') {
        window.api.node.setClaudeStatusAsleep(node.sessionId, !(node.claudeStatusAsleep ?? false))
      }
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

  const handleCrabReorder = useCallback((order: NodeId[]) => {
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

  const handleInertiaLogDump = useCallback(() => {
    const content = dumpInertiaLog()
    if (!content) {
      showToast('Inertia log is empty — scroll around first')
      return
    }
    window.api.writeDebugLog(content).then(
      (filepath) => showToast(`Inertia log → ${filepath}`),
      () => showToast('Failed to write inertia log')
    )
  }, [])

  const handleRestartSpaceterm = useCallback(async () => {
    if (restartingSpaceterm) return
    setRestartingSpaceterm(true)
    showToast('Restarting server…')
    try {
      await window.api.restartSpaceterm()
    } catch (err) {
      setRestartingSpaceterm(false)
      const message = err instanceof Error ? err.message : String(err)
      showToast(`Could not restart Spaceterm: ${message}`)
    }
  }, [restartingSpaceterm])

  const handleReparentTarget = useCallback((targetId: NodeId) => {
    const srcId = useReparentStore.getState().reparentingNodeId
    if (!srcId) return

    const allNodes = useNodeStore.getState().nodes
    const srcNode = allNodes[srcId]
    const isImmediateChild = isImmediateChildOf(allNodes, targetId, srcId)
    const isInvalid = targetId === srcId ||
      (!isImmediateChild && isDescendantOf(allNodes, targetId, srcId)) ||
      (srcNode && srcNode.parentId === targetId)

    if (isInvalid) {
      useReparentStore.getState().reset()
      handleNodeFocus(srcId)
      return
    }

    if (isImmediateChild) {
      sendSwapParentChild(srcId, targetId)
    } else {
      sendReparent(srcId, targetId)
    }
    useReparentStore.getState().reset()

    // Fly camera to fit bounds of both nodes
    const viewport = document.querySelector('.canvas-viewport') as HTMLElement | null
    if (!viewport) return
    const tgtNode = allNodes[targetId]
    if (srcNode && tgtNode && !useCameraLockStore.getState().locked) {
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


  const handleUnarchive = useCallback(async (parentNodeId: NodeId, archivedNodeId: NodeId) => {
    if (!getUndoInProgress()) {
      const { nodes, rootArchivedChildren } = useNodeStore.getState()
      const archiveArray = parentNodeId === 'root'
        ? rootArchivedChildren
        : nodes[parentNodeId]?.archivedChildren ?? []
      const archived = archiveArray.find(e => e.data.id === archivedNodeId)
      if (archived) {
        const entry: UndoUnarchiveEntry = {
          kind: 'unarchive',
          ts: Date.now(),
          description: nodeUndoDescription(archived.data),
          nodeId: archivedNodeId,
          parentId: parentNodeId
        }
        pushUndo(entry)
        sendUndoPush(entry)
      }
    }
    await sendUnarchive(parentNodeId, archivedNodeId)
  }, [])

  const handleReviveNode = useCallback(async (archiveParentId: NodeId, archivedNodeId: NodeId) => {
    setSearchVisible(false)
    if (!getUndoInProgress()) {
      const { nodes, rootArchivedChildren } = useNodeStore.getState()
      const archiveArray = archiveParentId === 'root'
        ? rootArchivedChildren
        : nodes[archiveParentId]?.archivedChildren ?? []
      const archived = archiveArray.find(e => e.data.id === archivedNodeId)
      if (archived) {
        const entry: UndoUnarchiveEntry = {
          kind: 'unarchive',
          ts: Date.now(),
          description: nodeUndoDescription(archived.data),
          nodeId: archivedNodeId,
          parentId: archiveParentId
        }
        pushUndo(entry)
        sendUndoPush(entry)
      }
    }
    await sendUnarchive(archiveParentId, archivedNodeId)
    await navigateToNode(archivedNodeId)
  }, [navigateToNode])

  const handleArchiveDelete = useCallback(async (parentNodeId: NodeId, archivedNodeId: NodeId) => {
    await sendArchiveDelete(parentNodeId, archivedNodeId)
  }, [])

  const handleOpenArchiveSearch = useCallback((nodeId: NodeId) => {
    setSearchMode({ kind: 'archived-children', parentId: nodeId })
    setSearchVisible(true)
  }, [])

  const handleSessionRevive = useCallback(async (nodeId: NodeId, session: import('../../../shared/state').TerminalSessionEntry) => {
    if (!session.claudeSessionId) return
    const cwd = getParentCwd(nodeId)
    const node = useNodeStore.getState().nodes[nodeId]
    const resumeOpts = node?.type === 'terminal' && node.agentType === 'cursor'
      ? { cwd, cursor: { resumeSessionId: session.claudeSessionId } }
      : node?.type === 'terminal' && node.agentType === 'codex'
        ? { cwd, codex: { resumeSessionId: session.claudeSessionId } }
        : { cwd, claude: { resumeSessionId: session.claudeSessionId } }
    const result = await sendTerminalCreate(nodeId, resumeOpts, session.shellTitleHistory)
    if (cwd) cwdMapRef.current.set(nodeIdFromFirstPtySession(result.sessionId), cwd)
    navigateToNode(nodeIdFromFirstPtySession(result.sessionId))
  }, [getParentCwd, navigateToNode])

  const handleForkSession = useCallback(async (nodeId: NodeId) => {
    try {
      const result = await sendForkSession(nodeId)
      navigateToNode(nodeIdFromFirstPtySession(result.sessionId))
    } catch (err: any) {
      console.error(`Fork session failed: ${err.message}`)
    }
  }, [navigateToNode])

  const handleExtraCliArgs = useCallback(async (nodeId: NodeId, extraCliArgs: string) => {
    try {
      await sendTerminalRestart(nodeId, extraCliArgs)
    } catch (err: any) {
      console.error(`Terminal restart failed: ${err.message}`)
    }
  }, [])

  const handleRemoveNode = useCallback(async (id: NodeId) => {
    cwdMapRef.current.delete(id)
    const { nodes } = useNodeStore.getState()
    const node = nodes[id]
    if (node && !isDisposable(node) && !getUndoInProgress()) {
      const reparentedChildIds = nodeIdsOf(nodes).filter(k => nodes[k].parentId === id)
      const entry: UndoArchiveEntry = {
        kind: 'archive',
        ts: Date.now(),
        description: nodeUndoDescription(node),
        nodeId: id,
        parentId: node.parentId,
        reparentedChildIds
      }
      pushUndo(entry)
      sendUndoPush(entry)
    }
    await sendArchive(id)
    // Focus cleanup + fly-to handled by Zustand subscription when node-removed arrives
  }, [])

  const executeUndoRedo = useCallback((entry: UndoEntry, direction: 'undo' | 'redo') => {
    switch (entry.kind) {
      case 'move': {
        // Restore positions: undo → original positions, redo → after positions
        const targetPositions = direction === 'undo' ? entry.positions : entry.afterPositions
        const allNodes = useNodeStore.getState().nodes
        const validPositions = targetPositions.filter(p => allNodes[p.nodeId])
        if (validPositions.length === 0) {
          shakeCamera()
          return
        }

        // Batch local update (compute deltas from current → target)
        const deltas = validPositions.map(p => ({
          id: p.nodeId,
          dx: p.x - allNodes[p.nodeId].x,
          dy: p.y - allNodes[p.nodeId].y
        }))
        useNodeStore.getState().batchMoveNodes(deltas)

        // Send absolute positions to server
        sendBatchMove(validPositions.map(p => ({ nodeId: p.nodeId, x: p.x, y: p.y })))

        // Fit camera to include all restored nodes + parent
        const viewport = document.querySelector('.canvas-viewport') as HTMLElement | null
        if (viewport) {
          const vw = viewport.clientWidth
          const vh = viewport.clientHeight
          const nodesAfter = useNodeStore.getState().nodes
          const rects: Array<{ x: number; y: number; width: number; height: number }> = []

          for (const pos of validPositions) {
            const node = nodesAfter[pos.nodeId]
            if (node) {
              const size = nodePixelSize(node)
              rects.push({ x: node.x - size.width / 2, y: node.y - size.height / 2, ...size })
            }
          }

          // Include the parent node in the camera bounds
          if (entry.parentId !== 'root') {
            const parent = nodesAfter[entry.parentId]
            if (parent) {
              const size = nodePixelSize(parent)
              rects.push({ x: parent.x - size.width / 2, y: parent.y - size.height / 2, ...size })
            }
          }

          const bounds = unionBounds(rects)
          if (bounds) {
            // Only expand — never shrink the viewport
            const expanded = expandCameraToInclude(bounds, cameraRef.current, vw, vh)
            if (expanded) flyTo(expanded)
          }
        }
        break
      }

      case 'archive': {
        if (direction === 'undo') {
          // Undo archive = unarchive the node, then reparent children back
          setUndoInProgress(true)
          ;(async () => {
            try {
              await sendUnarchive(entry.parentId, entry.nodeId)
              const { nodes } = useNodeStore.getState()
              for (const childId of entry.reparentedChildIds) {
                const child = nodes[childId]
                if (child && child.parentId === entry.parentId) {
                  sendReparent(childId, entry.nodeId)
                }
              }
              navigateToNode(entry.nodeId)
            } finally {
              setUndoInProgress(false)
            }
          })()
        } else {
          // Redo archive = re-archive the node
          setUndoInProgress(true)
          ;(async () => {
            try {
              await sendArchive(entry.nodeId)
            } finally {
              setUndoInProgress(false)
            }
          })()
        }
        break
      }

      case 'unarchive': {
        if (direction === 'undo') {
          // Undo unarchive = re-archive the node
          setUndoInProgress(true)
          ;(async () => {
            try {
              await sendArchive(entry.nodeId)
            } finally {
              setUndoInProgress(false)
            }
          })()
        } else {
          // Redo unarchive = unarchive the node again
          setUndoInProgress(true)
          ;(async () => {
            try {
              await sendUnarchive(entry.parentId, entry.nodeId)
              navigateToNode(entry.nodeId)
            } finally {
              setUndoInProgress(false)
            }
          })()
        }
        break
      }

      case 'resize': {
        // Symmetric: both directions are the same mutation with a different
        // size. The server clamps, so an entry recorded under wider limits
        // lands on whatever is legal now rather than being rejected.
        const cols = direction === 'undo' ? entry.cols : entry.afterCols
        const rows = direction === 'undo' ? entry.rows : entry.afterRows
        if (!useNodeStore.getState().nodes[entry.nodeId]) {
          shakeCamera()
          break
        }
        sendTerminalResize(entry.nodeId, cols, rows)
        break
      }
    }
  }, [flyTo, navigateToNode, shakeCamera])

  const handleShipIt = useCallback((nodeId: NodeId) => {
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
    pinnedFocusRef.current = false
    setFocusedId(null)
    setScrollMode(false)
  }, [])

  const handleHoverFocus = useCallback((nodeId: NodeId) => {
    if (!useCameraLockStore.getState().locked) return
    const node = useNodeStore.getState().nodes[nodeId]
    if (!node) return
    setFocusedId(nodeId)
    setSelection(nodeId)
    focusRef.current = nodeId
    lastFocusedRef.current = nodeId
    setScrollMode(node.type === 'terminal' && node.alive)
    sendBringToFront(nodeId)
    bringToFront(nodeId)
  }, [bringToFront])

  const handleHoverUnfocus = useCallback(() => {
    if (!useCameraLockStore.getState().locked) return
    if (!focusRef.current) return
    focusRef.current = null
    pinnedFocusRef.current = false
    setFocusedId(null)
    setScrollMode(false)
  }, [])

  const flyToSelection = useCallback((nodeId: NodeId) => {
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
        const parentId = focusedParentRef.current ?? ROOT_NODE_ID
        focusRef.current = null
        setFocusedId(null)
        setScrollMode(false)
        lastFocusedRef.current = parentId
        setSelection(parentId)
        flashNode(parentId)

        if (useCameraLockStore.getState().locked) {
          const viewport = document.querySelector('.canvas-viewport') as HTMLElement | null
          if (viewport) {
            let parentBounds: { x: number; y: number; width: number; height: number }
            if (parentId === 'root') {
              parentBounds = { x: -ROOT_NODE_RADIUS, y: -ROOT_NODE_RADIUS, width: ROOT_NODE_RADIUS * 2, height: ROOT_NODE_RADIUS * 2 }
            } else {
              const parentNode = state.nodes[parentId]
              if (parentNode) {
                const size = nodePixelSize(parentNode)
                parentBounds = { x: parentNode.x - size.width / 2, y: parentNode.y - size.height / 2, ...size }
              } else {
                parentBounds = { x: -ROOT_NODE_RADIUS, y: -ROOT_NODE_RADIUS, width: ROOT_NODE_RADIUS * 2, height: ROOT_NODE_RADIUS * 2 }
              }
            }
            const expanded = expandCameraToInclude(parentBounds, cameraRef.current, viewport.clientWidth, viewport.clientHeight)
            if (expanded) flyTo(expanded)
          }
        } else {
          flyToSelection(parentId)
        }
      }
    })
    return unsub
  }, [flyToSelection, flyTo, cameraRef])

  // Clear unread flag on server when a terminal is focused
  useEffect(() => {
    if (!focusedId) return
    const node = useNodeStore.getState().nodes[focusedId]
    if (node?.type === 'terminal' && node.claudeStatusUnread) {
      window.api.node.setClaudeStatusUnread(node.sessionId, false)
    }
  }, [focusedId])


  const handleStartReparent = useCallback((nodeId: NodeId) => {
    useReparentStore.getState().startReparent(nodeId)
    handleUnfocus()
    flyToUnfocusZoom()
  }, [handleUnfocus, flyToUnfocusZoom])

  const handleDisableScrollMode = useCallback(() => {
    setScrollMode(false)
  }, [])

  // Handlers that send mutations to server
  const handleMove = useCallback((id: NodeId, x: number, y: number, metaKey?: boolean, shiftKey?: boolean) => {
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
        let bestNodeId: NodeId | null = null
        let bestAxis: 'x' | 'y' = 'x'
        let bestSnapValue = 0

        for (const otherId of nodeIdsOf(allNodes)) {
          const otherNode = allNodes[otherId]
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

    // Angle snap: when Shift is held mid-drag (not rotational drag), snap to 22.5° increments from parent
    if (shiftKey && !rotationalDragRef.current) {
      const allNodesSnap = useNodeStore.getState().nodes
      const node = allNodesSnap[id]
      if (node) {
        const parent = node.parentId === 'root' ? null : allNodesSnap[node.parentId]
        const pivotX = parent ? parent.x : 0
        const pivotY = parent ? parent.y : 0

        const adx = finalX - pivotX
        const ady = finalY - pivotY
        const distance = Math.sqrt(adx * adx + ady * ady)
        const angle = Math.atan2(ady, adx)

        const SNAP_DIVISIONS = 60
        const snapIncrement = (2 * Math.PI) / SNAP_DIVISIONS
        const snapAngle = Math.round(angle / snapIncrement) * snapIncrement

        finalX = pivotX + distance * Math.cos(snapAngle)
        finalY = pivotY + distance * Math.sin(snapAngle)

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

  const handleRename = useCallback((id: NodeId, name: string) => {
    renameNode(id, name)
    sendRename(id, name)
  }, [renameNode])

  const handleColorChange = useCallback((id: NodeId, colorPresetId: string) => {
    setNodeColor(id, colorPresetId)
    sendSetColor(id, colorPresetId)
  }, [setNodeColor])

  /**
   * Settle resize mode on a size.
   *
   * The only place a terminal resize is sent from user action — one mutation
   * per gesture, at the end of it, because each one is a SIGWINCH the agent
   * redraws for. The undo entry records both sides, so undo and redo are the
   * same mutation with different numbers.
   */
  const commitResize = useCallback((id: NodeId, cols: number, rows: number) => {
    const node = useNodeStore.getState().nodes[id]
    if (!node || node.type !== 'terminal') return
    // Clicking without moving is a cancel, not a no-op resize with an undo
    // entry nobody can see the effect of.
    if (cols === node.cols && rows === node.rows) return
    const entry: UndoResizeEntry = {
      kind: 'resize',
      ts: Date.now(),
      description: nodeUndoDescription(node),
      nodeId: id,
      cols: node.cols,
      rows: node.rows,
      afterCols: cols,
      afterRows: rows
    }
    pushUndo(entry)
    sendUndoPush(entry)
    sendTerminalResize(id, cols, rows)
  }, [])

  const handleStartResize = useCallback((nodeId: NodeId) => {
    // Same shape as reparent: unfocus and pull the camera back, because the
    // whole point is to judge the new size against its surroundings. Unfocusing
    // also unmounts the xterm, so what stays on screen underneath the preview
    // is the snapshot at the current size — the reference to grow from.
    useResizeStore.getState().startResize(nodeId)
    handleUnfocus()
    flyToUnfocusZoom()
  }, [handleUnfocus, flyToUnfocusZoom])

  // Resize mode: the pointer drives the preview, a click settles it.
  //
  // Everything is bound on `window` in the capture phase so a click anywhere —
  // over a card, over empty canvas — settles rather than doing what it normally
  // would. Nothing reaches the server until that click.
  useEffect(() => {
    if (!resizingNodeId) return

    const viewport = document.querySelector('.canvas-viewport') as HTMLElement | null
    if (!viewport) return

    const centerOf = (): { x: number; y: number } | null => {
      const node = useNodeStore.getState().nodes[resizingNodeId]
      return node && node.type === 'terminal' ? { x: node.x, y: node.y } : null
    }

    const sizeAt = (e: MouseEvent): { cols: number; rows: number } | null => {
      const center = centerOf()
      if (!center) return null
      const cam = cameraRef.current
      const rect = viewport.getBoundingClientRect()
      return terminalSizeFromCorner(center, {
        x: (e.clientX - rect.left - cam.x) / cam.z,
        y: (e.clientY - rect.top - cam.y) / cam.z
      })
    }

    const onMouseMove = (e: MouseEvent) => {
      const size = sizeAt(e)
      if (size) useResizeStore.getState().setDraft(size)
    }

    const onMouseDown = (e: MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      // Any button other than the left one cancels — right-drag is zoom, and
      // committing a size because someone reached for the camera would be rude.
      if (e.button === 0) {
        const size = sizeAt(e) ?? useResizeStore.getState().draft
        if (size) commitResize(resizingNodeId, size.cols, size.rows)
      }
      useResizeStore.getState().reset()
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      useResizeStore.getState().reset()
    }

    window.addEventListener('mousemove', onMouseMove, { capture: true })
    window.addEventListener('mousedown', onMouseDown, { capture: true })
    window.addEventListener('keydown', onKeyDown, { capture: true })

    return () => {
      window.removeEventListener('mousemove', onMouseMove, { capture: true })
      window.removeEventListener('mousedown', onMouseDown, { capture: true })
      window.removeEventListener('keydown', onKeyDown, { capture: true })
    }
  }, [resizingNodeId, cameraRef, commitResize])

  // Leaving resize mode armed while its surface is being archived would settle
  // on a node that no longer exists.
  useEffect(() => {
    if (!resizingNodeId) return
    return useNodeStore.subscribe((state) => {
      if (!state.nodes[resizingNodeId]) useResizeStore.getState().reset()
    })
  }, [resizingNodeId])

  const handleResizeMarkdown = useCallback((id: NodeId, width: number, height: number) => {
    sendMarkdownResize(id, width, height)
  }, [])

  const handleMarkdownContent = useCallback((id: NodeId, content: string) => {
    sendMarkdownContent(id, content)
  }, [])

  const handleMaxWidthChange = useCallback((id: NodeId, maxWidth: number) => {
    sendMarkdownSetMaxWidth(id, maxWidth)
  }, [])

  const handleDirectoryCwdChange = useCallback((id: NodeId, newCwd: string) => {
    cwdMapRef.current.set(id, newCwd)
    sendDirectoryCwd(id, newCwd)
  }, [])

  const handleFilePathChange = useCallback((id: NodeId, newFilePath: string) => {
    sendFilePath(id, newFilePath)
  }, [])

  const handleTitleTextChange = useCallback((id: NodeId, text: string) => {
    sendTitleText(id, text)
  }, [])

  const spawnNode = useCallback(async (
    create: (parentId: NodeId, cwd: string | undefined) => Promise<NodeId>,
    parentIdOverride?: NodeId
  ) => {
    const anchor = focusRef.current ?? selectionRef.current
    if (!anchor) return
    const parentId = parentIdOverride ?? anchor
    const cwd = getParentCwd(parentId)
    const nodeId = await create(parentId, cwd)
    if (cwd) cwdMapRef.current.set(nodeId, cwd)
    await navigateToNode(nodeId)
  }, [getParentCwd, navigateToNode])

  const createChildNode = useCallback(async (parentNodeId: NodeId, type: AddNodeType, hint?: { x: number; y: number }): Promise<NodeId> => {
    const cwd = getParentCwd(parentNodeId)
    let nodeId: NodeId
    switch (type) {
      case 'claude': { const r = await sendTerminalCreate(parentNodeId, { cwd, claude: { appendSystemPrompt: false } }, undefined, undefined, hint?.x, hint?.y); nodeId = nodeIdFromFirstPtySession(r.sessionId); break }
      case 'cursor': { const r = await sendTerminalCreate(parentNodeId, { cwd, cursor: {} }, undefined, undefined, hint?.x, hint?.y); nodeId = nodeIdFromFirstPtySession(r.sessionId); break }
      case 'codex': { const r = await sendTerminalCreate(parentNodeId, { cwd, codex: {} }, undefined, undefined, hint?.x, hint?.y); nodeId = nodeIdFromFirstPtySession(r.sessionId); break }
      case 'terminal': {
        const parentNode = useNodeStore.getState().nodes[parentNodeId]
        const { initialInput, initialName: mdName, x, y } = getMarkdownSpawnInfo(parentNode)
        const r = await sendTerminalCreate(parentNodeId, cwd ? { cwd } : undefined, undefined, mdName, hint?.x ?? x, hint?.y ?? y, initialInput)
        nodeId = nodeIdFromFirstPtySession(r.sessionId)
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

  const handleAddNode = useCallback(async (parentNodeId: NodeId, type: AddNodeType) => {
    const nodeId = await createChildNode(parentNodeId, type)
    await navigateToNode(nodeId)
  }, [createChildNode, navigateToNode])

  const handlePostSync = useCallback(async (dirNodeId: NodeId) => {
    const node = useNodeStore.getState().nodes[dirNodeId]
    if (!node || node.type !== 'directory') return
    const cwd = node.cwd
    const termSize = terminalPixelSize(DEFAULT_COLS, DEFAULT_ROWS)
    const gap = 20
    const spawnX = node.x
    const spawnY = node.y + DIRECTORY_HEIGHT / 2 + gap + termSize.height / 2
    const result = await sendTerminalCreate(dirNodeId, cwd ? { cwd } : undefined, undefined, 'post-sync', spawnX, spawnY, 'pnpm post-sync')
    if (cwd) cwdMapRef.current.set(nodeIdFromFirstPtySession(result.sessionId), cwd)
    await navigateToNode(nodeIdFromFirstPtySession(result.sessionId))
  }, [navigateToNode])

  const handleWtSpawn = useCallback(async (dirNodeId: NodeId, branchName: string) => {
    const result = await sendDirectoryWtSpawn(dirNodeId, branchName)
    useNodeStore.getState().markFreshlyCreated(result.nodeId)
    await navigateToNode(result.nodeId)
  }, [navigateToNode])

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
      // Cmd+K: toggle search modal (before isEditable guard so it works from search input)
      if (e.metaKey && !e.shiftKey && e.key === 'k') {
        e.preventDefault()
        e.stopPropagation()
        setSearchMode({ kind: 'global' })
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

      // Cmd+P: start a spoken summary chat for the focused agent transcript.
      if (e.metaKey && e.key === 'p') {
        const focusedNode = focusRef.current ? useNodeStore.getState().nodes[focusRef.current] : undefined
        if (focusedNode?.type === 'terminal') {
          e.preventDefault()
          e.stopPropagation()
          playSummaryChatStartedCue()
          window.api.startSummaryChat(focusedNode.id)
          return
        }
        e.preventDefault()
        e.stopPropagation()
        shakeCamera()
        showToast('Focus an agent terminal to start Summary Chat.')
      }

      // Don't steal keys a focused text-editing control needs. See
      // lib/keyboard.ts for which keys those are and why xterm does not count
      // as one even though it focuses a hidden textarea.
      if (shouldYieldToFocusedEditor(document.activeElement, e)) return

      // Cmd+Option+0..9 saves the current viewport to a numbered slot (shared
      // across all clients); Cmd+0..9 restores it. See lib/keyboard.ts for why
      // this reads e.code and why save is Option rather than Shift.
      const viewportSlot = viewportSlotFor(e)
      if (viewportSlot) {
        const { slot } = viewportSlot
        const viewport = document.querySelector('.canvas-viewport') as HTMLElement | null
        const vw = viewport?.clientWidth ?? window.innerWidth
        const vh = viewport?.clientHeight ?? window.innerHeight

        if (viewportSlot.action === 'save') {
          // Save: store the current visible region as canvas-space bounds (window-independent)
          e.preventDefault()
          e.stopPropagation()
          const topLeft = screenToCanvas({ x: 0, y: 0 }, cameraRef.current)
          const bottomRight = screenToCanvas({ x: vw, y: vh }, cameraRef.current)
          sendSaveViewport(slot, {
            x: topLeft.x,
            y: topLeft.y,
            width: bottomRight.x - topLeft.x,
            height: bottomRight.y - topLeft.y,
          })
          showToast(`Saved viewport ${slot}`)
          return
        }

        // Restore: fit the saved region to this window, or jiggle if the slot is empty
        e.preventDefault()
        e.stopPropagation()
        const bounds = useSavedViewportStore.getState().viewports[slot]
        if (!bounds) {
          shakeCamera()
          showToast(`No viewport saved in slot ${slot}`)
          return
        }
        const target = cameraToFitBounds(bounds, vw, vh, 0)
        const sourceCenter = screenToCanvas({ x: vw / 2, y: vh / 2 }, cameraRef.current)
        const targetCenter = screenToCanvas({ x: vw / 2, y: vh / 2 }, target)
        const dist = Math.hypot(targetCenter.x - sourceCenter.x, targetCenter.y - sourceCenter.y)
        // A viewport restore isn't tied to a node — clear focus/scroll state
        focusRef.current = null
        setFocusedId(null)
        setScrollMode(false)
        inertiaBlock.activate()
        flyTo(target, computeFlyToSpeed(dist))
        return
      }

      // Cmd+Z: undo (only when not in a text field — the isEditable guard above returns early)
      if (e.metaKey && e.key === 'z' && !e.shiftKey) {
        e.preventDefault()
        e.stopPropagation()

        const confirmation = getConfirmation()

        if (confirmation) {
          if (confirmation.direction === 'undo') {
            // Second Cmd+Z within 5s — execute the confirmed undo
            clearConfirmation()
            undoStep()
            sendUndoSetCursor(getCursor())
            executeUndoRedo(confirmation.entry, 'undo')
          } else {
            // Pending redo confirmation — wrong direction, clear and fall through
            clearConfirmation()
          }
          return
        }

        const entry = peekUndo()
        if (!entry) {
          shakeCamera()
          return
        }

        if (undoNeedsConfirmation(entry)) {
          showToast(`Undo again: ${undoConfirmationVerb(entry, 'undo')} ${entry.description}`)
          setConfirmation(entry, 'undo')
        } else {
          undoStep()
          sendUndoSetCursor(getCursor())
          executeUndoRedo(entry, 'undo')
        }
        return
      }

      // Cmd+Shift+Z: redo
      if (e.metaKey && e.key === 'z' && e.shiftKey) {
        e.preventDefault()
        e.stopPropagation()

        const confirmation = getConfirmation()

        if (confirmation) {
          if (confirmation.direction === 'redo') {
            // Second Cmd+Shift+Z within 5s — execute the confirmed redo
            clearConfirmation()
            redoStep()
            sendUndoSetCursor(getCursor())
            executeUndoRedo(confirmation.entry, 'redo')
          } else {
            // Pending undo confirmation — wrong direction, clear and fall through
            clearConfirmation()
          }
          return
        }

        const entry = peekRedo()
        if (!entry) {
          shakeCamera()
          return
        }

        if (undoNeedsConfirmation(entry)) {
          showToast(`Redo again: ${undoConfirmationVerb(entry, 'redo')} ${entry.description}`)
          setConfirmation(entry, 'redo')
        } else {
          redoStep()
          sendUndoSetCursor(getCursor())
          executeUndoRedo(entry, 'redo')
        }
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
          return nodeIdFromFirstPtySession(r.sessionId)
        })
      }

      if (e.metaKey && e.key === 'e') {
        e.preventDefault()
        e.stopPropagation()
        spawnNode(async (parentId, cwd) => {
          const r = await sendTerminalCreate(parentId, { cwd, claude: { appendSystemPrompt: false } })
          return nodeIdFromFirstPtySession(r.sessionId)
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
          if (node?.type === 'terminal' && node.claudeSessionHistory && node.claudeSessionHistory.length > 0) {
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
        const best = highestPriorityClaudeCrab(crabsRef.current)
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
          const fromId = anchor
          lastCrabRef.current = { nodeId: next.nodeId, createdAt: next.createdAt }
          setCrabNavEvent({ fromNodeId: fromId, toNodeId: next.nodeId, ts: Date.now() })
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

  const handleNodeReady = useCallback((nodeId: NodeId, bounds: { x: number; y: number; width: number; height: number }) => {
    if (focusRef.current !== nodeId) return
    if (pinnedFocusRef.current) return
    const viewport = document.querySelector('.canvas-viewport') as HTMLElement | null
    if (!viewport) return
    const vw = viewport.clientWidth
    const vh = viewport.clientHeight

    if (useCameraLockStore.getState().locked) {
      const expanded = expandCameraToInclude(bounds, cameraRef.current, vw, vh, 0)
      if (expanded) flyTo(expanded)
    } else {
      flyTo(cameraToFitBounds(bounds, vw, vh, 0, focusZoomCeiling(useNodeStore.getState().nodes[nodeId]?.type)))
    }
  }, [flyTo, cameraRef])

  const handleCanvasWheel = useCallback((e: WheelEvent) => {
    // Search/help modals handle their own wheel events
    if ((e.target as HTMLElement).closest('.search-modal') || (e.target as HTMLElement).closest('.help-modal')) return
    setSearchVisible(false)
    setHelpVisible(false)
    setQuickActions(null)
    setEdgeSplit(null)
    // Block residual trackpad inertia after focus navigation
    if (!e.ctrlKey && !e.metaKey && inertiaBlock.check(e.deltaX, e.deltaY)) {
      e.preventDefault()
      return
    }
    if (focusRef.current && !pinnedFocusRef.current) {
      e.preventDefault()
      handleUnfocus()
      if (!useCameraLockStore.getState().locked) flyToUnfocusZoom()
    }
    handleWheel(e)
  }, [handleWheel, flyToUnfocusZoom, handleUnfocus, inertiaBlock])

  const handleCanvasPanStart = useCallback((e: MouseEvent) => {
    setSearchVisible(false)
    setHelpVisible(false)
    setQuickActions(null)
    setEdgeSplit(null)
    if (focusRef.current && !pinnedFocusRef.current) {
      handleUnfocus()
      if (!useCameraLockStore.getState().locked) flyToUnfocusZoom()
    }
    handlePanStart(e)
  }, [handlePanStart, flyToUnfocusZoom, handleUnfocus])

  // Right-button drag on the canvas background → zoom out. Logarithmic, like
  // cmd+scroll: radial distance from the drag-start point maps to a zoom
  // *ratio*, so equal drag distances produce equal zoom multiples regardless
  // of current zoom. Any direction zooms out; dragging back toward the start
  // point returns to the original zoom. Anchored at the drag-start point so
  // it stays fixed under the cursor. Owns its own move/up listeners like
  // handlePanStart.
  const handleZoomDragStart = useCallback((e: MouseEvent) => {
    const anchor = { x: e.clientX, y: e.clientY }
    const startZ = cameraRef.current.z

    const onMouseMove = (ev: MouseEvent) => {
      // Distance is always >= 0, so this only ever zooms out from startZ:
      // z = startZ * e^(-dist * sensitivity).
      const dragDist = Math.hypot(ev.clientX - anchor.x, ev.clientY - anchor.y)
      userZoom(anchor, startZ * Math.exp(-dragDist * ZOOM_DRAG_SENSITIVITY))
    }

    const onMouseUp = (ev: MouseEvent) => {
      if (ev.button !== 2) return
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }

    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
  }, [userZoom, cameraRef])

  const handleRtsSelectStart = useCallback((e: MouseEvent) => {
    setSearchVisible(false)
    setHelpVisible(false)
    setQuickActions(null)
    setEdgeSplit(null)
    if (focusRef.current && !pinnedFocusRef.current) {
      handleUnfocus()
    }
    startRtsSelect(e)
  }, [startRtsSelect, handleUnfocus])

  const handleCanvasUnfocus = useCallback((e: MouseEvent) => {
    setSearchVisible(false)
    setHelpVisible(false)
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
          if (bounds && !useCameraLockStore.getState().locked) {
            flyTo(cameraToFitBounds(bounds, viewport.clientWidth, viewport.clientHeight, 0.1, UNFOCUS_SNAP_ZOOM))
          }
        }
      }
      return
    }
    if (focusRef.current) {
      handleUnfocus()
      if (!useCameraLockStore.getState().locked) flyToUnfocusZoom()
    } else {
      setSelection(null)
      handleUnfocus()
      if (!useCameraLockStore.getState().locked) flyToUnfocusZoom()
    }
  }, [handleUnfocus, flyToUnfocusZoom, handleNodeFocus, hoveredEdgeRef, clearHoveredEdge])

  /**
   * The props every canvas card takes, built once per card.
   *
   * Four card blocks below used to spell out the same twenty-four props each,
   * so adding a card type meant copying a block and adding a type meant editing
   * five of them. The two that differ genuinely — a card's own content and the
   * callback that changes it — are still passed explicitly at each site, which
   * is the point: what is left visible at the call site is exactly what is
   * different.
   *
   * `tieredZIndex` is applied uniformly. Two of the old blocks called it and two
   * did not, which read as a real difference between card kinds; it is not —
   * the tier is zero for their types.
   */
  const cardProps = useCallback((node: NodeData) => ({
    id: node.id,
    x: node.x,
    y: node.y,
    zIndex: tieredZIndex(node.type, node.zIndex),
    zoom: camera.z,
    colorPresetId: node.colorPresetId,
    resolvedPreset: resolvedPresets[node.id],
    archivedChildren: node.archivedChildren,
    focused: focusedId === node.id,
    selected: selection === node.id,
    onFocus: handleNodeFocus,
    onClose: handleRemoveNode,
    onMove: handleMove,
    onColorChange: handleColorChange,
    onUnarchive: handleUnarchive,
    onArchiveDelete: handleArchiveDelete,
    onOpenArchiveSearch: handleOpenArchiveSearch,
    onNodeReady: handleNodeReady,
    onDragStart: handleDragStart,
    onDragEnd: handleDragEnd,
    onStartReparent: handleStartReparent,
    onReparentTarget: handleReparentTarget,
    onAddNode: handleAddNode,
    cameraRef,
  }), [
    camera.z, resolvedPresets, focusedId, selection,
    handleNodeFocus, handleRemoveNode, handleMove, handleColorChange,
    handleUnarchive, handleArchiveDelete, handleOpenArchiveSearch, handleNodeReady,
    handleDragStart, handleDragEnd, handleStartReparent, handleReparentTarget,
    handleAddNode, cameraRef,
  ])

  return (
    <div className="app">
      <Canvas camera={camera} surfaceRef={surfaceRef} onWheel={handleCanvasWheel} onPanStart={handleCanvasPanStart} onRtsSelectStart={handleRtsSelectStart} onZoomDragStart={handleZoomDragStart} onCanvasClick={handleCanvasUnfocus} onDoubleClick={fitAllNodes} background={<CanvasBackground camera={camera} cameraRef={cameraRef} edgesRef={edgesRef} maskRectsRef={maskRectsRef} selectionRef={selectionRef} reparentEdgeRef={reparentEdgeRef} />} overlay={<>{rtsSelectOverlay}<SearchModal visible={searchVisible} mode={searchMode} resolvedPresets={resolvedPresets} onDismiss={() => setSearchVisible(false)} onNavigateToNode={(id) => { setSearchVisible(false); handleNodeFocus(id) }} onReviveNode={handleReviveNode} onArchiveDelete={handleArchiveDelete} /><HelpModal visible={helpVisible} onDismiss={() => setHelpVisible(false)} /></>}>
        <PeerCameraOverlay />
        <ResizeGhost />
        <RootNode
          focused={focusedId === ROOT_NODE_ID}
          selected={selection === ROOT_NODE_ID}
          onClick={() => handleNodeFocus(ROOT_NODE_ID)}
          archivedChildren={rootArchivedChildren}
          onUnarchive={handleUnarchive}
          onArchiveDelete={handleArchiveDelete}
          onOpenArchiveSearch={handleOpenArchiveSearch}
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
            name={t.name ?? undefined}
            colorPresetId={t.colorPresetId}
            resolvedPreset={resolvedPresets[t.id]}
            shellTitleHistory={t.shellTitleHistory}
            cwd={t.cwd}
            focused={focusedId === t.id}
            selected={selection === t.id}
            anyNodeFocused={focusedId !== null}
            claudeStatusUnread={t.claudeStatusUnread}
            claudeStatusAsleep={t.claudeStatusAsleep}
            scrollMode={scrollMode}
            onFocus={handleNodeFocus}
            onUnfocus={handleUnfocus}
            onDisableScrollMode={handleDisableScrollMode}
            onForwardWheelToCanvas={handleCanvasWheel}
            onClose={handleRemoveNode}
            onMove={handleMove}
            onRename={handleRename}
            archivedChildren={t.archivedChildren}
            onColorChange={handleColorChange}
            onUnarchive={handleUnarchive}
            onArchiveDelete={handleArchiveDelete}
            onOpenArchiveSearch={handleOpenArchiveSearch}
            claudeSessionHistory={t.claudeSessionHistory}
            agentType={t.agentType}
            claudeState={t.claudeState}
            claudeModel={t.claudeModel}
            onNodeReady={handleNodeReady}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
            onStartReparent={handleStartReparent}
            onStartResize={handleStartResize}
            onReparentTarget={handleReparentTarget}
            terminalSessions={t.terminalSessions}
            onSessionRevive={handleSessionRevive}
            onFork={handleForkSession}
            onExtraCliArgs={handleExtraCliArgs}
            extraCliArgs={t.extraCliArgs}
            lastInteractedAt={t.lastInteractedAt}
            onHoverFocus={handleHoverFocus}
            onHoverUnfocus={handleHoverUnfocus}
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
              {...cardProps(m)}
              width={m.width}
              height={m.height}
              content={effectiveContent}
              maxWidth={m.maxWidth}
              name={m.name ?? undefined}
              onUnfocus={() => { handleUnfocus(); if (!useCameraLockStore.getState().locked) flyToUnfocusZoom() }}
              onResize={handleResizeMarkdown}
              onContentChange={handleMarkdownContent}
              onMaxWidthChange={handleMaxWidthChange}
              onRename={handleRename}
              onShipIt={parentNode?.type === 'terminal' ? handleShipIt : undefined}
              fileBacked={isFileBacked}
              fileError={fileError}
            />
          )
        })}
        {titles.map((t) => (
          <TitleCard
            key={t.id}
            {...cardProps(t)}
            text={t.text}
            onTextChange={handleTitleTextChange}
          />
        ))}
        {directories.map((d) => (
          <DirectoryCard
            key={d.id}
            {...cardProps(d)}
            cwd={d.cwd}
            gitStatus={d.gitStatus}
            onCwdChange={handleDirectoryCwdChange}
            onPostSync={handlePostSync}
            onWtSpawn={handleWtSpawn}
          />
        ))}
        {files.map((f) => (
          <FileCard
            key={f.id}
            {...cardProps(f)}
            filePath={f.filePath}
            inheritedCwd={getAncestorCwd(nodes, f.id, cwdMapRef.current)}
            onFilePathChange={handleFilePathChange}
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
        crabs={crabs}
        onCrabClick={handleCrabClick}
        onCrabReorder={handleCrabReorder}
        selectedNodeId={focusedId}
        crabNavEvent={crabNavEvent}
        zoom={camera.z}
        onHelpClick={() => setHelpVisible(v => !v)}
        keycastEnabled={keycastEnabled}
        onKeycastToggle={() => setKeycastEnabled(v => { const next = !v; localStorage.setItem('toolbar.keycast', String(next)); return next })}
        onDebugCapture={handleDebugCapture}
        onInertiaLogDump={handleInertiaLogDump}
        restartingSpaceterm={restartingSpaceterm}
        onRestartSpaceterm={handleRestartSpaceterm}
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
