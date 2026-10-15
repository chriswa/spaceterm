import { create } from 'zustand'
import { useReceptionistStore } from './receptionistStore'

interface NotificationSoundState {
  enabled: boolean
  toggle: () => void
}

export const useNotificationSoundStore = create<NotificationSoundState>((set, get) => ({
  enabled: localStorage.getItem('toolbar.notificationSound') === 'true',
  toggle: () => {
    const next = !get().enabled
    localStorage.setItem('toolbar.notificationSound', String(next))
    set({ enabled: next })
  }
}))

/**
 * The bell rings only where the operator is: on the device holding Control.
 * Enabled elsewhere it is `held`, kept on but silent, so a Mac left behind
 * stays quiet while the operator works from the phone, and rings again once
 * Control comes back to it.
 */
export type BellMode = 'off' | 'rings' | 'held'

export function bellMode(enabled: boolean, controlHere: boolean): BellMode {
  if (!enabled) return 'off'
  return controlHere ? 'rings' : 'held'
}

export function useBellMode(): BellMode {
  const enabled = useNotificationSoundStore((s) => s.enabled)
  const controlHere = useReceptionistStore((s) => s.holder?.mine === true)
  return bellMode(enabled, controlHere)
}

/** Whether a surface needing attention should sound the bell on this device now. */
export function bellRingsNow(): boolean {
  return bellMode(useNotificationSoundStore.getState().enabled, useReceptionistStore.getState().holder?.mine === true) === 'rings'
}
