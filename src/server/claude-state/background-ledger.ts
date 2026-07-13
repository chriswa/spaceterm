/**
 * Background-work ledger
 *
 * Tracks work that outlives a Claude *turn* — backgrounded subagents, `Bash`
 * commands launched with run_in_background, `Monitor` tasks, and `Workflow`
 * runs. Claude Code fires a `Stop` hook when the main turn ends, but that turn
 * can end while this work is still running (the Agent tool backgrounds
 * subagents by default). Without this ledger we'd show the surface as
 * `stopped` (white) and play the completion tone while Claude is really still
 * busy. When the ledger is non-empty at `Stop`, the state machine shows
 * `working_background` (yellow) instead.
 *
 * Design (ported from ~/voiceop's TranscriptWatcher, adapted to spaceterm's
 * event-driven, server-side model):
 *
 * - Subagents are tracked from the reliable `SubagentStart`/`SubagentStop`
 *   hooks (paired by agent_id) — cleaner than voiceop's transcript scraping,
 *   which we only need for the kinds that have no hook.
 *
 * - bash/monitor/workflow are tracked by regex-matching the transcript's
 *   tool_result text for launch acks, and the injected <task-notification>
 *   blocks for completions. These ack strings are Claude-Code-version
 *   dependent (see the fixtures in background-ledger.test.ts).
 *
 * - Correctness does NOT depend on catching every completion string. Liveness
 *   probes (lsof / pgrep / subagent-transcript tail / workflow state file) are
 *   the source of truth: a launch whose completion we never parse is still
 *   drained by the next reconciliation sweep. Completion parsing is only an
 *   optimization that drains the yellow state faster than the sweep interval.
 *
 * Unlike voiceop (which re-scans the whole transcript on every poll and
 * therefore needs byte offsets + a resolved-id cache), spaceterm ingests the
 * transcript delta once per append. So a launch ack is seen exactly once and a
 * resolved launch is simply removed from the map — no positions, no caching.
 */

import { execFile } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import type { SessionFileEntry } from '../session-file-watcher'

export type LaunchKind = 'bash' | 'agent' | 'monitor' | 'workflow'

interface Launch {
  id: string
  kind: LaunchKind
  /** bash only: the .output file its process tree holds open (lsof probe target) */
  outputPath?: string
  /** workflow only: the wf_… id naming its on-disk state file */
  runId?: string
  /**
   * Completion was enqueued but not yet delivered to the agent. The work is
   * finished, but the surface must keep muting (stay outstanding) until the
   * notification is delivered — delivery re-invokes the agent, so we are
   * genuinely still "busy" until then. Matches voiceop: queued launches are
   * never probed.
   */
  queued: boolean
}

/**
 * Liveness probes are injectable so the ledger is unit-testable without
 * shelling out. All probes answer the question "is this launch FINISHED?" and
 * follow a fail-safe rule: on any uncertainty (probe failed to run, file
 * unreadable) they resolve `false` (still running). Reporting "still running"
 * too long only keeps the indicator yellow a bit longer; reporting "finished"
 * too early would fire the completion tone while Claude is still working.
 *
 * Probes are async so a slow/hung lsof or pgrep can never block the server's
 * event loop (which is also servicing PTY and websocket traffic).
 */
export interface LivenessProbes {
  bashFinished(outputPath: string): Promise<boolean>
  monitorFinished(sessionId: string): Promise<boolean>
  agentFinished(subagentTranscriptPath: string): Promise<boolean>
  workflowFinished(stateFilePath: string): Promise<boolean>
}

// ─── Launch-ack / completion patterns (from voiceop) ────────────────────────
//
// Matched ONLY against tool_result text for launches, and against injected
// <task-notification> text for completions — never raw prose — so that code or
// documentation that merely mentions these phrases can't register a phantom,
// never-completing launch.

/** `Command running in background with ID: <id>. Output is being written to: <path>.output` */
const BASH_LAUNCH = /Command running in background with ID: ([a-z0-9]+)\. Output is being written to: (.+?\.output)/
/** `Monitor started (task <id>, timeout Nms)` or `Monitor started (task <id>)` — persistent monitors omit the timeout */
const MONITOR_LAUNCH = /Monitor started \(task ([a-z0-9]+)[,)]/
/** A workflow ack carries BOTH the task id (what notifications key on) and the run id (what its state file is named after) — requiring both hardens against echoed fragments */
const WORKFLOW_LAUNCH_ID = /Workflow launched in background\. Task ID: ([a-z0-9]+)/
const WORKFLOW_RUN_ID = /Run ID: (wf_[a-z0-9-]+)/
/**
 * Completion requires <status> to be present alongside the id: a persistent
 * monitor's per-EVENT notifications carry <task-id> but no <status>, and must
 * not be mistaken for the monitor's own completion.
 */
const DONE_TASK_ID = /<task-id>([a-z0-9]+)<\/task-id>/g

// ─── Default (real) probes ──────────────────────────────────────────────────

const PROBE_TIMEOUT_MS = 2000

/**
 * Run a probe subprocess and resolve its exit status (null on spawn failure).
 * lsof/pgrep both exit 0 when a match exists and 1 when none does, so the
 * caller maps status to a finished/running verdict.
 */
function probeExit(cmd: string, args: string[]): Promise<number | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: PROBE_TIMEOUT_MS }, (err) => {
      if (!err) return resolve(0)
      // execFile surfaces the process exit code on err.code (a number) for a
      // clean non-zero exit; a string code (e.g. 'ENOENT'/'ETIMEDOUT') means
      // the probe itself failed to run.
      resolve(typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : null)
    })
  })
}

/**
 * lsof exits 0 while any process still holds the file open, 1 once nothing
 * does. A background bash's process tree keeps its .output file open until it
 * exits, so "not held open" == finished. Missing file == finished (nothing to
 * hold open). Spawn failure == treat as still running (fail-safe).
 */
async function realBashFinished(outputPath: string): Promise<boolean> {
  if (!fs.existsSync(outputPath)) return true
  const status = await probeExit('/usr/sbin/lsof', ['-t', '--', outputPath])
  if (status === null) return false
  return status !== 0
}

/**
 * pgrep matches any live process whose command line carries this session's
 * CLAUDE_SESSION_ID env var. Coarse by design (voiceop): a monitor reads as
 * "still running" whenever any shell for the session is alive. Spawn failure
 * == still running (fail-safe).
 */
async function realMonitorFinished(sessionId: string): Promise<boolean> {
  const status = await probeExit('/usr/bin/pgrep', ['-f', `CLAUDE_SESSION_ID=${sessionId}`])
  if (status === null) return false
  return status !== 0
}

/**
 * A subagent is finished when the last `assistant` entry in its own transcript
 * has stop_reason === 'end_turn'. We read only the tail (8 KB) because the
 * verdict is in the final entry. Missing file == finished (the subagent hasn't
 * or won't produce more). Unreadable / no marker == not finished (fail-safe).
 */
async function realAgentFinished(subagentTranscriptPath: string): Promise<boolean> {
  if (!fs.existsSync(subagentTranscriptPath)) return true
  try {
    const fd = fs.openSync(subagentTranscriptPath, 'r')
    try {
      const size = fs.fstatSync(fd).size
      const start = size > 8192 ? size - 8192 : 0
      const buf = Buffer.alloc(size - start)
      fs.readSync(fd, buf, 0, size - start, start)
      const lines = buf.toString('utf-8').split('\n')
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i]
        if (!line) continue
        try {
          const e = JSON.parse(line)
          if (e && e.type === 'assistant' && e.message) {
            return e.message.stop_reason === 'end_turn'
          }
        } catch {
          // partial/non-JSON tail line — keep scanning older lines
        }
      }
      return false
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return false
  }
}

/** The per-run workflow state file is written (with status + result) only when the run ends, so its existence == finished. */
async function realWorkflowFinished(stateFilePath: string): Promise<boolean> {
  return fs.existsSync(stateFilePath)
}

const REAL_PROBES: LivenessProbes = {
  bashFinished: realBashFinished,
  monitorFinished: realMonitorFinished,
  agentFinished: realAgentFinished,
  workflowFinished: realWorkflowFinished,
}

// ─── Per-surface state ──────────────────────────────────────────────────────

interface SurfaceLedger {
  launches: Map<string, Launch>
  /** Directory containing the main transcript — used to locate subagent/workflow files for probes */
  transcriptDir?: string
  sessionId?: string
}

// ─── Ledger ─────────────────────────────────────────────────────────────────

export class BackgroundLedger {
  private surfaces = new Map<string, SurfaceLedger>()
  private probes: LivenessProbes

  constructor(probes: LivenessProbes = REAL_PROBES) {
    this.probes = probes
  }

  private get(surfaceId: string): SurfaceLedger {
    let s = this.surfaces.get(surfaceId)
    if (!s) { s = { launches: new Map() }; this.surfaces.set(surfaceId, s) }
    return s
  }

  /**
   * Capture the transcript path + session id (carried by SubagentStart/Stop and
   * Stop hook payloads). Needed to build subagent/workflow probe paths and to
   * run the monitor pgrep. Cheap to call on every relevant hook.
   */
  setContext(surfaceId: string, transcriptPath: string | undefined, sessionId: string | undefined): void {
    const s = this.get(surfaceId)
    if (transcriptPath) s.transcriptDir = path.dirname(transcriptPath)
    if (sessionId) s.sessionId = sessionId
  }

  /** SubagentStart(agent_id) — register (or re-register, on resume) a background subagent. */
  registerAgent(surfaceId: string, agentId: string): void {
    this.get(surfaceId).launches.set(agentId, { id: agentId, kind: 'agent', queued: false })
  }

  /** SubagentStop(agent_id) — the subagent finished; drop it. */
  completeAgent(surfaceId: string, agentId: string): void {
    this.get(surfaceId).launches.delete(agentId)
  }

  /** How many background launches are still outstanding on this surface. */
  outstandingCount(surfaceId: string): number {
    return this.surfaces.get(surfaceId)?.launches.size ?? 0
  }

  /**
   * Clear all tracking for a surface. Called on UserPromptSubmit (a new turn
   * makes prior background context moot, and bounds any leak from a missed
   * completion to "until the next prompt") and on SessionEnd.
   */
  clear(surfaceId: string): void {
    this.surfaces.get(surfaceId)?.launches.clear()
  }

  /**
   * Parse a batch of new (non-backfill) transcript entries for bash/monitor/
   * workflow launches and for completion notifications. Agents are intentionally
   * NOT parsed here — they're tracked via hooks, whose agent_id lives in a
   * different id-space than the transcript's <task-id>, so mixing the two would
   * double-count.
   */
  ingestJsonl(surfaceId: string, entries: SessionFileEntry[]): void {
    const s = this.get(surfaceId)
    for (const entry of entries) {
      // Queued-but-undelivered completions: the work is done but the agent
      // hasn't been notified yet — keep it outstanding until delivery.
      if (entry.type === 'queue-operation') {
        if (entry.operation === 'enqueue' && typeof entry.content === 'string') {
          for (const id of completedTaskIds(entry.content)) {
            const l = s.launches.get(id)
            if (l) l.queued = true
          }
        }
        continue
      }

      const toolResult = toolResultText(entry)
      if (toolResult) trackLaunches(toolResult, s.launches)

      // Completions arrive in injected <task-notification> blocks, which are
      // written as non-assistant (user/system) entries. Delivered completion =
      // remove the launch.
      if (entry.type !== 'assistant') {
        const text = toolResult || entryText(entry)
        for (const id of completedTaskIds(text)) {
          s.launches.delete(id)
        }
      }
    }
  }

  /**
   * Probe outstanding launches whose completion we haven't parsed and prune any
   * the OS says are finished. This is the correctness backstop: a launch whose
   * completion string we never matched is drained here. Queued launches are
   * never probed (their work is done; we're only awaiting delivery).
   *
   * Returns true if any launch was pruned (so the caller can re-check whether
   * the surface just went idle).
   */
  async reconcile(surfaceId: string): Promise<boolean> {
    const s = this.surfaces.get(surfaceId)
    if (!s || s.launches.size === 0) return false

    let pruned = false
    for (const launch of Array.from(s.launches.values())) {
      if (launch.queued) continue
      let finished = false
      switch (launch.kind) {
        case 'bash':
          finished = launch.outputPath ? await this.probes.bashFinished(launch.outputPath) : false
          break
        case 'monitor':
          finished = s.sessionId ? await this.probes.monitorFinished(s.sessionId) : false
          break
        case 'agent':
          finished = s.transcriptDir && s.sessionId
            ? await this.probes.agentFinished(path.join(s.transcriptDir, s.sessionId, 'subagents', `agent-${launch.id}.jsonl`))
            : false
          break
        case 'workflow':
          finished = s.transcriptDir && s.sessionId && launch.runId
            ? await this.probes.workflowFinished(path.join(s.transcriptDir, s.sessionId, 'workflows', `${launch.runId}.json`))
            : false
          break
      }
      // The launch may have been delivered/cleared by a concurrent ingest while
      // we awaited the probe — only prune if it's still present.
      if (finished && s.launches.delete(launch.id)) {
        pruned = true
      }
    }
    return pruned
  }

  /** surfaceIds that currently have outstanding launches — used to scope the reconciliation sweep. */
  activeSurfaces(): string[] {
    const out: string[] = []
    for (const [id, s] of Array.from(this.surfaces.entries())) {
      if (s.launches.size > 0) out.push(id)
    }
    return out
  }
}

// ─── Parsing helpers ────────────────────────────────────────────────────────

/** Extract the concatenated text of all tool_result blocks in an entry (string or nested-text form). */
function toolResultText(entry: SessionFileEntry): string {
  const msg = entry.message as { content?: unknown } | undefined
  const content = msg?.content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    const b = block as { type?: string; content?: unknown }
    if (b.type !== 'tool_result') continue
    if (typeof b.content === 'string') {
      parts.push(b.content)
    } else if (Array.isArray(b.content)) {
      for (const inner of b.content) {
        if (inner && typeof inner === 'object' && (inner as { type?: string }).type === 'text') {
          const t = (inner as { text?: unknown }).text
          if (typeof t === 'string') parts.push(t)
        }
      }
    }
  }
  return parts.join('\n')
}

/** Best-effort full text of an entry (string content, or joined text/tool_result blocks) for completion scanning. */
function entryText(entry: SessionFileEntry): string {
  const msg = entry.message as { content?: unknown } | undefined
  const content = msg?.content
  if (typeof content === 'string') return content
  return toolResultText(entry)
}

/** Register bash/monitor/workflow launches found in tool_result text. First-match-wins per id (idempotent across re-reads). */
function trackLaunches(text: string, launches: Map<string, Launch>): void {
  const bash = BASH_LAUNCH.exec(text)
  if (bash) {
    const [, id, outputPath] = bash
    if (!launches.has(id)) launches.set(id, { id, kind: 'bash', outputPath, queued: false })
    return
  }
  const monitor = MONITOR_LAUNCH.exec(text)
  if (monitor) {
    const [, id] = monitor
    if (!launches.has(id)) launches.set(id, { id, kind: 'monitor', queued: false })
    return
  }
  const wfId = WORKFLOW_LAUNCH_ID.exec(text)
  const wfRun = WORKFLOW_RUN_ID.exec(text)
  if (wfId && wfRun) {
    const id = wfId[1]
    if (!launches.has(id)) launches.set(id, { id, kind: 'workflow', runId: wfRun[1], queued: false })
  }
}

/** Task ids in a completion notification. Gated on <status> so per-event monitor pings (which lack it) don't count as completion. */
function completedTaskIds(text: string): string[] {
  if (!text.includes('<status>')) return []
  const ids: string[] = []
  DONE_TASK_ID.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = DONE_TASK_ID.exec(text)) !== null) ids.push(m[1])
  return ids
}
