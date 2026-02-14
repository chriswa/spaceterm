import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Canvas } from './components/Canvas'
import { RootNode } from './components/RootNode'
import { TerminalCard } from './components/TerminalCard'
import { TreeLines } from './components/TreeLines'
import { Toolbar } from './components/Toolbar'
import { useCamera } from './hooks/useCamera'
import { useTerminalManager } from './hooks/useTerminalManager'
import { cameraToFitBounds, unionBounds } from './lib/camera'
import { terminalPixelSize, CHILD_PLACEMENT_DISTANCE, ROOT_NODE_RADIUS, UNFOCUSED_MAX_ZOOM } from './lib/constants'
import { loadLayout, saveLayout } from './lib/layout-persistence'
import { computeChildPlacement, nodeCenter } from './lib/tree-placement'

const savedLayout = loadLayout()

function buildClaudeCodeOptions({ prompt, cwd }: { prompt?: string; cwd?: string } = {}): CreateOptions {
  const args = ['--plugin-dir', 'src/claude-code-plugin']
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

  const [focusedId, setFocusedId] = useState<string | null>(null)
  const [scrollMode, setScrollMode] = useState(false)
  const focusRef = useRef<string | null>(focusedId)
  focusRef.current = focusedId

  const { camera, handleWheel, handlePanStart, resetCamera, flyTo, flyToUnfocusZoom, inputDevice, toggleInputDevice } = useCamera(savedLayout?.camera, focusRef)
  const cameraRef = useRef(camera)
  cameraRef.current = camera

  const { terminals, addTerminal, removeTerminal, moveTerminal, resizeTerminal, bringToFront, renameTerminal, setTerminalColor, setShellTitle, setShellTitleHistory, setCwd, nextZIndex } =
    useTerminalManager({
      savedTerminals,
      initialNextZIndex: savedLayout?.nextZIndex
    })

  // CWD tracking — ref so updates don't trigger re-renders
  const cwdMapRef = useRef(new Map<string, string>())
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

  const handleRemoveTerminal = useCallback(async (sessionId: string) => {
    cwdMapRef.current.delete(sessionId)
    await removeTerminal(sessionId)
  }, [removeTerminal])

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
      if (!parent) return { position: { x: 0, y: 0 }, cwd: undefined }
      const ps = terminalPixelSize(parent.cols, parent.rows)
      parentCenter = nodeCenter(parent.x, parent.y, ps.width, ps.height)
      cwd = cwdMapRef.current.get(parentId)

      // Grandparent center
      if (parent.parentId === 'root') {
        grandparentCenter = { x: 0, y: 0 }
      } else {
        const gp = terms.find((t) => t.sessionId === parent.parentId)
        if (gp) {
          const gs = terminalPixelSize(gp.cols, gp.rows)
          grandparentCenter = nodeCenter(gp.x, gp.y, gs.width, gs.height)
        }
      }
    }

    // Sibling centers
    const siblings = terms.filter((t) => t.parentId === parentId)
    const siblingCenters = siblings.map((s) => {
      const ss = terminalPixelSize(s.cols, s.rows)
      return nodeCenter(s.x, s.y, ss.width, ss.height)
    })

    const center = computeChildPlacement(parentCenter, grandparentCenter, siblingCenters, CHILD_PLACEMENT_DISTANCE)
    const { width, height } = terminalPixelSize(80, 24)
    return {
      position: { x: center.x - width / 2, y: center.y - height / 2 },
      cwd
    }
  }, [])

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
    const rects = terms.map((t) => {
      const { width, height } = terminalPixelSize(t.cols, t.rows)
      return { x: t.x, y: t.y, width, height }
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

  const focusNewTerminal = useCallback((sessionId: string, position: { x: number; y: number }, cols: number, rows: number) => {
    setFocusedId(sessionId)
    setScrollMode(true)
    bringToFront(sessionId)

    const { width, height } = terminalPixelSize(cols, rows)
    const viewport = document.querySelector('.canvas-viewport') as HTMLElement | null
    if (!viewport) return

    const target = cameraToFitBounds(
      { x: position.x, y: position.y, width, height },
      viewport.clientWidth, viewport.clientHeight,
      0.025
    )
    flyTo(target)
  }, [bringToFront, flyTo])

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
        focusNewTerminal(result.sessionId, position, result.cols, result.rows)
      }

      if (e.metaKey && e.key === 'e') {
        e.preventDefault()
        e.stopPropagation()
        if (!focusRef.current) return
        const { position, cwd } = computeChildPosition(focusRef.current)
        const result = await addTerminal(position, focusRef.current, buildClaudeCodeOptions({ cwd }))
        if (cwd) handleCwdChange(result.sessionId, cwd)
        focusNewTerminal(result.sessionId, position, result.cols, result.rows)
      }

    }
    window.addEventListener('keydown', handleKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true })
  }, [addTerminal, computeChildPosition, focusNewTerminal, handleCwdChange])

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
        nextZIndex: nextZIndex.current
      })
    }, 500)
    return () => clearTimeout(timeout)
  }, [camera, terminals])

  const handleFocus = useCallback((sessionId: string) => {
    setFocusedId(sessionId)
    setScrollMode(true)
    bringToFront(sessionId)

    const t = terminalsRef.current.find(t => t.sessionId === sessionId)
    const viewport = document.querySelector('.canvas-viewport') as HTMLElement | null
    if (!t || !viewport) return

    const { width, height } = terminalPixelSize(t.cols, t.rows)

    // Log both React state and DOM measurements for debugging
    const card = document.querySelector(`[data-session-id="${sessionId}"]`) as HTMLElement | null
    if (card) {
      console.log(`[HardFocus] session=${sessionId.slice(0,8)} react={x:${t.x},y:${t.y},w:${width},h:${height}} dom={x:${card.offsetLeft},y:${card.offsetTop},w:${card.offsetWidth},h:${card.offsetHeight}}`)
    }

    const target = cameraToFitBounds(
      { x: t.x, y: t.y, width, height },
      viewport.clientWidth, viewport.clientHeight,
      0.025
    )
    flyTo(target)
  }, [bringToFront, flyTo])

  const handleFocusRoot = useCallback(() => {
    setFocusedId('root')
    setScrollMode(false)
    const viewport = document.querySelector('.canvas-viewport') as HTMLElement | null
    if (!viewport) return
    const target = cameraToFitBounds(
      { x: -200, y: -200, width: 400, height: 400 },
      viewport.clientWidth, viewport.clientHeight,
      0.05
    )
    flyTo(target)
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
        <TreeLines terminals={terminals} />
        <RootNode focused={focusedId === 'root'} onClick={handleFocusRoot} />
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
            onFocus={handleFocus}
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
          />
        ))}
      </Canvas>
    </div>
  )
}
