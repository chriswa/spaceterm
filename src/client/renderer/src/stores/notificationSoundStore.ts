import { create } from 'zustand'

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
