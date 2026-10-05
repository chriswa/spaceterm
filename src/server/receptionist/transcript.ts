import type { ControlTranscriptEntry } from '../../shared/protocol'
import { AGENT_TOKEN, parseAgentRef } from './agent-token'
import { splitTurnBody } from './prompt'
import { CONTROL } from './reply'

/**
 * Control's transcript view, read from the full record — the conversation as
 * it happened, which the session's compaction never touches. The view loads
 * it a page at a time from the newest end, so the record is read backwards
 * from a byte offset rather than whole.
 */

/**
 * Who a handle stands for — `Kevin` for `amber-otter` — when the record wrote
 * the handle alone. See `HandleNames`.
 */
export type NameOf = (handle: string) => string | undefined

const NO_NAMES: NameOf = () => undefined

/** The record, as bytes. A seam so tests need no file. */
export interface RecordFile {
  size(): number
  read(start: number, length: number): Buffer
}

const CHUNK_BYTES = 64 * 1024
const NEWLINE = 0x0a

/**
 * Up to `count` entries ending before byte `before` (the end of the record
 * when undefined), oldest first. `more` when the record goes back further.
 */
export function transcriptPage(file: RecordFile, before: number | undefined, count: number, nameOf: NameOf = NO_NAMES): { entries: ControlTranscriptEntry[]; more: boolean } {
  const end = Math.min(before ?? Infinity, file.size())
  let start = end
  let bytes = Buffer.alloc(0)
  let entries: ControlTranscriptEntry[] = []
  while (start > 0 && entries.length < count) {
    const from = Math.max(0, start - CHUNK_BYTES)
    bytes = Buffer.concat([file.read(from, start - from), bytes])
    start = from
    entries = parseRecordBytes(bytes, start, nameOf)
  }
  const page = entries.slice(-count)
  return { entries: page, more: page.length > 0 && page[0].offset > 0 }
}

/** Every whole line of `bytes`, which start at `base` in the record. A line cut off at the front is skipped. */
export function parseRecordBytes(bytes: Buffer, base: number, nameOf: NameOf = NO_NAMES): ControlTranscriptEntry[] {
  const entries: ControlTranscriptEntry[] = []
  let at = 0
  if (base > 0) {
    // Whole only if the byte before it ends a line: the previous chunk's last byte, unseen here.
    const newline = bytes.indexOf(NEWLINE)
    if (newline < 0) return entries
    at = newline + 1
  }
  while (at < bytes.length) {
    const newline = bytes.indexOf(NEWLINE, at)
    const stop = newline < 0 ? bytes.length : newline
    const entry = parseRecordLine(bytes.toString('utf8', at, stop), base + at, nameOf)
    if (entry) entries.push(entry)
    at = stop + 1
  }
  return entries
}

/** One line of the record, as the view shows it; undefined for anything it cannot read. */
export function parseRecordLine(line: string, offset: number, nameOf: NameOf = NO_NAMES): ControlTranscriptEntry | undefined {
  let raw: { timestamp?: unknown; role?: unknown; content?: unknown; heard?: { of?: unknown; parts?: unknown }; notDone?: unknown }
  try { raw = JSON.parse(line) } catch { return undefined }
  const base = { offset, timestamp: typeof raw.timestamp === 'string' ? raw.timestamp : '' }
  const heard = raw.heard
  if (heard && typeof heard.of === 'number' && Array.isArray(heard.parts) && heard.parts.every(n => typeof n === 'number')) {
    return { ...base, kind: 'heard', of: heard.of, parts: heard.parts as number[] }
  }
  if (typeof raw.notDone === 'string') return { ...base, kind: 'log', text: readable(raw.notDone, nameOf), notDone: true }
  if (typeof raw.content !== 'string' || (raw.role !== 'user' && raw.role !== 'assistant')) return undefined
  if (raw.role === 'user') {
    const split = splitTurnBody(raw.content)
    // Every user message on record is a turn the user spoke in; anything else is shown whole.
    return split ? { ...base, kind: 'user', text: split.heard, ...(split.context ? { context: readable(split.context, nameOf) } : {}) }
      : { ...base, kind: 'user', text: raw.content }
  }
  const parts = replyParts(raw.content, nameOf)
  return parts ? { ...base, kind: 'reply', parts } : { ...base, kind: 'log', text: readable(raw.content, nameOf) }
}

/** A stored reply (`{"say":[{from,text}]}`), or undefined when the content is not one — a log line. */
function replyParts(content: string, nameOf: NameOf): Array<{ from: string; text: string }> | undefined {
  if (!content.startsWith('{')) return undefined
  let parsed: { say?: unknown }
  try { parsed = JSON.parse(content) } catch { return undefined }
  if (!Array.isArray(parsed.say)) return undefined
  return parsed.say.flatMap((part: { from?: unknown; text?: unknown }) =>
    typeof part?.text === 'string' ? [{ from: speaker(typeof part.from === 'string' ? part.from : CONTROL, nameOf), text: readable(part.text, nameOf) }] : [])
}

/**
 * "control" as Control, `Kevin:amber-otter` as Kevin, and a bare handle as
 * whoever `nameOf` says it is — itself only when nobody knows.
 */
function speaker(from: string, nameOf: NameOf): string {
  if (from === CONTROL) return 'Control'
  const ref = parseAgentRef(from)
  return ref.name || nameOf(ref.key) || ref.key
}

/** Agent tokens as the names they carry: `{Kevin:amber-otter}` reads "Kevin". */
function readable(text: string, nameOf: NameOf): string {
  return text.replace(AGENT_TOKEN, (_, inside: string) => speaker(inside, nameOf))
}
