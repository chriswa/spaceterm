import { createHash } from 'crypto'
import type { NodeId } from '../../shared/ids'

/**
 * The ids the receptionist's model uses for agents and directories:
 * `amber-otter`, not `a3f9a2c`.
 *
 * Hex prefixes of node ids looked alike — many began with the same few
 * characters — and the model miscopied them, sending to an agent it did not
 * mean with no way to notice. Two ordinary words are hard to garble into
 * another valid pair: no two words in a list share their first three letters,
 * and none is a name from the voice roster, so a handle is never mistaken for
 * the name it stands for.
 *
 * A handle is derived from the node id, so it is the same in every turn and
 * across restarts. Two live agents landing on the same pair is rare (about one
 * in ten thousand per pair); when it happens the later one, by node id, gets
 * `-2`. See `Handles`.
 */

export const ADJECTIVES = [
  'amber', 'azure', 'bold', 'brisk', 'calm', 'cedar', 'chalk', 'civic', 'clear', 'coral',
  'crisp', 'dusty', 'eager', 'early', 'ebony', 'fancy', 'fern', 'fiery', 'frank', 'frost',
  'gentle', 'giant', 'gold', 'grand', 'happy', 'hazy', 'humble', 'icy', 'idle', 'inky',
  'jolly', 'jumbo', 'keen', 'kind', 'lavish', 'lemon', 'little', 'lofty', 'lucky', 'lunar',
  'magic', 'merry', 'mighty', 'misty', 'modern', 'mossy', 'narrow', 'neat', 'noble', 'north',
  'ochre', 'olive', 'open', 'orange', 'pale', 'pearl', 'plain', 'plum', 'polar', 'proud',
  'quick', 'quaint', 'rapid', 'rare', 'rocky', 'royal', 'ruby', 'rusty', 'sandy', 'scarlet',
  'shy', 'silver', 'slate', 'sleepy', 'smooth', 'snowy', 'solar', 'spicy', 'steady', 'stormy',
  'sunny', 'swift', 'tame', 'teal', 'tidy', 'tiny', 'topaz', 'tough', 'twin', 'umber',
  'upper', 'urban', 'velvet', 'vivid', 'warm', 'wavy', 'west', 'wild', 'windy', 'witty',
  'young', 'zany', 'zesty',
]

export const NOUNS = [
  'acorn', 'anchor', 'anvil', 'apple', 'arrow', 'badger', 'barn', 'beacon', 'bison', 'bottle',
  'brook', 'cactus', 'camel', 'canoe', 'castle', 'cherry', 'cliff', 'cobra', 'comet', 'crane',
  'dingo', 'dolphin', 'donkey', 'dragon', 'drum', 'eagle', 'echo', 'eel', 'elbow', 'engine',
  'falcon', 'feather', 'ferry', 'fig', 'flute', 'fox', 'gecko', 'geyser', 'glove', 'goat',
  'gopher', 'harbor', 'hammer', 'hedge', 'heron', 'hippo', 'iguana', 'island', 'jackal', 'jaguar',
  'jelly', 'kayak', 'kettle', 'kiwi', 'koala', 'ladder', 'lagoon', 'lemur', 'lizard', 'llama',
  'magnet', 'mango', 'marble', 'meadow', 'mitten', 'moose', 'nectar', 'needle', 'newt', 'nugget',
  'oasis', 'octopus', 'orbit', 'otter', 'owl', 'paddle', 'panda', 'parrot', 'pebble', 'pelican',
  'quartz', 'quill', 'rabbit', 'radish', 'raven', 'river', 'rocket', 'saddle', 'salmon',
  'seal', 'shovel', 'sloth', 'spider', 'squid', 'tiger', 'toast', 'tulip', 'turtle', 'umbrella',
  'urchin', 'valley', 'violin', 'vulture', 'walrus', 'wagon', 'whale', 'wombat', 'yak', 'zebra',
]

/** The pair a node id hashes to, before any collision is resolved. */
export function baseHandle(nodeId: NodeId, prefix = ''): string {
  const digest = createHash('sha256').update(nodeId).digest()
  const adjective = ADJECTIVES[digest.readUInt16BE(0) % ADJECTIVES.length]
  const noun = NOUNS[digest.readUInt16BE(2) % NOUNS.length]
  return `${prefix}${adjective}-${noun}`
}

/**
 * Handles for a set of nodes, distinct among them: a collision is resolved by
 * node id order, so the same set always gets the same handles.
 */
export class Handles {
  private readonly byNode = new Map<NodeId, string>()
  private readonly byHandle = new Map<string, NodeId>()

  constructor(nodeIds: readonly NodeId[], prefix = '') {
    const taken = new Map<string, number>()
    for (const nodeId of [...nodeIds].sort()) {
      const base = baseHandle(nodeId, prefix)
      const seen = (taken.get(base) ?? 0) + 1
      taken.set(base, seen)
      const handle = seen === 1 ? base : `${base}-${seen}`
      this.byNode.set(nodeId, handle)
      this.byHandle.set(handle, nodeId)
    }
  }

  of(nodeId: NodeId): string | undefined {
    return this.byNode.get(nodeId)
  }

  find(handle: string): NodeId | undefined {
    return this.byHandle.get(handle.trim().toLowerCase())
  }

  /** The handles nearest to a mistyped one, nearest first: for "did you mean". */
  nearest(handle: string, limit = 2): string[] {
    const wanted = handle.trim().toLowerCase()
    return [...this.byHandle.keys()]
      .map(candidate => ({ candidate, distance: editDistance(wanted, candidate) }))
      .filter(({ candidate, distance }) => distance <= Math.max(3, Math.floor(candidate.length / 3)))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, limit)
      .map(({ candidate }) => candidate)
  }
}

/** Directory handles carry a prefix, so an agent's and a directory's can never be confused. */
export const DIRECTORY_PREFIX = 'dir-'

/** Levenshtein distance, for "did you mean". */
export function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const current = [i]
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    previous = current
  }
  return previous[b.length]
}
