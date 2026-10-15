/**
 * Agents the user took out of Control's hands to work with directly, kept on
 * disk.
 *
 * Typing into an agent ends Control's watch on it (`userTookOver`): the user
 * hears from it first-hand, and a watch kept through that woke Control at
 * every stop of a session the user was already reading. But the user also
 * comes back to working through Control, and an agent they were last working
 * with directly then sat stopped with nobody to bring it up. So an agent
 * Control had in hand — watched, or told of within `RECENT_MS` — goes on the
 * back burner instead: Control says nothing of it while the user works with
 * it, and once it has sat settled for `FORGOTTEN_MS` without them, it goes on
 * Control's backlog, to come up when the user is next talking to Control.
 *
 * Kept on disk for the reason watches are: the user restarts the server often.
 */
import * as path from 'path'
import type { NodeId } from '../../shared/ids'
import { SOCKET_DIR } from '../../shared/protocol'
import { serverLog } from '../server-log'
import { fileStore, type NameRegistryStore } from './name-registry'

export const BACK_BURNER_FILE = path.join(SOCKET_DIR, 'receptionist', 'back-burner.json')

/** How long after Control last had an agent in hand typing into it still puts it on the back burner. */
export const RECENT_MS = 60 * 60_000
/** How long an agent on the back burner sits settled, with the user not typing into it, before it counts as forgotten. */
export const FORGOTTEN_MS = 20 * 60_000

export class BackBurner {
  /** Agent → when the user last typed into it (epoch ms). */
  private readonly burners = new Map<NodeId, number>()
  /** Agent → when Control last had it in hand (epoch ms): watched it, or told the user of it. */
  private readonly involved = new Map<NodeId, number>()
  private readonly store: NameRegistryStore

  constructor(deps: { store?: NameRegistryStore } = {}) {
    this.store = deps.store ?? fileStore(BACK_BURNER_FILE)
    this.load()
  }

  /** Control has the agent in hand: it is off the back burner, and counts as recent. */
  involve(nodeId: NodeId, now = Date.now()): void {
    this.burners.delete(nodeId)
    this.involved.set(nodeId, now)
    this.prune(now)
    this.save()
  }

  /** Whether Control had the agent in hand within `RECENT_MS`. */
  wasRecent(nodeId: NodeId, now = Date.now()): boolean {
    const at = this.involved.get(nodeId)
    return at !== undefined && now - at <= RECENT_MS
  }

  /** The user typed into it: on the back burner from now. Returns whether it was already there. */
  put(nodeId: NodeId, now = Date.now()): boolean {
    const already = this.burners.has(nodeId)
    this.burners.set(nodeId, now)
    this.involved.delete(nodeId)
    this.save()
    return already
  }

  /** When the user last typed into it, if it is on the back burner. */
  takenAt(nodeId: NodeId): number | undefined {
    return this.burners.get(nodeId)
  }

  /** Off the back burner and forgotten as recent: it ended, or was brought up. Returns whether it was there. */
  remove(nodeId: NodeId): boolean {
    const was = this.burners.delete(nodeId)
    const knew = this.involved.delete(nodeId)
    if (was || knew) this.save()
    return was
  }

  entries(): Array<[NodeId, number]> {
    return [...this.burners]
  }

  private prune(now: number): void {
    for (const [nodeId, at] of this.involved) if (now - at > RECENT_MS) this.involved.delete(nodeId)
  }

  private load(): void {
    const raw = this.store.load()
    if (!raw) return
    try {
      const parsed = JSON.parse(raw) as { burners?: unknown; involved?: unknown }
      const read = (from: unknown, into: Map<NodeId, number>) => {
        if (typeof from !== 'object' || from === null) return
        for (const [nodeId, at] of Object.entries(from)) if (typeof at === 'number') into.set(nodeId as NodeId, at)
      }
      read(parsed.burners, this.burners)
      read(parsed.involved, this.involved)
    } catch {
      // A corrupt file is nothing on the back burner, not a server that will not start.
    }
  }

  /** Best-effort: called from state changes, where a failed write must not throw. */
  private save(): void {
    try {
      this.store.save(JSON.stringify({ burners: Object.fromEntries(this.burners), involved: Object.fromEntries(this.involved) }))
    } catch (err) {
      serverLog(`[receptionist] failed to save the back burner: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}
