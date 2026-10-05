import type { NodeId } from '../../shared/ids'
import { baseHandle } from './handles'

/** `Kevin:amber-otter`, as a token or a reply part's `from` writes it. */
const NAMED_HANDLE = /\b([A-Z][A-Za-z]*):([a-z]+-[a-z]+(?:-\d+)?)\b/g
/** A logged event naming a node: `sent` writes them side by side. */
const NAMED_NODE = /"nodeId":"([^"]+)","name":"([^"]+)"/g

/**
 * Who the handles in Control's record were, for its transcript view.
 *
 * Control usually writes an agent as `{Kevin:amber-otter}`, but it often wrote
 * the handle alone, and the name registry cannot say who that was: it lets go
 * of an agent's name when the agent is archived, and most agents in the record
 * are long archived. What can say is the record and log themselves — every
 * place either wrote a name and a handle together, or an event named a node —
 * so names are learned from them as they grow.
 *
 * Before word handles, an agent was `a` and its node id's first six hex
 * digits (`ac35ae6`); the record still has those, and they resolve the same way.
 */
export class HandleNames {
  /** Handle to name, from a name and a handle written together. Later wins: a rename. */
  private readonly byHandle = new Map<string, string>()
  /** Node id to name, from events and the registry. */
  private readonly byNode = new Map<NodeId, string>()

  /** Everything `text` ties together: `Kevin:amber-otter`, and `"nodeId":"…","name":"…"` in a logged event. */
  learn(text: string): void {
    for (const [, name, handle] of text.matchAll(NAMED_HANDLE)) this.byHandle.set(handle, name)
    for (const [, nodeId, name] of text.matchAll(NAMED_NODE)) this.byNode.set(nodeId as NodeId, name)
  }

  /** A name the registry holds now: it wins over anything learned. */
  learnNode(nodeId: NodeId, name: string): void {
    this.byNode.set(nodeId, name)
  }

  resolve(handle: string): string | undefined {
    const key = handle.trim().toLowerCase()
    for (const [nodeId, name] of this.byNode) {
      if (isHandleOf(nodeId, key)) return name
    }
    return this.byHandle.get(key)
  }
}

/** Whether `handle` (lower case) is the node's: its word pair, or the hex handle that came before. */
export function isHandleOf(nodeId: NodeId, handle: string): boolean {
  const hex = /^a([0-9a-f]{6})$/.exec(handle)
  if (hex) return nodeId.replace(/[^A-Za-z0-9]/g, '').toLowerCase().startsWith(hex[1])
  // A collision's `-2` is the same pair: close enough to name a speaker.
  return baseHandle(nodeId) === handle.replace(/-\d+$/, '')
}
