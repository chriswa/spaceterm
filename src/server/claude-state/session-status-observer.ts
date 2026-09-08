/**
 * Observation-only recorder for Claude Code's session registry.
 *
 * Every tick it reads `~/.claude/sessions/*.json` (see `session-registry.ts`),
 * joins each record to the surface running that Claude session, and appends a
 * line to `~/.spaceterm/session-status-logs/<surfaceId>.jsonl` whenever either
 * side changes. It sets no state and enqueues no transition; the point is to
 * accumulate enough paired observations that a decision about *using* the
 * registry can be made from data rather than from one bug report.
 *
 * The comparison is the payload. `agreement` scores each observation against
 * the hypothesis in `expectedStates()`, so the analysis is a grep:
 *
 *   agreement: 'agree'         — the registry says what we say
 *   agreement: 'disagree'      — one of us is wrong; which one is the finding
 *   agreement: 'no-opinion'    — registry has no status, or `shell`, which we
 *                                do not model
 *
 * and `lagMs` (our decision time minus the registry's status time) says which
 * source would have been *faster* on the observations where both were right.
 * A disagreement is not automatically a spaceterm bug: the registry is also
 * wrong sometimes, and telling those apart is exactly what days of paired
 * samples are for.
 *
 * Edge-triggered, so a quiet fleet writes nothing: an unchanged observation is
 * dropped, and only `status` / `waitingFor` / `statusUpdatedAt` / our own state
 * count as change. `updatedAt` deliberately does not — it churns on unrelated
 * registry writes (session renames, socket paths) and would bury the signal.
 *
 * The same pass reports the current status to `onStatus`, which puts it in the
 * card footer beside the state we inferred. That is display, not inference: the
 * two are shown together so a disagreement is visible while it is happening
 * rather than only in the log afterwards. Reporting is deduped separately from
 * logging, because a log line is warranted whenever *either* side moves while a
 * footer only needs redrawing when the registry's half does.
 */

import * as fs from 'fs'
import * as path from 'path'
import { SESSION_STATUS_LOG_DIR } from '../../shared/protocol'
import { localISOTimestamp } from '../timestamp'
import type { PtySessionId, ClaudeSessionId } from '../../shared/ids'
import type { AgentType } from '../../shared/agent-type'
import type { ClaudeState } from './types'
import {
  readSessionRegistry,
  REAL_SESSION_REGISTRY_DEPS,
  type CcSessionStatus,
  type SessionRegistryDeps,
  type SessionRegistryRecord
} from './session-registry'

/**
 * How often (ms) to compare. The registry is a handful of small files and the
 * read is gated on a change before anything is written, so 2s is cheap; it is
 * also fine enough to measure lag against hooks, which arrive within ~500ms of
 * their event.
 */
const OBSERVE_INTERVAL_MS = 2_000

/** What the observer needs to know about a surface to pair it with a registry record. */
export interface ObservedSurface {
  surfaceId: PtySessionId
  /** The Claude session currently running on this surface, if any. */
  claudeSessionId: ClaudeSessionId | null
  agentType: AgentType
  state: ClaudeState
  /** Epoch ms at which we decided `state`, if known. */
  stateDecidedAt?: number
}

export type Agreement = 'agree' | 'disagree' | 'no-opinion'

/**
 * Reports a surface's current registry status for display. `null` when the
 * registry has no record for the surface (its process is gone, or this Claude
 * Code is too old to publish one) or no usable status in it — the footer must
 * then show nothing rather than the last value it saw, which would be a claim
 * about a session that no longer exists.
 *
 * Null rather than undefined because the value ends up on a node and crosses
 * the socket as JSON, where undefined fields are dropped and a clear would
 * silently do nothing. See `ccStatus` in shared/state.ts.
 */
export type OnSessionStatus = (
  surfaceId: PtySessionId,
  status: CcSessionStatus | null,
  waitingFor: string | null
) => void

export interface SessionStatusObservation {
  timestamp: string
  surfaceId: PtySessionId
  claudeSessionId: ClaudeSessionId
  pid: number
  /** Claude Code's own view. */
  cc: {
    status?: CcSessionStatus
    waitingFor?: string
    statusUpdatedAt?: string
    kind?: string
    procStart?: string
  }
  /** Ours, at the same moment. */
  spaceterm: {
    state: ClaudeState
    decidedAt?: string
  }
  agreement: Agreement
  /**
   * Our decision time minus the registry's status time, in ms. Positive means
   * the registry got there first. Absent when either timestamp is missing.
   */
  lagMs?: number
}

/**
 * The states a given registry status is consistent with — i.e. the hypothesis
 * under test, written once so the observation log and any future transition
 * logic cannot drift apart.
 *
 * `busy` covers `working_background` as well as `working`: a surface whose main
 * turn is over but whose subagents are still running is `busy` to Claude Code,
 * which has no equivalent of the yellow distinction. `idle` covers
 * `potential_error` for the same reason — that is a stopped turn we have
 * annotated, not a different liveness. `shell` has no counterpart at all.
 */
export function expectedStates(status: CcSessionStatus | undefined): readonly ClaudeState[] | null {
  switch (status) {
    case 'busy':
      return ['working', 'working_background']
    case 'waiting':
      return ['waiting_permission', 'waiting_question', 'waiting_plan']
    case 'idle':
      return ['stopped', 'potential_error']
    default:
      // 'shell' (the user is in a subshell) and an absent/unrecognised status
      // are both "the registry is not answering this question".
      return null
  }
}

export function agreementOf(status: CcSessionStatus | undefined, state: ClaudeState): Agreement {
  const expected = expectedStates(status)
  if (expected === null) return 'no-opinion'
  return expected.includes(state) ? 'agree' : 'disagree'
}

/** The writes and reads the observer makes outside itself, seamed for tests. */
export interface SessionStatusObserverDeps {
  registry: SessionRegistryDeps
  append(surfaceId: PtySessionId, line: string): void
  scheduleInterval(fn: () => void, ms: number): () => void
  now(): number
}

export const REAL_SESSION_STATUS_OBSERVER_DEPS: SessionStatusObserverDeps = {
  registry: REAL_SESSION_REGISTRY_DEPS,
  append(surfaceId, line) {
    fs.appendFile(path.join(SESSION_STATUS_LOG_DIR, `${surfaceId}.jsonl`), line, () => {
      // fire-and-forget, exactly like the decision log
    })
  },
  scheduleInterval(fn, ms) {
    const timer = setInterval(fn, ms)
    return () => clearInterval(timer)
  },
  now: () => Date.now()
}

/**
 * The fields whose change makes an observation worth writing.
 *
 * `claudeSessionId` is in here so a *new* Claude session on the same surface
 * always logs a baseline, even if it happens to open on the same status as the
 * one it replaced. Identity, rather than the record's presence, is what marks a
 * new life: a record can also vanish for a tick because the file was mid-write
 * or the read raced its rename, and re-logging an unchanged pairing after that
 * would be noise dressed up as an event.
 */
function fingerprint(record: SessionRegistryRecord, state: ClaudeState): string {
  return [
    record.claudeSessionId,
    record.status ?? '-',
    record.waitingFor ?? '-',
    record.statusUpdatedAt ?? '-',
    state
  ].join('|')
}

export class SessionStatusObserver {
  private readonly deps: SessionStatusObserverDeps
  private readonly listSurfaces: () => ObservedSurface[]
  private readonly onStatus: OnSessionStatus
  private cancel: (() => void) | null = null
  /** surfaceId → last written fingerprint, so an unchanged tick writes nothing. */
  private lastLogged = new Map<PtySessionId, string>()
  /** surfaceId → last reported `status|waitingFor`, so an unchanged tick redraws nothing. */
  private lastReported = new Map<PtySessionId, string>()

  constructor(
    listSurfaces: () => ObservedSurface[],
    onStatus: OnSessionStatus,
    deps: SessionStatusObserverDeps = REAL_SESSION_STATUS_OBSERVER_DEPS
  ) {
    this.listSurfaces = listSurfaces
    this.onStatus = onStatus
    this.deps = deps
    if (deps === REAL_SESSION_STATUS_OBSERVER_DEPS) {
      fs.mkdirSync(SESSION_STATUS_LOG_DIR, { recursive: true })
    }
    this.cancel = deps.scheduleInterval(() => this.observe(), OBSERVE_INTERVAL_MS)
  }

  dispose(): void {
    this.cancel?.()
    this.cancel = null
  }

  /** One comparison pass. Public so a test can drive it without a timer. */
  observe(): void {
    const surfaces = this.listSurfaces()
    // Only read the registry when some surface could be joined to it.
    const claudeSurfaces = surfaces.filter((s) => s.agentType === 'claude' && s.claudeSessionId !== null)
    if (claudeSurfaces.length === 0) return

    const registry = readSessionRegistry(this.deps.registry)
    const seen = new Set<PtySessionId>()

    for (const surface of claudeSurfaces) {
      seen.add(surface.surfaceId)
      const record = registry.get(surface.claudeSessionId as ClaudeSessionId)

      // Report first, and report the absence too: a surface whose record has
      // gone must clear its footer rather than keep showing a dead session's
      // last status.
      const reported = [record?.status ?? '-', record?.waitingFor ?? '-'].join('|')
      if (this.lastReported.get(surface.surfaceId) !== reported) {
        this.lastReported.set(surface.surfaceId, reported)
        this.onStatus(surface.surfaceId, record?.status ?? null, record?.waitingFor ?? null)
      }

      // No record is the normal state for a session whose process has exited,
      // and for a Claude Code too old to publish one. Neither is a *pairing*,
      // so there is nothing to log.
      if (record === undefined) continue

      const mark = fingerprint(record, surface.state)
      if (this.lastLogged.get(surface.surfaceId) === mark) continue
      this.lastLogged.set(surface.surfaceId, mark)

      const observation: SessionStatusObservation = {
        timestamp: localISOTimestamp(this.deps.now()),
        surfaceId: surface.surfaceId,
        claudeSessionId: record.claudeSessionId,
        pid: record.pid,
        cc: {
          ...(record.status !== undefined && { status: record.status }),
          ...(record.waitingFor !== undefined && { waitingFor: record.waitingFor }),
          ...(record.statusUpdatedAt !== undefined && {
            statusUpdatedAt: localISOTimestamp(record.statusUpdatedAt)
          }),
          ...(record.kind !== undefined && { kind: record.kind }),
          ...(record.procStart !== undefined && { procStart: record.procStart })
        },
        spaceterm: {
          state: surface.state,
          ...(surface.stateDecidedAt !== undefined && {
            decidedAt: localISOTimestamp(surface.stateDecidedAt)
          })
        },
        agreement: agreementOf(record.status, surface.state),
        ...(record.statusUpdatedAt !== undefined &&
          surface.stateDecidedAt !== undefined && {
            lagMs: surface.stateDecidedAt - record.statusUpdatedAt
          })
      }

      this.deps.append(surface.surfaceId, JSON.stringify(observation) + '\n')
    }

    // Forget surfaces that are gone (closed, or switched away from Claude), so
    // a reincarnated one logs a fresh baseline and redraws its footer rather
    // than being deduped against a previous life.
    for (const surfaceId of this.lastLogged.keys()) {
      if (!seen.has(surfaceId)) this.lastLogged.delete(surfaceId)
    }
    for (const surfaceId of this.lastReported.keys()) {
      if (!seen.has(surfaceId)) this.lastReported.delete(surfaceId)
    }
  }
}
