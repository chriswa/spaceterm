import { create } from 'zustand'

export interface CameraBounds {
  x: number
  y: number
  width: number
  height: number
}

interface PeerState {
  peers: Record<string, { bounds: CameraBounds | null }>
  addPeer: (clientId: string) => void
  removePeer: (clientId: string) => void
  updateBounds: (clientId: string, bounds: CameraBounds) => void
}

export const usePeerStore = create<PeerState>((set) => ({
  peers: {},
  addPeer: (clientId) =>
    set((state) => ({
      peers: { ...state.peers, [clientId]: { bounds: null } }
    })),
  removePeer: (clientId) =>
    set((state) => {
      const { [clientId]: _, ...rest } = state.peers
      return { peers: rest }
    }),
  updateBounds: (clientId, bounds) =>
    set((state) => ({
      peers: { ...state.peers, [clientId]: { bounds } }
    })),
}))
