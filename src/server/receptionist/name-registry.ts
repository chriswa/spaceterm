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
 * The receptionist can also give a surface a name of its own choosing
 * (`setName`): on spawn, or to rename an agent. Such a name need not be in the
 * roster, so it comes with a gender, and the surface's voice follows it: kept
 * if it is already that gender, otherwise replaced by one that is, so a name
 * is never spoken in a voice of the other gender. The same distinctness rule
 * holds, but only roster names have phonetic keys, so a name outside the
 * roster is told apart from the others by spelling alone.
 *
 * Persisted as JSON at `<SPACETERM_HOME>/receptionist/names.json`.
 */

import * as fs from 'fs'
import * as path from 'path'
import { SOCKET_DIR } from '../../shared/protocol'
import { asNodeId, type NodeId } from '../../shared/ids'
import { serverLog } from '../server-log'
import {
  AGENT_VOICES, NAME_VOICE_TABLE, RECEPTIONIST_NAME, RECEPTIONIST_VOICE, rosterEntry, type NamedVoice, type VoiceGender,
} from './name-voice-table'
import { phoneticKey } from './name-phonetics'

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

const VERSION = 2

interface Persisted {
  version: number
  /**
   * nodeId → assigned name and voice; the gender is the voice's. Version 1
   * stored only a roster name, whose voice was the table's.
   */
  assignments: Record<string, { name: string; voice: string } | string>
  /** roster name → epoch ms it was last assigned or mentioned. */
  lastUsedAt: Record<string, number>
}

/** A name the receptionist can give: one spoken word, which an agent token can carry. */
const NAME_PATTERN = /^[A-Za-z]{2,20}$/

/** Why a name can't be given, as `nameProblem` reports it. */
export type NameProblem =
  | { kind: 'not-a-name' }
  | { kind: 'reserved' }
  /** Held by another live surface, or sounds like one that is. */
  | { kind: 'taken'; by: NodeId; name: string }

/** What sets two names apart by ear: the phonetic key for roster names, the spelling for others. */
function soundKey(name: string): string {
  return phoneticKey(name) ?? name.toLowerCase()
}

/** A name as it is kept: the roster's spelling if it is a roster name, else capitalized. */
function normalizeName(name: string): string {
  const trimmed = name.trim()
  return rosterEntry(trimmed)?.name ?? trimmed.charAt(0).toUpperCase() + trimmed.slice(1)
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

    this.releaseDead()

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
    this.markUsed(entry.name, now)
    this.save()
  }

  /**
   * Why `name` can't be given to `nodeId` (or to a surface not yet made, when
   * undefined), or undefined if it can. Releases names held by surfaces that
   * are gone first, as `assign` does.
   */
  nameProblem(nodeId: NodeId | undefined, name: string): NameProblem | undefined {
    const trimmed = name.trim()
    if (!NAME_PATTERN.test(trimmed)) return { kind: 'not-a-name' }
    if (trimmed.toLowerCase() === RECEPTIONIST_NAME.toLowerCase()) return { kind: 'reserved' }
    this.releaseDead()
    const key = soundKey(trimmed)
    for (const [holder, entry] of this.assignments) {
      if (holder !== nodeId && soundKey(entry.name) === key) return { kind: 'taken', by: holder, name: entry.name }
    }
    return undefined
  }

  /**
   * Give the surface `name`, as a name of `gender`. Its voice is kept if it
   * has one of that gender; otherwise it gets a voice of that gender, the one
   * fewest other surfaces are using, preferring the name's own roster voice.
   * Fails, changing nothing, for any reason `nameProblem` gives.
   */
  setName(
    nodeId: NodeId, name: string, gender: VoiceGender, now = Date.now(),
  ): { ok: true; named: NamedVoice; voiceChanged: boolean } | { ok: false; problem: NameProblem } {
    const problem = this.nameProblem(nodeId, name)
    if (problem) return { ok: false, problem }
    const previous = this.assignments.get(nodeId)
    const voice = previous?.gender === gender ? previous.voice : this.voiceFor(nodeId, name, gender)
    const named: NamedVoice = { name: normalizeName(name), voice, gender }
    this.assignments.set(nodeId, named)
    this.markUsed(named.name, now)
    this.save()
    return { ok: true, named, voiceChanged: previous !== undefined && previous.voice !== voice }
  }

  /** The surface currently holding `name` (exact, case-insensitive), if any. */
  byName(name: string): NodeId | undefined {
    const lower = name.toLowerCase()
    for (const [nodeId, entry] of this.assignments) {
      if (entry.name.toLowerCase() === lower) return nodeId
    }
    return undefined
  }

  /** Every name currently assigned. */
  assignedNames(): string[] {
    return [...this.assignments.values()].map((e) => e.name)
  }

  private releaseDead(): void {
    for (const id of [...this.assignments.keys()]) {
      if (!this.isLive(id)) this.assignments.delete(id)
    }
  }

  /** Only roster names are chosen by `lastUsedAt`, so only theirs is kept. */
  private markUsed(name: string, now: number): void {
    const entry = rosterEntry(name)
    if (entry) this.lastUsedAt.set(entry.name, now)
  }

  /** A voice of `gender` for `nodeId`, which is being given `name`: see `setName`. */
  private voiceFor(nodeId: NodeId, name: string, gender: VoiceGender): string {
    const others = [...this.assignments].filter(([id]) => id !== nodeId).map(([, e]) => e.voice)
    const users = (voice: string): number => others.filter((v) => v === voice).length
    const own = rosterEntry(name)?.voice
    const voices = [...AGENT_VOICES].filter(([, g]) => g === gender).map(([voice]) => voice)
    const offset = hash(nodeId) % voices.length
    const rank = (voice: string): number => (voices.indexOf(voice) - offset + voices.length) % voices.length
    return [...voices].sort((a, b) =>
      users(a) - users(b) || Number(b === own) - Number(a === own) || rank(a) - rank(b),
    )[0]
  }

  private choose(nodeId: NodeId): NamedVoice | undefined {
    const held = [...this.assignments.values()]
    const heldKeys = new Set(held.map((e) => soundKey(e.name)))
    const heldVoices = new Set(held.map((e) => e.voice))

    const eligible = NAME_VOICE_TABLE.filter(
      (e) => e.voice !== RECEPTIONIST_VOICE && !heldKeys.has(soundKey(e.name)),
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
    if (doc?.version !== VERSION && doc?.version !== 1) {
      serverLog(`receptionist names: ignoring version ${String(doc?.version)}`)
      return
    }
    // Pairings that are no longer valid are dropped: a roster name whose voice
    // left the roster (or moved onto the reserved voice), a voice no agent may
    // have, a duplicate. So a roster change can't resurrect a stale pairing.
    const taken = new Set<string>()
    for (const [nodeId, saved] of Object.entries(doc.assignments ?? {})) {
      const entry = this.restored(saved)
      if (!entry || taken.has(soundKey(entry.name))) continue
      taken.add(soundKey(entry.name))
      this.assignments.set(asNodeId(nodeId), entry)
    }
    for (const [name, at] of Object.entries(doc.lastUsedAt ?? {})) {
      const entry = rosterEntry(name)
      if (entry && typeof at === 'number') this.lastUsedAt.set(entry.name, at)
    }
  }

  /** A saved assignment, or undefined if it is not one that could be made now. */
  private restored(saved: unknown): NamedVoice | undefined {
    if (typeof saved === 'string') {
      const entry = rosterEntry(saved)
      return entry && entry.voice !== RECEPTIONIST_VOICE ? entry : undefined
    }
    if (typeof saved !== 'object' || saved === null) return undefined
    const { name, voice } = saved as Record<string, unknown>
    if (typeof name !== 'string' || typeof voice !== 'string') return undefined
    const gender = AGENT_VOICES.get(voice)
    if (!gender || !NAME_PATTERN.test(name) || name.toLowerCase() === RECEPTIONIST_NAME.toLowerCase()) return undefined
    return { name: normalizeName(name), voice, gender }
  }

  private save(): void {
    const doc: Persisted = {
      version: VERSION,
      assignments: Object.fromEntries([...this.assignments].map(([id, e]) => [id, { name: e.name, voice: e.voice }])),
      lastUsedAt: Object.fromEntries(this.lastUsedAt),
    }
    try {
      this.store.save(JSON.stringify(doc, null, 2) + '\n')
    } catch (err) {
      serverLog(`receptionist names: could not save ${NAMES_FILE}: ${String(err)}`)
    }
  }
}
