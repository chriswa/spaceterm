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
 * - Probes answer with THREE values, not two (see LivenessVerdict). The original
 *   boolean collapsed "positive evidence it's still running" and "no evidence
 *   either way" into one answer, and since the fail-safe direction is "keep it
 *   outstanding", any launch a probe could never read pinned the surface yellow
 *   until the next user prompt. A user-interrupted subagent hit this exactly:
 *   no SubagentStop hook, and a transcript that can never reach `end_turn`.
 *   Splitting the two lets `running` stay unbounded (a 40-minute workflow must
 *   not drain) while `indeterminate` is bounded by STALE_INDETERMINATE_MS.
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
import type { ClaudeSessionId, PtySessionId } from '../../shared/ids'

export type LaunchKind = 'bash' | 'agent' | 'monitor' | 'workflow'

interface Launch {
  id: string
  kind: LaunchKind
  /** bash only: the .output file its process tree holds open (lsof probe target) */
  outputPath?: string
  /** workflow only: the wf_… id naming its on-disk state file */
  runId?: string
  /**
   * Epoch ms when the completion was enqueued but not yet delivered to the
   * agent, or undefined while the work is still genuinely outstanding.
   *
   * The work is finished, but the surface must keep muting until the
   * notification is delivered — delivery re-invokes the agent, so we are
   * genuinely still "busy" until then. Such a launch is NOT probed: the probe
   * would say 'finished' (it is) and drain it before delivery.
   *
   * It is a timestamp rather than a boolean because that exemption has to be
   * bounded. As a bare flag it was a one-way latch — a queued launch was
   * exempt from probing forever, so a delivery we failed to parse made it
   * immortal and pinned the surface yellow until the next user prompt. Same
   * failure shape as a probe that can never answer, so it gets the same
   * treatment: STALE_INDETERMINATE_MS and then drain.
   */
  queuedSinceMs?: number
  /**
   * Epoch ms of the first consecutive 'indeterminate' probe, cleared whenever a
   * probe answers definitively. Drives the staleness bound in reconcile(): a
   * launch nobody can say anything about must not pin the indicator forever.
   */
  indeterminateSinceMs?: number
}

/**
 * How long (ms) a launch may sit with NO usable evidence before we drain it
 * anyway. Applies to two cases: a probe that keeps answering 'indeterminate',
 * and a queued launch whose delivery we never observe.
 *
 * Only those accrue toward this — a probe that positively reports 'running'
 * resets the clock, so genuinely long background work (a 40-minute workflow, a
 * slow subagent) is never drained early no matter how long it runs. The bound
 * exists solely for launches whose evidence is *gone*: a killed process, an
 * unreadable transcript, an lsof that won't spawn, a notification whose
 * delivery was written in a shape we do not parse.
 *
 * 5 minutes = 60 consecutive no-evidence sweeps at the 5s reconcile interval.
 * Long enough that a transient probe failure (lsof timing out under load)
 * cannot drain real work; short enough that a ghost launch does not outlive the
 * user's attention. Before this bound the only backstop was UserPromptSubmit,
 * i.e. "yellow until you happen to type something".
 */
const STALE_INDETERMINATE_MS = 5 * 60_000

/**
 * What a probe learned about one launch.
 *
 * - `finished`      — positive evidence the work ended. Drain it now.
 * - `running`       — positive evidence it is still going. Keep it outstanding
 *                     indefinitely; this is the answer that must never be
 *                     guessed, since draining live work fires the completion
 *                     tone while Claude is still busy.
 * - `indeterminate` — no evidence either way: the probe could not run, the file
 *                     is unreadable, or the transcript carries no verdict. Still
 *                     fail-safe (the launch stays outstanding), but only for
 *                     STALE_INDETERMINATE_MS, after which it is drained.
 *
 * The distinction that matters is `running` vs `indeterminate`. Both keep the
 * surface yellow right now, so a probe that cannot tell them apart looks
 * correct — until the evidence disappears permanently and the indicator sticks.
 * When a probe is unsure, `indeterminate` is always the honest answer.
 */
export type LivenessVerdict = 'finished' | 'running' | 'indeterminate'

/**
 * Liveness probes are injectable so the ledger is unit-testable without
 * shelling out.
 *
 * Probes are async so a slow/hung lsof or pgrep can never block the server's
 * event loop (which is also servicing PTY and websocket traffic).
 */
export interface LivenessProbes {
  probeBash(outputPath: string): Promise<LivenessVerdict>
  probeMonitor(sessionId: ClaudeSessionId): Promise<LivenessVerdict>
  probeAgent(subagentTranscriptPath: string): Promise<LivenessVerdict>
  probeWorkflow(stateFilePath: string): Promise<LivenessVerdict>
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
 * exits, so "held open" == running and "not held open" == finished. Missing
 * file == finished (nothing to hold open). Spawn failure tells us nothing.
 */
async function realBashProbe(outputPath: string): Promise<LivenessVerdict> {
  if (!fs.existsSync(outputPath)) return 'finished'
  const status = await probeExit('/usr/sbin/lsof', ['-t', '--', outputPath])
  if (status === null) return 'indeterminate'
  return status === 0 ? 'running' : 'finished'
}

/**
 * pgrep matches any live process whose command line carries this session's
 * CLAUDE_SESSION_ID env var. Coarse by design (voiceop): a monitor reads as
 * 'running' whenever any shell for the session is alive. Spawn failure tells us
 * nothing.
 */
async function realMonitorProbe(sessionId: ClaudeSessionId): Promise<LivenessVerdict> {
  const status = await probeExit('/usr/bin/pgrep', ['-f', `CLAUDE_SESSION_ID=${sessionId}`])
  if (status === null) return 'indeterminate'
  return status === 0 ? 'running' : 'finished'
}

/**
 * Tail sizes tried in order when reading a subagent transcript, growing until a
 * verdict is found.
 *
 * A single fixed window was the original bug: 8 KB is usually plenty (the
 * verdict is in the final entries), but one large trailing tool_result pushes
 * the last `assistant` entry out of the window, the scan finds nothing, and the
 * launch is stuck 'indeterminate' forever. Observed at 11 KB from EOF with a
 * single `cat` result. Growing costs nothing in the common case — the 8 KB read
 * decides and we stop — and the cap keeps a pathological transcript from being
 * slurped whole on every 5s sweep.
 */
const AGENT_TAIL_WINDOWS = [8 * 1024, 64 * 1024, 1024 * 1024]

/**
 * A subagent's transcript decides its own liveness:
 *
 * - last `assistant` entry has stop_reason 'end_turn' → it finished its turn.
 * - a `[Request interrupted by user]` text entry AFTER the last assistant entry
 *   → the user killed it. This is terminal and it is the ONLY signal we get:
 *   an interrupt fires no SubagentStop hook, and the transcript stops at
 *   stop_reason 'tool_use', which can never become 'end_turn'. Without this
 *   case an interrupted subagent pins the surface yellow until the next prompt.
 * - any other last `assistant` entry (typically stop_reason 'tool_use') → it is
 *   mid-tool and genuinely running.
 *
 * Missing file == finished (it has not and will not produce more). Unreadable,
 * or no assistant entry within the largest window == indeterminate.
 */
async function realAgentProbe(subagentTranscriptPath: string): Promise<LivenessVerdict> {
  if (!fs.existsSync(subagentTranscriptPath)) return 'finished'
  try {
    const fd = fs.openSync(subagentTranscriptPath, 'r')
    try {
      const size = fs.fstatSync(fd).size
      for (const window of AGENT_TAIL_WINDOWS) {
        const start = size > window ? size - window : 0
        const buf = Buffer.alloc(size - start)
        fs.readSync(fd, buf, 0, size - start, start)
        const verdict = agentTranscriptVerdict(buf.toString('utf-8'))
        // Undecided only means "look further back" while there IS further back.
        if (verdict !== 'indeterminate' || start === 0) return verdict
      }
      return 'indeterminate'
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return 'indeterminate'
  }
}

/**
 * Decide a subagent's liveness from a tail of its transcript. Pure, and
 * exported, so the ordering rules above are testable as data rather than
 * through the filesystem.
 *
 * Scanning runs backwards from the end, so anything seen before reaching the
 * last `assistant` entry is by construction *after* it in the file — that is
 * what makes the interruption check positional without tracking indices.
 */
export function agentTranscriptVerdict(tail: string): LivenessVerdict {
  let interruptedAfterLastAssistant = false
  const lines = tail.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      // A tail read starts mid-line, and a live transcript's last line may be
      // half-written. Both are expected — keep scanning older lines.
      continue
    }
    if (!parsed || typeof parsed !== 'object') continue
    const entry = parsed as { type?: string; message?: { stop_reason?: unknown; content?: unknown } }
    if (entry.type === 'user' && hasInterruptionMarker(entry.message?.content)) {
      interruptedAfterLastAssistant = true
      continue
    }
    if (entry.type === 'assistant' && entry.message) {
      if (entry.message.stop_reason === 'end_turn') return 'finished'
      return interruptedAfterLastAssistant ? 'finished' : 'running'
    }
  }
  // An interrupt with no assistant entry in view is still conclusive.
  return interruptedAfterLastAssistant ? 'finished' : 'indeterminate'
}

/** Text Claude Code writes as a user entry when a turn is interrupted (bare, or `… for tool use`). */
const INTERRUPTION_PREFIX = '[Request interrupted by user'

/**
 * True if this user entry's content carries an interruption marker.
 *
 * Matched only against `text` blocks, never `tool_result` blocks, for the same
 * reason the launch-ack patterns are: a subagent that reads or greps a
 * transcript would otherwise hand us its own bogus interruption.
 */
function hasInterruptionMarker(content: unknown): boolean {
  if (!Array.isArray(content)) return false
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    const b = block as { type?: string; text?: unknown }
    if (b.type !== 'text' || typeof b.text !== 'string') continue
    if (b.text.trimStart().startsWith(INTERRUPTION_PREFIX)) return true
  }
  return false
}

/**
 * The per-run workflow state file is written (with status + result) only when
 * the run ends, so its existence == finished. Absence is the NORMAL condition
 * during a run, so it is 'running' rather than 'indeterminate' — a long
 * workflow must not accrue toward the staleness bound.
 */
async function realWorkflowProbe(stateFilePath: string): Promise<LivenessVerdict> {
  return fs.existsSync(stateFilePath) ? 'finished' : 'running'
}

const REAL_PROBES: LivenessProbes = {
  probeBash: realBashProbe,
  probeMonitor: realMonitorProbe,
  probeAgent: realAgentProbe,
  probeWorkflow: realWorkflowProbe,
}

// ─── Per-surface state ──────────────────────────────────────────────────────

interface SurfaceLedger {
  launches: Map<string, Launch>
  /** Directory containing the main transcript — used to locate subagent/workflow files for probes */
  transcriptDir?: string
  sessionId?: ClaudeSessionId
}

// ─── Ledger ─────────────────────────────────────────────────────────────────

export class BackgroundLedger {
  private surfaces = new Map<PtySessionId, SurfaceLedger>()
  private probes: LivenessProbes

  constructor(probes: LivenessProbes = REAL_PROBES) {
    this.probes = probes
  }

  private get(surfaceId: PtySessionId): SurfaceLedger {
    let s = this.surfaces.get(surfaceId)
    if (!s) { s = { launches: new Map() }; this.surfaces.set(surfaceId, s) }
    return s
  }

  /**
   * Capture the transcript path + session id (carried by SubagentStart/Stop and
   * Stop hook payloads). Needed to build subagent/workflow probe paths and to
   * run the monitor pgrep. Cheap to call on every relevant hook.
   */
  setContext(surfaceId: PtySessionId, transcriptPath: string | undefined, sessionId: ClaudeSessionId | undefined): void {
    const s = this.get(surfaceId)
    if (transcriptPath) s.transcriptDir = path.dirname(transcriptPath)
    if (sessionId) s.sessionId = sessionId
  }

  /** SubagentStart(agent_id) — register (or re-register, on resume) a background subagent. */
  registerAgent(surfaceId: PtySessionId, agentId: string): void {
    this.get(surfaceId).launches.set(agentId, { id: agentId, kind: 'agent' })
  }

  /** SubagentStop(agent_id) — the subagent finished; drop it. */
  completeAgent(surfaceId: PtySessionId, agentId: string): void {
    this.get(surfaceId).launches.delete(agentId)
  }

  /** How many background launches are still outstanding on this surface. */
  outstandingCount(surfaceId: PtySessionId): number {
    return this.surfaces.get(surfaceId)?.launches.size ?? 0
  }

  /**
   * Clear all tracking for a surface. Called on UserPromptSubmit (a new turn
   * makes prior background context moot, and bounds any leak from a missed
   * completion to "until the next prompt") and on SessionEnd.
   */
  clear(surfaceId: PtySessionId): void {
    this.surfaces.get(surfaceId)?.launches.clear()
  }

  /**
   * Parse a batch of new (non-backfill) transcript entries for bash/monitor/
   * workflow launches and for completion notifications. Agents are intentionally
   * NOT parsed here — they're tracked via hooks, whose agent_id lives in a
   * different id-space than the transcript's <task-id>, so mixing the two would
   * double-count.
   */
  ingestJsonl(surfaceId: PtySessionId, entries: SessionFileEntry[], now: number = Date.now()): void {
    const s = this.get(surfaceId)
    for (const entry of entries) {
      // The notification queue is the authoritative delivery signal, and both
      // of its operations matter:
      //   enqueue — the work finished but the agent has not been told yet, so
      //             the launch stays outstanding (and unprobed) until delivery.
      //   anything else (remove/dequeue) — the notification has left the queue,
      //             delivered or cancelled. Either way it will never resolve
      //             again, so the launch is done.
      // Only 'enqueue' used to be handled and everything else hit the `continue`
      // below, which dropped every delivery on the floor: the launch stayed
      // latched as queued, exempt from probing, and immortal. Observed with four
      // background Bash launches whose 'remove' ops landed ~2s after enqueue.
      if (entry.type === 'queue-operation') {
        if (typeof entry.content === 'string') {
          for (const id of completedTaskIds(entry.content)) {
            if (entry.operation === 'enqueue') {
              const l = s.launches.get(id)
              if (l) l.queuedSinceMs ??= now
            } else {
              s.launches.delete(id)
            }
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
   * that have finished — or that nothing has been able to resolve for
   * STALE_INDETERMINATE_MS. This is the correctness backstop: a launch whose
   * completion string we never matched is drained here.
   *
   * The invariant to preserve: EVERY launch is reachable by some drain path.
   * Both bugs this method has had were an unbounded exemption from one — a
   * probe that could never answer 'finished', and a queued launch that was
   * never probed at all. Any new "skip this launch" branch needs its own bound.
   *
   * `now` is a parameter rather than a wall-clock read so the staleness bound is
   * testable without timers.
   *
   * Returns true if any launch was pruned (so the caller can re-check whether
   * the surface just went idle).
   */
  async reconcile(surfaceId: PtySessionId, now: number = Date.now()): Promise<boolean> {
    const s = this.surfaces.get(surfaceId)
    if (!s || s.launches.size === 0) return false

    let pruned = false
    for (const launch of Array.from(s.launches.values())) {
      // Queued: the work is done and a probe would only confirm that, draining
      // it before delivery re-invokes the agent. So skip the probe — but not
      // the clock, or an unparsed delivery makes it immortal.
      if (launch.queuedSinceMs !== undefined) {
        if (now - launch.queuedSinceMs < STALE_INDETERMINATE_MS) continue
        if (s.launches.delete(launch.id)) pruned = true
        continue
      }
      const verdict = await this.probeLaunch(s, launch)

      if (verdict === 'running') {
        // Fresh positive evidence — any earlier no-evidence streak is void.
        launch.indeterminateSinceMs = undefined
        continue
      }
      if (verdict === 'indeterminate') {
        launch.indeterminateSinceMs ??= now
        if (now - launch.indeterminateSinceMs < STALE_INDETERMINATE_MS) continue
        // Held out long enough. Nothing will ever resolve this launch, so
        // draining it beats leaving the surface yellow indefinitely.
      }
      // The launch may have been delivered/cleared by a concurrent ingest while
      // we awaited the probe — only prune if it's still present.
      if (s.launches.delete(launch.id)) {
        pruned = true
      }
    }
    return pruned
  }

  /**
   * Route one launch to its probe. Missing context (no session id, no
   * transcript dir, no output path) is 'indeterminate', not 'running': we
   * cannot look, which is exactly the case the staleness bound exists for.
   */
  private async probeLaunch(s: SurfaceLedger, launch: Launch): Promise<LivenessVerdict> {
    switch (launch.kind) {
      case 'bash':
        return launch.outputPath ? await this.probes.probeBash(launch.outputPath) : 'indeterminate'
      case 'monitor':
        return s.sessionId ? await this.probes.probeMonitor(s.sessionId) : 'indeterminate'
      case 'agent':
        return s.transcriptDir && s.sessionId
          ? await this.probes.probeAgent(path.join(s.transcriptDir, s.sessionId, 'subagents', `agent-${launch.id}.jsonl`))
          : 'indeterminate'
      case 'workflow':
        return s.transcriptDir && s.sessionId && launch.runId
          ? await this.probes.probeWorkflow(path.join(s.transcriptDir, s.sessionId, 'workflows', `${launch.runId}.json`))
          : 'indeterminate'
    }
  }

  /** surfaceIds that currently have outstanding launches — used to scope the reconciliation sweep. */
  activeSurfaces(): PtySessionId[] {
    const out: PtySessionId[] = []
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
    if (!launches.has(id)) launches.set(id, { id, kind: 'bash', outputPath })
    return
  }
  const monitor = MONITOR_LAUNCH.exec(text)
  if (monitor) {
    const [, id] = monitor
    if (!launches.has(id)) launches.set(id, { id, kind: 'monitor' })
    return
  }
  const wfId = WORKFLOW_LAUNCH_ID.exec(text)
  const wfRun = WORKFLOW_RUN_ID.exec(text)
  if (wfId && wfRun) {
    const id = wfId[1]
    if (!launches.has(id)) launches.set(id, { id, kind: 'workflow', runId: wfRun[1] })
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
