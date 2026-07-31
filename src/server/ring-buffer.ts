import * as fs from 'fs'
import { serverLog } from './server-log'

/**
 * Fixed-size time-slot ring buffer for a monotonic time series (currently the
 * GitHub rate-limit sparkline).
 *
 * Slots are addressed by `floor(time / slotMs) mod HISTORY_SLOTS`, so a value
 * simply overwrites whatever occupied that slot a full cycle ago and no eviction
 * pass is needed. Each slot stores its own slotKey, which is what lets `build()`
 * tell "this slot holds the value for the minute I am asking about" from "this
 * slot holds a stale value from one full wrap ago" — without that check a gap in
 * recording would silently render as old data.
 *
 * Extracted from server/index.ts: it has no coupling to the server and is worth
 * testing directly. `record` and `build` both take an injectable `now` so tests
 * do not depend on wall-clock timing.
 */
export const HISTORY_SLOTS = 61

interface Slot {
  slotKey: number
  value: number
}

export class RingBuffer {
  private slots: (Slot | null)[]
  private seeded = false
  private label: string
  private slotMs: number

  constructor(label: string, slotMs: number) {
    this.label = label
    this.slotMs = slotMs
    this.slots = new Array(HISTORY_SLOTS).fill(null)
  }

  private indexFor(slotKey: number): number {
    // Double modulo so negative slot keys (times before the epoch, or a bad
    // timestamp in a seed log) still land on a valid index.
    return ((slotKey % HISTORY_SLOTS) + HISTORY_SLOTS) % HISTORY_SLOTS
  }

  record(value: number, now = Date.now()): void {
    const slotKey = Math.floor(now / this.slotMs)
    this.slots[this.indexFor(slotKey)] = { slotKey, value }
  }

  /**
   * Oldest-to-newest series of exactly HISTORY_SLOTS entries, with `null` for
   * slots that were never recorded or have since been overwritten by a newer
   * cycle. The client renders nulls as gaps rather than zeroes.
   */
  build(now = Date.now()): (number | null)[] {
    const nowSlot = Math.floor(now / this.slotMs)
    const result: (number | null)[] = []
    for (let i = HISTORY_SLOTS - 1; i >= 0; i--) {
      const targetSlot = nowSlot - i
      const slot = this.slots[this.indexFor(targetSlot)]
      result.push(slot && slot.slotKey === targetSlot ? slot.value : null)
    }
    return result
  }

  /**
   * Replay JSONL entries into the buffer. Split out from seedFromLog so the
   * parsing rules — malformed lines, missing keys, entries older than the
   * window — are testable without touching the filesystem.
   *
   * Returns the number of entries actually recorded.
   */
  seedFromLines(lines: string[], valueKey: string, now = Date.now()): number {
    const cutoffSlot = Math.floor(now / this.slotMs) - HISTORY_SLOTS
    let recorded = 0
    for (const line of lines) {
      try {
        const entry = JSON.parse(line)
        const value = entry[valueKey]
        if (typeof value !== 'number' || !entry.timestamp) continue
        const time = new Date(entry.timestamp).getTime()
        if (!Number.isFinite(time)) continue
        const slotKey = Math.floor(time / this.slotMs)
        if (slotKey <= cutoffSlot) continue
        // Record at the slot's own start time so the entry lands in the slot its
        // timestamp belongs to, not the one it happens to be replayed during.
        this.record(value, slotKey * this.slotMs)
        recorded++
      } catch {
        // Skip a malformed line rather than abandoning the rest of the seed.
      }
    }
    return recorded
  }

  /**
   * Seed history from the tail of a JSONL log so a server restart does not blank
   * the sparkline. Only ever runs once per instance.
   */
  seedFromLog(logFile: string, valueKey: string): void {
    if (this.seeded) return
    this.seeded = true
    try {
      if (!fs.existsSync(logFile)) return
      const fd = fs.openSync(logFile, 'r')
      const stat = fs.fstatSync(fd)
      const readSize = Math.min(stat.size, Math.ceil(this.slotMs / 60_000) * 4096)
      const buf = Buffer.alloc(readSize)
      fs.readSync(fd, buf, 0, readSize, stat.size - readSize)
      fs.closeSync(fd)

      const lines = buf.toString('utf8').split('\n').filter(Boolean)
      // When the read started mid-file the first line is probably truncated.
      const usable = stat.size > readSize ? lines.slice(1) : lines
      const recorded = this.seedFromLines(usable, valueKey)
      serverLog(`[${this.label}] Seeded history from log (${usable.length} entries scanned, ${recorded} recorded)`)
    } catch (err) {
      serverLog(`[${this.label}] Failed to seed history: ${(err as Error).message}`)
    }
  }
}
