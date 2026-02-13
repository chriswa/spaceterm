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
    const map: Record<string, { x: number; y: number; zIndex: number; name?: string; headerColor?: string }> = {}
    for (const t of savedLayout.terminals) {
      map[t.sessionId] = { x: t.x, y: t.y, zIndex: t.zIndex, name: t.name, headerColor: t.headerColor }
    }
    return map
  }, [])

  const { camera, handleWheel, resetCamera, animateTo, handlePanStart, inputDevice } = useCamera(savedLayout?.camera)
  const cameraRef = useRef(camera)
  cameraRef.current = camera

  const { terminals, addTerminal, removeTerminal, moveTerminal, resizeTerminal, bringToFront, renameTerminal, setTerminalColor, nextZIndex } =
    useTerminalManager({
      savedTerminals,
      initialNextZIndex: savedLayout?.nextZIndex
    })
  const [focus, setFocus] = useState<FocusState | null>(null)
  const focusRef = useRef(focus)
  focusRef.current = focus
  const terminalsRef = useRef(terminals)
  terminalsRef.current = terminals

  const addTerminalAtCenter = useCallback(() => {
    const cam = cameraRef.current
    const viewportCenter = {
      x: window.innerWidth / 2,
      y: window.innerHeight / 2
    }
    const canvasCenter = screenToCanvas(viewportCenter, cam)
    const { width, height } = terminalPixelSize(80, 24)
    addTerminal({
      x: canvasCenter.x - width / 2,
      y: canvasCenter.y - height / 2
    })
  }, [addTerminal])

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
          const terms = terminalsRef.current
          const rects = terms.map((t) => {
            const { width, height } = terminalPixelSize(t.cols, t.rows)
            return { x: t.x, y: t.y, width, height }
          })
          const bounds = unionBounds(rects)
          if (!bounds) return
          const viewport = document.querySelector('.canvas-viewport') as HTMLElement | null
          if (!viewport) return
          const target = cameraToFitBounds(bounds, viewport.clientWidth, viewport.clientHeight, 0.1)
          animateTo(target)
        }
      }
    }
    window.addEventListener('keydown', handleKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true })
  }, [addTerminalAtCenter, animateTo])

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
          headerColor: t.headerColor
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

    // Animate camera to center and zoom on the focused terminal
    const card = document.querySelector(`[data-session-id="${sessionId}"]`) as HTMLElement | null
    const viewport = document.querySelector('.canvas-viewport') as HTMLElement | null
    if (!card || !viewport) return

    const target = cameraToFitBounds(
      { x: card.offsetLeft, y: card.offsetTop, width: card.offsetWidth, height: card.offsetHeight },
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
        inputDevice={inputDevice}
        onAddTerminal={addTerminalAtCenter}
        onResetView={resetCamera}
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
            headerColor={t.headerColor}
            focusMode={getFocusMode(t.sessionId)}
            onSoftFocus={handleSoftFocus}
            onHardFocus={handleHardFocus}
            onUnfocus={handleUnfocus}
            onClose={removeTerminal}
            onMove={moveTerminal}
            onResize={resizeTerminal}
            onRename={renameTerminal}
            onColorChange={setTerminalColor}
          />
        ))}
      </Canvas>
    </div>
  )
}
