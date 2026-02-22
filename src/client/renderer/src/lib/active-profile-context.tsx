import { createContext, useCallback, useContext, useState } from 'react'
import type { ReactNode } from 'react'

interface ActiveProfileContextValue {
  activeProfile: string | null
  setActiveProfile: (profile: string | null) => void
}

const ActiveProfileContext = createContext<ActiveProfileContextValue>({
  activeProfile: null,
  setActiveProfile: () => {},
})

export function ActiveProfileProvider({ children }: { children: ReactNode }) {
  const [activeProfile, setActiveProfileState] = useState<string | null>(null)

  const setActiveProfile = useCallback((profile: string | null) => {
    setActiveProfileState(profile)
  }, [])

  return (
    <ActiveProfileContext.Provider value={{ activeProfile, setActiveProfile }}>
      {children}
    </ActiveProfileContext.Provider>
  )
}

export function useActiveProfile() {
  return useContext(ActiveProfileContext)
}
