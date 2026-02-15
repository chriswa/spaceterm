import { create } from 'zustand'

interface ShaderState {
  shadersEnabled: boolean
  toggle: () => void
}

export const useShaderStore = create<ShaderState>((set) => ({
  shadersEnabled: true,
  toggle: () => set((s) => ({ shadersEnabled: !s.shadersEnabled })),
}))
