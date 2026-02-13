import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Canvas } from './components/Canvas'
import { TerminalCard } from './components/TerminalCard'
import { Toolbar } from './components/Toolbar'
import { useCamera } from './hooks/useCamera'
import { useTerminalManager } from './hooks/useTerminalManager'
import { screenToCanvas, cameraToFitBounds, unionBounds } from './lib/camera'
import { terminalPixelSize } from './lib/constants'
import { loadLayout, saveLayout } from './lib/layout-persistence'

const savedLayout = loadLayout()

export function App() {
  const savedTerminals = useMemo(() => {
    if (!savedLayout) return undefined
    const map: Record<string, { x: number; y: number; zIndex: number; name?: string; colorPresetId?: string }> = {}
    for (const t of savedLayout.terminals) {
      map[t.sessionId] = { x: t.x, y: t.y, zIndex: t.zIndex, name: t.name, colorPresetId: t.colorPresetId }
    }
    return map
  }, [])

  const { camera, handleWheel, resetCamera, animateTo, handlePanStart, inputDevice, toggleInputDevice } = useCamera(savedLayout?.camera)
  const cameraRef = useRef(camera)
  cameraRef.current = camera

  const { terminals, addTerminal, removeTerminal, moveTerminal, resizeTerminal, bringToFront, renameTerminal, setTerminalColor, setShellTitle, setShellTitleHistory, nextZIndex } =
    useTerminalManager({
      savedTerminals,
      initialNextZIndex: savedLayout?.nextZIndex
    })

  // CWD tracking — ref so updates don't trigger re-renders
  const cwdMapRef = useRef(new Map<string, string>())
  const [focusedId, setFocusedId] = useState<string | null>(null)
  const [scrollMode, setScrollMode] = useState(false)
  const focusRef = useRef(focusedId)
  focusRef.current = focusedId
  const terminalsRef = useRef(terminals)
  terminalsRef.current = terminals

  const handleCwdChange = useCallback((sessionId: string, cwd: string) => {
    cwdMapRef.current.set(sessionId, cwd)
  }, [])

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

  const centerPosition = useCallback(() => {
    const cam = cameraRef.current
    const viewportCenter = { x: window.innerWidth / 2, y: window.innerHeight / 2 }
    const canvasCenter = screenToCanvas(viewportCenter, cam)
    const { width, height } = terminalPixelSize(80, 24)
    return { x: canvasCenter.x - width / 2, y: canvasCenter.y - height / 2 }
  }, [])

  const focusedCwd = useCallback(() => {
    const id = focusRef.current
    return id ? cwdMapRef.current.get(id) : undefined
  }, [])

  const addTerminalAtCenter = useCallback(() => {
    const cwd = focusedCwd()
    addTerminal(centerPosition(), cwd ? { cwd } : undefined)
  }, [addTerminal, centerPosition, focusedCwd])

  const addClaudeCodeAtCenter = useCallback(() => {
    const cwd = focusedCwd()
    addTerminal(centerPosition(), {
      cwd,
      command: 'claude',
      args: ['--plugin-dir', 'src/claude-code-plugin', '--', 'hello']
    })
  }, [addTerminal, centerPosition, focusedCwd])

  const fitAllTerminals = useCallback(() => {
    const terms = terminalsRef.current
    const rects = terms.map((t) => {
      const { width, height } = terminalPixelSize(t.cols, t.rows)
      return { x: t.x, y: t.y, width, height }
    })
    const bounds = unionBounds(rects)
    if (!bounds) return
    const viewport = document.querySelector('.canvas-viewport') as HTMLElement | null
    if (!viewport) return
    const target = cameraToFitBounds(bounds, viewport.clientWidth, viewport.clientHeight, 0.05)
    animateTo(target)
  }, [animateTo])

  // Global keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey && e.key === 't') {
        e.preventDefault()
        e.stopPropagation()
        addTerminalAtCenter()
      }

      if (e.metaKey && e.key === 'e') {
        e.preventDefault()
        e.stopPropagation()
        addClaudeCodeAtCenter()
      }

      if (e.key === 'CapsLock') {
        if (focusRef.current) {
          setFocusedId(null)
          setScrollMode(false)
        } else {
          fitAllTerminals()
        }
      }
    }
    window.addEventListener('keydown', handleKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true })
  }, [addTerminalAtCenter, addClaudeCodeAtCenter, fitAllTerminals])

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
          colorPresetId: t.colorPresetId
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
      0.05
    )
    animateTo(target)
  }, [bringToFront, animateTo])

  const handleUnfocus = useCallback(() => {
    setFocusedId(null)
    setScrollMode(false)
  }, [])

  const handleDisableScrollMode = useCallback(() => {
    setScrollMode(false)
  }, [])

  return (
    <div className="app">
      <Toolbar
        zoom={camera.z}
        cameraX={camera.x}
        cameraY={camera.y}
        inputDevice={inputDevice}
        onAddTerminal={addTerminalAtCenter}
        onResetView={resetCamera}
        onFitAll={fitAllTerminals}
        onToggleInputDevice={toggleInputDevice}
      />
      <Canvas camera={camera} onWheel={handleWheel} onPanStart={handlePanStart} onCanvasClick={handleUnfocus}>
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
