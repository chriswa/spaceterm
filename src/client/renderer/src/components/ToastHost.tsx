import { useCallback, useEffect, useRef, useState } from 'react'
import { Toast } from './Toast'
import { onToast, showToast } from '../lib/toast'

/**
 * Shows `showToast` messages and the server's errors. App draws it on the
 * desktop; the phone draws it itself (`MobileApp`), because its canvas — App —
 * is not always mounted, and a toast has nowhere to go without a host.
 */
export function ToastHost() {
  const [toasts, setToasts] = useState<Array<{ id: number; message: string; createdAt: number }>>([])
  const toastIdRef = useRef(0)

  const expireToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])

  useEffect(() => {
    return onToast((message) => {
      const id = ++toastIdRef.current
      setToasts((prev) => [...prev, { id, message, createdAt: Date.now() }])
    })
  }, [])

  useEffect(() => {
    return window.api.node.onServerError((message: string) => {
      console.error('[server]', message)
      showToast(message)
    })
  }, [])

  return <Toast toasts={toasts} onExpire={expireToast} />
}
