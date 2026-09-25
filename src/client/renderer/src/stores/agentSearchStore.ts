import { create } from 'zustand'
import type { AgentSearchResponse } from '../../../../shared/api'

/** The last search, kept across restarts so reopening the modal shows it again. */
const LAST_SEARCH_KEY = 'agentSearch.last'

export type AgentSearchSuccess = Extract<AgentSearchResponse, { ok: true }>

export type AgentSearchStatus =
  | { kind: 'idle' }
  | { kind: 'searching' }
  | { kind: 'done'; result: AgentSearchSuccess }
  | { kind: 'error'; error: string }

interface AgentSearchState {
  query: string
  setQuery: (query: string) => void
  status: AgentSearchStatus
  /** Fire a search for the current query. A newer search supersedes one in flight. */
  search: () => Promise<void>
}

interface SavedSearch {
  query: string
  result: AgentSearchSuccess
}

function loadSaved(): SavedSearch | null {
  try {
    const raw = localStorage.getItem(LAST_SEARCH_KEY)
    if (!raw) return null
    const saved = JSON.parse(raw) as SavedSearch
    return typeof saved.query === 'string' && saved.result?.ok === true ? saved : null
  } catch {
    return null
  }
}

function save(saved: SavedSearch): void {
  try { localStorage.setItem(LAST_SEARCH_KEY, JSON.stringify(saved)) } catch { /* best effort */ }
}

let latestSearch = 0

const saved = loadSaved()

export const useAgentSearchStore = create<AgentSearchState>((set, get) => ({
  query: saved?.query ?? '',
  setQuery: (query) => set({ query }),
  status: saved ? { kind: 'done', result: saved.result } : { kind: 'idle' },
  search: async () => {
    const query = get().query.trim()
    if (!query) return
    const id = ++latestSearch
    set({ status: { kind: 'searching' } })
    let response: AgentSearchResponse
    try {
      response = await window.api.node.agentSearch(query)
    } catch (err) {
      response = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    if (id !== latestSearch) return
    if (response.ok) {
      save({ query, result: response })
      set({ status: { kind: 'done', result: response } })
    } else {
      set({ status: { kind: 'error', error: response.error } })
    }
  },
}))
