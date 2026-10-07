/**
 * What Control has to be told that would otherwise die with the server.
 *
 * Its notes — what became of its last reply — wait in memory for the next
 * message, and a restart threw them away: a reply the restart cut off went
 * into the next session as though it had all been heard. A server that shuts
 * down cleanly leaves its notes here. One that crashes cannot, so a reply
 * being spoken is marked here as it starts and unmarked once it is over: a
 * mark the next server finds is a reply that was cut off at no known point.
 */
import * as path from 'path'
import { SOCKET_DIR } from '../../shared/protocol'
import { serverLog } from '../server-log'
import { fileStore, type NameRegistryStore } from './name-registry'

export const CARRY_OVER_FILE = path.join(SOCKET_DIR, 'receptionist', 'carry-over.json')

/** Told to Control, ahead of what was heard, when the last server shut down mid-reply. */
export const RESTARTED_MID_REPLY = 'The server restarted while you were speaking, and that cut your last reply off.'
/** Told to Control when the last server crashed mid-reply. */
export const CRASHED_MID_REPLY = 'The server stopped while you were speaking your last reply, and it is not known how much of it the user heard. ' +
  'If it still matters, check what they caught before you build on it.'

interface Saved {
  notes: string[]
  /** A reply was being spoken. */
  speaking: boolean
}

export class CarryOver {
  private readonly store: NameRegistryStore
  private saved: Saved = { notes: [], speaking: false }

  constructor(deps: { store?: NameRegistryStore } = {}) {
    this.store = deps.store ?? fileStore(CARRY_OVER_FILE)
  }

  /** The notes the last server left, with the crash note if it went mid-reply; the file is cleared. */
  take(): string[] {
    const raw = this.store.load()
    let saved: Partial<Saved> = {}
    try {
      if (raw) saved = JSON.parse(raw) as Partial<Saved>
    } catch {
      // A corrupt file is nothing carried over, not a server that will not start.
    }
    const notes = Array.isArray(saved.notes) ? saved.notes.filter((note): note is string => typeof note === 'string') : []
    if (saved.speaking === true) notes.push(CRASHED_MID_REPLY)
    if (raw) this.write({ notes: [], speaking: false })
    return notes
  }

  /** A reply starts or stops being spoken: see the module comment. */
  speaking(speaking: boolean): void {
    if (this.saved.speaking === speaking) return
    this.write({ ...this.saved, speaking })
  }

  /** The server is going: leave the notes for the next one. Nothing is being spoken any more. */
  leave(notes: readonly string[]): void {
    this.write({ notes: [...notes], speaking: false })
  }

  /** Best-effort: called on the way to speech, where a failed write must not throw. */
  private write(saved: Saved): void {
    this.saved = saved
    try {
      this.store.save(JSON.stringify(saved))
    } catch (err) {
      serverLog(`[receptionist] failed to save carry-over: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}
