/**
 * Claude Code's own session registry.
 *
 * Claude Code publishes one JSON file per live process under
 * `~/.claude/sessions/<pid>.json`, carrying — among the addressing it needs for
 * cross-session messaging — a `status` of `busy | waiting | idle | shell` and
 * the epoch ms at which that status last changed. The status is computed from
 * the same UI state that decides whether to draw the spinner:
 *
 *   waitingFor ??= queuedElicitation | topDialogWaitingFor | worker request
 *                  | sandbox request | dialog open
 *   status = waitingFor !== undefined ? 'waiting'
 *          : (isLoading || delegatedActive) ? 'busy'
 *          : 'idle'
 *
 * So it is Claude Code's own answer to the question this whole directory
 * infers from hooks and transcript entries, and it is right in the one case
 * that has no hook at all: an Esc interrupt (with or without a following
 * rewind) ends a turn without firing Stop and without appending a single byte
 * to the transcript, but it flips `isLoading` and therefore this file.
 *
 * NOTHING IN THE STATE MACHINE READS THIS YET — it is observed and logged
 * (see `session-status-observer.ts`) so its agreement with our own decisions
 * can be measured over days of real use before any transition depends on it.
 * The reasons to be careful are worth writing down:
 *
 * - It is an internal file, not a documented interface. The shape can change
 *   or vanish between Claude Code versions with no warning, which is why every
 *   field here is validated and an unrecognised `status` reads as *no opinion*
 *   rather than as a wrong one — the same three-valued discipline the liveness
 *   probes use (see `LivenessVerdict` in background-ledger.ts).
 * - It is edge-written, not a heartbeat: `statusUpdatedAt` is the transition
 *   time, and a file can sit untouched for hours while correct. Staleness is
 *   therefore not evidence of anything.
 * - It is Claude-only. Codex publishes per-thread write locks and Cursor
 *   publishes nothing comparable, so any state derived from this cannot be the
 *   single path for a non-Claude surface.
 */

import * as fs from 'fs'
import * as path from 'path'
import { homedir } from 'os'
import { asClaudeSessionId, type ClaudeSessionId } from '../../shared/ids'
import { CC_SESSION_STATUSES, type CcSessionStatus } from '../../shared/state'

/** Where Claude Code writes its per-process registry files. */
export const CC_SESSION_DIR = path.join(homedir(), '.claude', 'sessions')

/**
 * Re-exported so this module reads as the one place the registry's shape is
 * described, even though the union itself lives in `shared/state` — the footer
 * renders it, so the renderer needs it too.
 */
export { CC_SESSION_STATUSES, type CcSessionStatus }

/** The session kinds Claude Code records. Only `interactive` is a terminal surface. */
export const CC_SESSION_KINDS = ['interactive', 'bg', 'daemon', 'daemon-worker'] as const
export type CcSessionKind = (typeof CC_SESSION_KINDS)[number]

export interface SessionRegistryRecord {
  /** Process id, from the file name — the registry's primary key. */
  pid: number
  claudeSessionId: ClaudeSessionId
  status?: CcSessionStatus
  /** Free-text reason a `waiting` session is waiting ("dialog open", "input needed", …). */
  waitingFor?: string
  /** Epoch ms of the last `status` change. */
  statusUpdatedAt?: number
  kind?: CcSessionKind
  /**
   * Process start time as Claude Code recorded it. Logged rather than acted on:
   * it is the registry's own defence against pid reuse, and a record whose
   * `procStart` disagrees with the live process is a stale file wearing a live
   * pid. Keeping it in the observation log means a reused pid is diagnosable
   * instead of silently wrong.
   */
  procStart?: string
}

/**
 * The filesystem reads, seamed for tests: a fake supplies file names and bodies
 * rather than a populated `~/.claude/sessions`.
 */
export interface SessionRegistryDeps {
  listPidFiles(): string[]
  /** File body, or null if it disappeared between listing and reading. */
  readPidFile(fileName: string): string | null
  /** True when the pid is a live process. */
  pidAlive(pid: number): boolean
}

export const REAL_SESSION_REGISTRY_DEPS: SessionRegistryDeps = {
  listPidFiles() {
    try {
      return fs.readdirSync(CC_SESSION_DIR).filter((name) => name.endsWith('.json'))
    } catch {
      // No directory at all is the expected state on a machine whose Claude
      // Code predates the registry — not an error worth logging every tick.
      return []
    }
  },
  readPidFile(fileName) {
    try {
      return fs.readFileSync(path.join(CC_SESSION_DIR, fileName), 'utf8')
    } catch {
      return null
    }
  },
  pidAlive(pid) {
    try {
      // Signal 0 tests for existence and permission without delivering anything.
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
}

/** `12345.json` → 12345. Rejects any name that doesn't round-trip, as the registry's own parser does. */
export function pidFromFileName(fileName: string): number | null {
  const stem = fileName.replace(/\.json$/, '')
  const pid = Number.parseInt(stem, 10)
  if (!Number.isInteger(pid) || pid <= 1) return null
  // A non-canonical name ("0012.json", "12x.json") is not a file this registry wrote.
  return String(pid) === stem ? pid : null
}

function asStatus(value: unknown): CcSessionStatus | undefined {
  return (CC_SESSION_STATUSES as readonly unknown[]).includes(value) ? (value as CcSessionStatus) : undefined
}

function asKind(value: unknown): CcSessionKind | undefined {
  return (CC_SESSION_KINDS as readonly unknown[]).includes(value) ? (value as CcSessionKind) : undefined
}

function asEpochMs(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function asText(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Parse one registry file. Returns null when the file isn't a usable record —
 * a name that isn't a pid, a body that isn't JSON (the writer is not known to
 * be atomic, so a torn read is possible), or a record with no session id to
 * join a surface on.
 */
export function parseSessionRegistryRecord(fileName: string, body: string): SessionRegistryRecord | null {
  const pid = pidFromFileName(fileName)
  if (pid === null) return null

  let raw: unknown
  try {
    raw = JSON.parse(body)
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const fields = raw as Record<string, unknown>

  const sessionId = asText(fields.sessionId)
  if (sessionId === undefined) return null

  const record: SessionRegistryRecord = { pid, claudeSessionId: asClaudeSessionId(sessionId) }
  const status = asStatus(fields.status)
  if (status !== undefined) record.status = status
  const waitingFor = asText(fields.waitingFor)
  if (waitingFor !== undefined) record.waitingFor = waitingFor
  const statusUpdatedAt = asEpochMs(fields.statusUpdatedAt)
  if (statusUpdatedAt !== undefined) record.statusUpdatedAt = statusUpdatedAt
  const kind = asKind(fields.kind)
  if (kind !== undefined) record.kind = kind
  const procStart = asText(fields.procStart)
  if (procStart !== undefined) record.procStart = procStart
  return record
}

/**
 * Read the whole registry, indexed by Claude session id — the key a surface can
 * be joined on, since that is what hooks and the transcript watcher already
 * carry. Records whose pid is gone are dropped: the registry cleans up on exit,
 * but a SIGKILLed session leaves its last status behind, and "busy" from a dead
 * process is the one reading that would be actively misleading.
 */
export function readSessionRegistry(
  deps: SessionRegistryDeps = REAL_SESSION_REGISTRY_DEPS
): Map<ClaudeSessionId, SessionRegistryRecord> {
  const bySession = new Map<ClaudeSessionId, SessionRegistryRecord>()
  for (const fileName of deps.listPidFiles()) {
    const body = deps.readPidFile(fileName)
    if (body === null) continue
    const record = parseSessionRegistryRecord(fileName, body)
    if (record === null || !deps.pidAlive(record.pid)) continue
    bySession.set(record.claudeSessionId, record)
  }
  return bySession
}
