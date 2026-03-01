import { create } from 'zustand'

interface CameraLockState {
  locked: boolean
  toggle: () => void
}

export const useCameraLockStore = create<CameraLockState>((set, get) => ({
  locked: localStorage.getItem('toolbar.cameraLock') === 'true',
  toggle: () => {
    const next = !get().locked
    localStorage.setItem('toolbar.cameraLock', String(next))
    set({ locked: next })
  }
}))
