import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Canvas } from './components/Canvas'
import { TerminalCard } from './components/TerminalCard'
import { Toolbar } from './components/Toolbar'
import { useCamera } from './hooks/useCamera'
import { useTerminalManager } from './hooks/useTerminalManager'
import { screenToCanvas } from './lib/camera'
import { TERMINAL_WIDTH, TERMINAL_HEIGHT } from './lib/constants'
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
    const map: Record<string, { x: number; y: number; zIndex: number }> = {}
    for (const t of savedLayout.terminals) {
      map[t.sessionId] = { x: t.x, y: t.y, zIndex: t.zIndex }
    }
    return map
  }, [])

  const { camera, handleWheel, resetCamera } = useCamera(savedLayout?.camera)
  const cameraRef = useRef(camera)
  cameraRef.current = camera

  const { terminals, addTerminal, removeTerminal, moveTerminal, bringToFront, nextZIndex } =
    useTerminalManager({
      savedTerminals,
      initialNextZIndex: savedLayout?.nextZIndex
    })
  const [focus, setFocus] = useState<FocusState | null>(null)

  const addTerminalAtCenter = useCallback(() => {
    const cam = cameraRef.current
    const viewportCenter = {
      x: window.innerWidth / 2,
      y: window.innerHeight / 2
    }
    const canvasCenter = screenToCanvas(viewportCenter, cam)
    addTerminal({
      x: canvasCenter.x - TERMINAL_WIDTH / 2,
      y: canvasCenter.y - TERMINAL_HEIGHT / 2
    })
  }, [addTerminal])

  // Global Cmd+T shortcut to create a new terminal
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey && e.key === 't') {
        e.preventDefault()
        e.stopPropagation()
        addTerminalAtCenter()
      }
    }
    window.addEventListener('keydown', handleKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true })
  }, [addTerminalAtCenter])

  // Debounced save of layout state
  useEffect(() => {
    const timeout = setTimeout(() => {
      saveLayout({
        camera,
        terminals: terminals.map((t) => ({
          sessionId: t.sessionId,
          x: t.x,
          y: t.y,
          zIndex: t.zIndex
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
  }, [bringToFront])

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
        onAddTerminal={addTerminalAtCenter}
        onResetView={resetCamera}
      />
      <Canvas camera={camera} onWheel={handleWheel}>
        {terminals.map((t) => (
          <TerminalCard
            key={t.sessionId}
            sessionId={t.sessionId}
            x={t.x}
            y={t.y}
            zIndex={t.zIndex}
            zoom={camera.z}
            focusMode={getFocusMode(t.sessionId)}
            onSoftFocus={handleSoftFocus}
            onHardFocus={handleHardFocus}
            onUnfocus={handleUnfocus}
            onClose={removeTerminal}
            onMove={moveTerminal}
          />
        ))}
      </Canvas>
    </div>
  )
}
