import { create } from 'zustand'
import type { AgentSearchResponse } from '../../../../shared/api'
import type { AgentSearchMode } from '../../../../shared/protocol'

/** The last search, kept across restarts so reopening the modal shows it again. */
const LAST_SEARCH_KEY = 'agentSearch.last'

export type AgentSearchSuccess = Extract<AgentSearchResponse, { ok: true }>

/** A finished search, with the query it answered (the input may have moved on). */
interface CompletedSearch {
  query: string
  result: AgentSearchSuccess
}

export type AgentSearchStatus =
  | { kind: 'idle' }
  | { kind: 'searching'; mode: AgentSearchMode }
  | ({ kind: 'done' } & CompletedSearch)
  | { kind: 'error'; error: string }

interface AgentSearchState {
  query: string
  setQuery: (query: string) => void
  status: AgentSearchStatus
  /** Fire a search for the current query. A newer search supersedes one in flight. */
  search: () => Promise<void>
  /**
   * Re-ask the shown search with transcripts, after it stopped at titles. The
   * cost shown becomes both passes'.
   */
  searchTranscripts: () => Promise<void>
}

function loadSaved(): CompletedSearch | null {
  try {
    const raw = localStorage.getItem(LAST_SEARCH_KEY)
    if (!raw) return null
    const saved = JSON.parse(raw) as CompletedSearch
    return typeof saved.query === 'string' && saved.result?.ok === true ? saved : null
  } catch {
    return null
  }
}

function save(saved: CompletedSearch): void {
  try { localStorage.setItem(LAST_SEARCH_KEY, JSON.stringify(saved)) } catch { /* best effort */ }
}

function addCost(a: number | null, b: number | null): number | null {
  return a === null || b === null ? null : a + b
}

let latestSearch = 0

const saved = loadSaved()

export const useAgentSearchStore = create<AgentSearchState>((set, get) => {
  /** Ask the server, then fold the answer into state via `complete` unless superseded. */
  async function run(
    query: string,
    mode: AgentSearchMode,
    complete: (result: AgentSearchSuccess) => AgentSearchSuccess,
  ): Promise<void> {
    const id = ++latestSearch
    set({ status: { kind: 'searching', mode } })
    let response: AgentSearchResponse
    try {
      response = await window.api.node.agentSearch(query, mode)
    } catch (err) {
      response = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    if (id !== latestSearch) return
    if (response.ok) {
      const done = { query, result: complete(response) }
      save(done)
      set({ status: { kind: 'done', ...done } })
    } else {
      set({ status: { kind: 'error', error: response.error } })
    }
  }

  return {
    query: saved?.query ?? '',
    setQuery: (query) => set({ query }),
    status: saved ? { kind: 'done', ...saved } : { kind: 'idle' },
    search: async () => {
      const query = get().query.trim()
      if (query) await run(query, 'auto', (result) => result)
    },
    searchTranscripts: async () => {
      const status = get().status
      if (status.kind !== 'done' || status.result.pass !== 'titles') return
      const titlesCost = status.result.costUsd
      await run(status.query, 'transcripts', (result) => ({ ...result, costUsd: addCost(titlesCost, result.costUsd) }))
    },
  }
})
