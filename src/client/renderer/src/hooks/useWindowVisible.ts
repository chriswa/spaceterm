import { useEffect, useState } from 'react'

let _visible = true
const listeners = new Set<(visible: boolean) => void>()

// Subscribe once on module load
if (typeof window !== 'undefined' && window.api?.window?.onVisibilityChanged) {
  window.api.window.onVisibilityChanged((visible) => {
    _visible = visible
    for (const cb of listeners) cb(visible)
  })
}

/** Non-React getter for use inside RAF loops and callbacks */
export function isWindowVisible(): boolean {
  return _visible
}

/** React hook that re-renders when window visibility changes */
export function useWindowVisible(): boolean {
  const [visible, setVisible] = useState(_visible)

  useEffect(() => {
    const cb = (v: boolean) => setVisible(v)
    listeners.add(cb)
    // Sync in case it changed between render and effect
    setVisible(_visible)
    return () => { listeners.delete(cb) }
  }, [])

  return visible
}
