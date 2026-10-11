/**
 * The agents Control knows have ended, kept on disk.
 *
 * Their transcripts outlive them, so read, ask_agent and unarchive_agent still
 * take their tokens. Kept only in memory, a server restart forgot every one:
 * the agent that had just self-terminated on the user's instruction became a
 * token Control had never heard of, and could be neither read nor brought back.
 */
import * as path from 'path'
import type { NodeId } from '../../shared/ids'
import { SOCKET_DIR } from '../../shared/protocol'
import { serverLog } from '../server-log'
import { fileStore, type NameRegistryStore } from './name-registry'
import type { RosterAgent } from './roster'

export const ENDED_FILE = path.join(SOCKET_DIR, 'receptionist', 'ended.json')

/** Ended agents kept, newest first to stay: the oldest go once there are more. */
export const MAX_ENDED = 100

/** An agent that is no longer live, as it was last seen, with the handle it had then. */
export interface EndedAgent {
  agent: RosterAgent
  handle: string
}

export class EndedAgents {
  /** Oldest first: a Map keeps insertion order, which is the order they ended in. */
  private readonly ended = new Map<NodeId, EndedAgent>()
  private readonly store: NameRegistryStore

  constructor(deps: { store?: NameRegistryStore } = {}) {
    this.store = deps.store ?? fileStore(ENDED_FILE)
    this.load()
  }

  get(nodeId: NodeId): EndedAgent | undefined {
    return this.ended.get(nodeId)
  }

  /** Newest last. */
  values(): EndedAgent[] {
    return [...this.ended.values()]
  }

  /** It has just ended, or ended again: it becomes the newest. */
  remember(ended: EndedAgent): void {
    this.ended.delete(ended.agent.nodeId)
    this.ended.set(ended.agent.nodeId, ended)
    for (const nodeId of this.ended.keys()) {
      if (this.ended.size <= MAX_ENDED) break
      this.ended.delete(nodeId)
    }
    this.save()
  }

  /** What is known of it changed, such as its cache: it keeps its place. */
  update(nodeId: NodeId, agent: RosterAgent): void {
    const ended = this.ended.get(nodeId)
    if (!ended) return
    this.ended.set(nodeId, { ...ended, agent })
    this.save()
  }

  delete(nodeId: NodeId): void {
    if (this.ended.delete(nodeId)) this.save()
  }

  private load(): void {
    const raw = this.store.load()
    if (!raw) return
    try {
      const parsed = JSON.parse(raw) as { ended?: unknown }
      if (!Array.isArray(parsed.ended)) return
      for (const entry of parsed.ended as Array<Partial<EndedAgent>>) {
        const agent = entry?.agent
        if (typeof entry?.handle !== 'string' || typeof agent?.nodeId !== 'string' || typeof agent.title !== 'string') continue
        this.ended.set(agent.nodeId, { agent, handle: entry.handle })
      }
    } catch {
      // A corrupt file is nothing remembered, not a server that will not start.
    }
  }

  /** Best-effort: called from session exits, where a failed write must not throw. */
  private save(): void {
    try {
      this.store.save(JSON.stringify({ ended: this.values() }))
    } catch (err) {
      serverLog(`[receptionist] failed to save ended agents: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}
