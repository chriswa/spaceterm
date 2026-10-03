/**
 * Sticky name-and-voice assignment for agent surfaces.
 *
 * The receptionist calls an agent surface by a human name ("Kevin finished the
 * migration"), always in that name's voice. This registry decides which name.
 *
 * Rules:
 * - Lazy. A surface gets a name only when the receptionist first needs to
 *   mention it (`assign`). Nothing is assigned up front.
 * - Sticky. Once assigned, a surface keeps its name until it is archived or
 *   deleted. There is no archive handler: whenever a *new* assignment is
 *   needed, every assignment whose node is no longer live is released first.
 *   A surface that is unarchived later just gets a new name.
 * - Distinct. A name already assigned, or one that sounds like it (same
 *   phonetic key, e.g. Dana while Dean is assigned), is never handed out, so a
 *   heard name always identifies one surface. A voice not used by any current
 *   assignment is preferred; voices double up only once all are in use.
 * - Forgotten before reused. Among eligible names, the one used longest ago
 *   wins, never-used names first. A name's `lastUsedAt` is set when it is
 *   assigned and whenever the receptionist mentions its surface (`touch`), so a
 *   recently heard name is the last to be given to a different surface.
 *
 * Persisted as JSON at `<SPACETERM_HOME>/receptionist/names.json`.
 */

import * as fs from 'fs'
import * as path from 'path'
import { SOCKET_DIR } from '../../shared/protocol'
import { asNodeId, type NodeId } from '../../shared/ids'
import { serverLog } from '../server-log'
import { NAME_VOICE_TABLE, RECEPTIONIST_VOICE, rosterEntry, type NamedVoice } from './name-voice-table'
import { phoneticKey } from './name-aliases'

/** Raw storage for the registry's JSON document. */
export interface NameRegistryStore {
  /** The saved document, or undefined if there is none yet. */
  load(): string | undefined
  save(json: string): void
}

export interface NameRegistryDeps {
  /**
   * Whether a node still exists and is not archived. Consulted only when a new
   * assignment is needed, to release names held by surfaces that are gone.
   */
  isLive: (nodeId: NodeId) => boolean
  /** Defaults to `<SPACETERM_HOME>/receptionist/names.json`. */
  store?: NameRegistryStore
}

export const NAMES_FILE = path.join(SOCKET_DIR, 'receptionist', 'names.json')

/** Atomic write (tmp + rename) so a crash mid-save can't leave a torn file. */
export function fileStore(file: string): NameRegistryStore {
  return {
    load: () => {
      try {
        return fs.readFileSync(file, 'utf-8')
      } catch {
        return undefined
      }
    },
    save: (json) => {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const tmp = file + '.tmp'
      fs.writeFileSync(tmp, json, 'utf-8')
      fs.renameSync(tmp, file)
    },
  }
}

const VERSION = 1

interface Persisted {
  version: number
  /** nodeId → assigned roster name. The voice is looked up from the table. */
  assignments: Record<string, string>
  /** roster name → epoch ms it was last assigned or mentioned. */
  lastUsedAt: Record<string, number>
}

/** Small stable string hash (FNV-1a), to spread never-used ties across the roster. */
function hash(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

export class NameRegistry {
  private readonly isLive: (nodeId: NodeId) => boolean
  private readonly store: NameRegistryStore
  private readonly assignments = new Map<NodeId, NamedVoice>()
  private readonly lastUsedAt = new Map<string, number>()

  constructor(deps: NameRegistryDeps) {
    this.isLive = deps.isLive
    this.store = deps.store ?? fileStore(NAMES_FILE)
    this.load()
  }

  /** The surface's assignment, or undefined if it has none. Never assigns. */
  get(nodeId: NodeId): NamedVoice | undefined {
    return this.assignments.get(nodeId)
  }

  /**
   * The surface's assignment, making one if it has none. Making one first
   * releases every assignment whose node is no longer live.
   *
   * Returns undefined only when every name is taken by a live surface (or
   * sounds like one that is): about seventy concurrent surfaces.
   */
  assign(nodeId: NodeId, now = Date.now()): NamedVoice | undefined {
    const existing = this.assignments.get(nodeId)
    if (existing) return existing

    for (const id of [...this.assignments.keys()]) {
      if (!this.isLive(id)) this.assignments.delete(id)
    }

    const chosen = this.choose(nodeId)
    if (chosen) {
      this.assignments.set(nodeId, chosen)
      this.lastUsedAt.set(chosen.name, now)
    }
    this.save()
    return chosen
  }

  /** Record that the receptionist just mentioned this surface by name. */
  touch(nodeId: NodeId, now = Date.now()): void {
    const entry = this.assignments.get(nodeId)
    if (!entry) return
    this.lastUsedAt.set(entry.name, now)
    this.save()
  }

  /** The surface currently holding `name` (exact, case-insensitive), if any. */
  byName(name: string): NodeId | undefined {
    const lower = name.toLowerCase()
    for (const [nodeId, entry] of this.assignments) {
      if (entry.name.toLowerCase() === lower) return nodeId
    }
    return undefined
  }

  /** Every name currently assigned: the `candidates` for `resolveName`. */
  assignedNames(): string[] {
    return [...this.assignments.values()].map((e) => e.name)
  }

  private choose(nodeId: NodeId): NamedVoice | undefined {
    const held = [...this.assignments.values()]
    const heldKeys = new Set(held.map((e) => phoneticKey(e.name) ?? e.name.toLowerCase()))
    const heldVoices = new Set(held.map((e) => e.voice))

    const eligible = NAME_VOICE_TABLE.filter(
      (e) => e.voice !== RECEPTIONIST_VOICE && !heldKeys.has(phoneticKey(e.name) ?? e.name.toLowerCase()),
    )
    const freshVoice = eligible.filter((e) => !heldVoices.has(e.voice))
    const pool = freshVoice.length > 0 ? freshVoice : eligible
    if (pool.length === 0) return undefined

    // Least recently used first; never-used names count as used at -Infinity.
    // Ties (typically the never-used names) are broken by position in the
    // roster, rotated by a hash of the node id so first assignments spread
    // across the roster instead of always starting at its head.
    const offset = hash(nodeId) % NAME_VOICE_TABLE.length
    const rank = (e: NamedVoice): number =>
      (NAME_VOICE_TABLE.indexOf(e) - offset + NAME_VOICE_TABLE.length) % NAME_VOICE_TABLE.length
    const used = (e: NamedVoice): number => this.lastUsedAt.get(e.name) ?? -Infinity
    return [...pool].sort((a, b) => used(a) - used(b) || rank(a) - rank(b))[0]
  }

  private load(): void {
    const json = this.store.load()
    if (json === undefined) return
    let doc: Persisted
    try {
      doc = JSON.parse(json) as Persisted
    } catch (err) {
      serverLog(`receptionist names: unreadable ${NAMES_FILE}, starting empty: ${String(err)}`)
      return
    }
    if (doc?.version !== VERSION) {
      serverLog(`receptionist names: ignoring version ${String(doc?.version)}`)
      return
    }
    // Names that left the roster (or moved onto the reserved voice) are dropped,
    // so a roster change can't resurrect a stale pairing.
    const taken = new Set<string>()
    for (const [nodeId, name] of Object.entries(doc.assignments ?? {})) {
      const entry = rosterEntry(name)
      if (!entry || entry.voice === RECEPTIONIST_VOICE || taken.has(entry.name)) continue
      taken.add(entry.name)
      this.assignments.set(asNodeId(nodeId), entry)
    }
    for (const [name, at] of Object.entries(doc.lastUsedAt ?? {})) {
      const entry = rosterEntry(name)
      if (entry && typeof at === 'number') this.lastUsedAt.set(entry.name, at)
    }
  }

  private save(): void {
    const doc: Persisted = {
      version: VERSION,
      assignments: Object.fromEntries([...this.assignments].map(([id, e]) => [id, e.name])),
      lastUsedAt: Object.fromEntries(this.lastUsedAt),
    }
    try {
      this.store.save(JSON.stringify(doc, null, 2) + '\n')
    } catch (err) {
      serverLog(`receptionist names: could not save ${NAMES_FILE}: ${String(err)}`)
    }
  }
}
