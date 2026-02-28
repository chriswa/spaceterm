import { create } from 'zustand'

interface RtsSelectStoreState {
  /** True while the user is actively dragging an RTS selection rectangle */
  active: boolean
  start(): void
  finish(): void
  cancel(): void
}

export const useRtsSelectStore = create<RtsSelectStoreState>((set) => ({
  active: false,
  start: () => set({ active: true }),
  finish: () => set({ active: false }),
  cancel: () => set({ active: false }),
}))
