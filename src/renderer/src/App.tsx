import { useCallback, useState } from 'react'
import { Canvas } from './components/Canvas'
import { TerminalCard } from './components/TerminalCard'
import { Toolbar } from './components/Toolbar'
import { useCamera } from './hooks/useCamera'
import { useTerminalManager } from './hooks/useTerminalManager'

type FocusMode = 'soft' | 'hard'

interface FocusState {
  id: string
  mode: FocusMode
}

export function App() {
  const { camera, handleWheel, resetCamera } = useCamera()
  const { terminals, addTerminal, removeTerminal, moveTerminal } = useTerminalManager()
  const [focus, setFocus] = useState<FocusState | null>(null)

  const handleSoftFocus = useCallback((sessionId: string) => {
    setFocus((prev) => {
      if (prev && prev.id === sessionId && prev.mode === 'hard') return prev
      return { id: sessionId, mode: 'soft' }
    })
  }, [])

  const handleHardFocus = useCallback((sessionId: string) => {
    setFocus({ id: sessionId, mode: 'hard' })
  }, [])

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
        onAddTerminal={addTerminal}
        onResetView={resetCamera}
      />
      <Canvas camera={camera} onWheel={handleWheel}>
        {terminals.map((t) => (
          <TerminalCard
            key={t.sessionId}
            sessionId={t.sessionId}
            x={t.x}
            y={t.y}
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
