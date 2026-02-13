import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Canvas } from './components/Canvas'
import { TerminalCard } from './components/TerminalCard'
import { Toolbar } from './components/Toolbar'
import { useCamera } from './hooks/useCamera'
import { useTerminalManager } from './hooks/useTerminalManager'
import { screenToCanvas, cameraToFitBounds, unionBounds } from './lib/camera'
import { terminalPixelSize } from './lib/constants'
import { loadLayout, saveLayout } from './lib/layout-persistence'

type FocusMode = 'soft' | 'hard'

interface FocusState {
  id: string
  mode: FocusMode
}

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

  const { terminals, addTerminal, removeTerminal, moveTerminal, resizeTerminal, bringToFront, renameTerminal, setTerminalColor, setShellTitle, nextZIndex } =
    useTerminalManager({
      savedTerminals,
      initialNextZIndex: savedLayout?.nextZIndex
    })

  // CWD tracking — ref so updates don't trigger re-renders
  const cwdMapRef = useRef(new Map<string, string>())
  const [focus, setFocus] = useState<FocusState | null>(null)
  const focusRef = useRef(focus)
  focusRef.current = focus
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

  const handleRemoveTerminal = useCallback(async (sessionId: string) => {
    cwdMapRef.current.delete(sessionId)
    await removeTerminal(sessionId)
  }, [removeTerminal])

  const addTerminalAtCenter = useCallback(() => {
    const cam = cameraRef.current
    const viewportCenter = {
      x: window.innerWidth / 2,
      y: window.innerHeight / 2
    }
    const canvasCenter = screenToCanvas(viewportCenter, cam)
    const { width, height } = terminalPixelSize(80, 24)

    // Inherit CWD from the focused terminal (if any)
    const focusedId = focusRef.current?.id
    const cwd = focusedId ? cwdMapRef.current.get(focusedId) : undefined
    const options = cwd ? { cwd } : undefined

    addTerminal({
      x: canvasCenter.x - width / 2,
      y: canvasCenter.y - height / 2
    }, options)
  }, [addTerminal])

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

      if (e.key === 'CapsLock') {
        if (focusRef.current?.mode === 'hard') {
          setFocus(null)
        } else {
          fitAllTerminals()
        }
      }
    }
    window.addEventListener('keydown', handleKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true })
  }, [addTerminalAtCenter, fitAllTerminals])

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

  const handleSoftFocus = useCallback((sessionId: string) => {
    setFocus((prev) => {
      if (prev && prev.id === sessionId && prev.mode === 'hard') return prev
      return { id: sessionId, mode: 'soft' }
    })
  }, [])

  const handleHardFocus = useCallback((sessionId: string) => {
    setFocus({ id: sessionId, mode: 'hard' })
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
    setFocus(null)
  }, [])

  const getFocusMode = (sessionId: string): 'none' | 'soft' | 'hard' => {
    if (!focus || focus.id !== sessionId) return 'none'
    return focus.mode
  }

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
            focusMode={getFocusMode(t.sessionId)}
            onSoftFocus={handleSoftFocus}
            onHardFocus={handleHardFocus}
            onUnfocus={handleUnfocus}
            onClose={handleRemoveTerminal}
            onMove={moveTerminal}
            onResize={resizeTerminal}
            onRename={renameTerminal}
            onColorChange={setTerminalColor}
            onCwdChange={handleCwdChange}
            onShellTitleChange={handleShellTitleChange}
          />
        ))}
      </Canvas>
    </div>
  )
}
