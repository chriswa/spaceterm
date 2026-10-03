import { create } from 'zustand'
import type { NodeId } from '../../../../shared/ids'

interface AgentNamesState {
  /** nodeId -> the receptionist's name for that agent surface ("Kevin"). */
  names: Readonly<Record<string, string>>
  /** Replace the whole map; the server always sends it whole. */
  setAll: (names: Record<string, string>) => void
}

/** The names the receptionist gives agent surfaces, as the server last sent them. */
export const useAgentNamesStore = create<AgentNamesState>((set) => ({
  names: {},
  setAll: (names) => set({ names }),
}))

/** One surface's name, or undefined while it has none. */
export function useAgentName(nodeId: NodeId): string | undefined {
  return useAgentNamesStore((s) => s.names[nodeId])
}
