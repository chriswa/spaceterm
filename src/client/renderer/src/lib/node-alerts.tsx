import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'

export interface NodeAlert {
  type: string
  message: string
}

interface NodeAlertsContextValue {
  alerts: NodeAlert[]
  register: (key: string, alerts: NodeAlert[]) => void
  unregister: (key: string) => void
}

const NodeAlertsContext = createContext<NodeAlertsContextValue | null>(null)

export function NodeAlertsProvider({ children }: { children: ReactNode }) {
  const [alertMap, setAlertMap] = useState<Map<string, NodeAlert[]>>(() => new Map())

  const register = useCallback((key: string, alerts: NodeAlert[]) => {
    setAlertMap(prev => {
      if (prev.get(key) === alerts) return prev
      const next = new Map(prev)
      if (alerts.length === 0) {
        next.delete(key)
      } else {
        next.set(key, alerts)
      }
      return next
    })
  }, [])

  const unregister = useCallback((key: string) => {
    setAlertMap(prev => {
      if (!prev.has(key)) return prev
      const next = new Map(prev)
      next.delete(key)
      return next
    })
  }, [])

  const alerts: NodeAlert[] = []
  for (const list of alertMap.values()) {
    for (const a of list) alerts.push(a)
  }

  return (
    <NodeAlertsContext.Provider value={{ alerts, register, unregister }}>
      {children}
    </NodeAlertsContext.Provider>
  )
}

export function useRegisterAlerts(key: string, alerts: NodeAlert[]): void {
  const ctx = useContext(NodeAlertsContext)
  const keyRef = useRef(key)
  keyRef.current = key

  useEffect(() => {
    ctx?.register(key, alerts)
  }, [ctx, key, alerts])

  useEffect(() => {
    return () => { ctx?.unregister(keyRef.current) }
  }, [ctx])
}

export function useNodeAlerts(): NodeAlert[] {
  const ctx = useContext(NodeAlertsContext)
  return ctx?.alerts ?? []
}
