import type { NodeId } from '../shared/ids'
import { ROOT_NODE_ID } from '../shared/ids'
import { hasAgentMeta, type MetaScan } from './agent-meta-scan'

/** How long a probe result is trusted before it is checked again. */
const TTL_MS = 60_000

/** Cancels a scheduled callback. */
export type CancelScheduled = () => void

export interface AgentMetaAvailabilityDeps {
  /** Scan a host, or null when it is not a host at all. */
  scan(hostId: NodeId): MetaScan | null
  /** Hosts worth probing: the root, plus every directory node. */
  hosts(): NodeId[]
  scheduleInterval(fn: () => void, ms: number): CancelScheduled
  now(): number
}

/**
 * Whether each host has an agent-meta branch to offer, memoised.
 *
 * The toolbar button has to be enabled or greyed out before the user clicks it,
 * which means answering "does this directory have a CLAUDE.md or any skills?"
 * for every directory card on the canvas. That is a handful of `stat` calls per
 * host, so it is cached with a TTL and swept rather than asked on every render.
 *
 * Deliberately kept off `NodeData`. It is ephemeral in exactly the sense
 * `gitStatus` is — a claim about the filesystem right now, worthless if
 * restored from a file — and unlike `gitStatus` it also has to describe the
 * root node, which is not in `state.nodes` at all.
 */
export class AgentMetaAvailability {
  private cache = new Map<NodeId, { available: boolean; checkedAt: number }>()
  private cancelSweep: CancelScheduled | null = null

  constructor(
    private readonly deps: AgentMetaAvailabilityDeps,
    private readonly onChange: (hostId: NodeId, available: boolean) => void
  ) {}

  start(): void {
    this.sweep()
    this.cancelSweep = this.deps.scheduleInterval(() => this.sweep(), TTL_MS)
  }

  stop(): void {
    this.cancelSweep?.()
    this.cancelSweep = null
  }

  /** The cached answer, probing if it is missing or stale. */
  isAvailable(hostId: NodeId): boolean {
    const hit = this.cache.get(hostId)
    if (hit && this.deps.now() - hit.checkedAt < TTL_MS) return hit.available
    return this.probe(hostId)
  }

  /** Everything known right now, for a client that has just connected. */
  snapshot(): Array<{ nodeId: NodeId; available: boolean }> {
    return [...this.cache].map(([nodeId, { available }]) => ({ nodeId, available }))
  }

  /** A host's directory changed: its answer is no longer about the right place. */
  invalidate(hostId: NodeId): void {
    this.cache.delete(hostId)
    this.probe(hostId)
  }

  /** A host left the canvas. */
  forget(hostId: NodeId): void {
    this.cache.delete(hostId)
  }

  private sweep(): void {
    const live = new Set<NodeId>([ROOT_NODE_ID, ...this.deps.hosts()])
    for (const hostId of live) this.probe(hostId)
    // Drop hosts that are no longer on the canvas, so the map tracks the
    // canvas rather than growing for the life of the process.
    for (const hostId of [...this.cache.keys()]) {
      if (!live.has(hostId)) this.cache.delete(hostId)
    }
  }

  private probe(hostId: NodeId): boolean {
    const scan = this.deps.scan(hostId)
    const available = scan !== null && hasAgentMeta(scan)
    const previous = this.cache.get(hostId)?.available
    this.cache.set(hostId, { available, checkedAt: this.deps.now() })
    // Broadcast only on change: this runs for every host every sweep, and a
    // message per host per minute would be noise on an idle canvas.
    if (previous !== available) this.onChange(hostId, available)
    return available
  }
}
