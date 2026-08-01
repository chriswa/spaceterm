import * as fs from 'fs'
import * as path from 'path'
import { HOOK_LOG_DIR } from '../shared/protocol'
import { sessionFilePath } from './session-fork'
import { asClaudeSessionId, asPtySessionId, type ClaudeSessionId, type NodeId, type PtySessionId } from '../shared/ids'

/**
 * Deciding which agent session a terminal should resume.
 *
 * Four paths ask this question — restart, unarchive, startup revive and
 * restart-recovery — and getting it wrong is not a cosmetic failure: resume the
 * wrong id and the user gets someone else's conversation, resume a
 * non-existent one and the surface dies on launch and gets archived.
 *
 * The logic is subtle in ways that are not obvious from the call sites, which
 * is why it now lives here with tests:
 *
 * - **Ghost session ids accumulate.** A revival can start Claude, get a
 *   SessionStart hook (registering a new id), then crash before the transcript
 *   is written. Picking the newest id blindly makes every subsequent restart
 *   pick the same ghost and fail the same way — a cascading failure that looks
 *   like the terminal is simply broken.
 * - **For Cursor and Codex, history is the *least* trustworthy source.** A
 *   botched restart can leave a ghost in `claudeSessionHistory` while the hook
 *   log still holds the real chat id, so live and hook-log signals win.
 * - **The hook log is probed twice, under two different names.** Hook logs are
 *   named after the pty session that wrote them, and a terminal's first pty
 *   session id *is* its node id. The second probe therefore reaches the log
 *   from before the terminal was ever restarted, which after a botched restart
 *   may be the only surviving record of the real chat id.
 */

export interface ResumeTargetDeps {
  /** True when the Claude transcript for this (cwd, session) pair is on disk. */
  transcriptExists(cwd: string, claudeSessionId: ClaudeSessionId): boolean
  /** A surface's hook log, oldest line first. Empty when there is no log. */
  readHookLog(surfaceId: PtySessionId): string[]
}

export const REAL_RESUME_TARGET_DEPS: ResumeTargetDeps = {
  transcriptExists: (cwd, claudeSessionId) => fs.existsSync(sessionFilePath(cwd, claudeSessionId)),

  readHookLog(surfaceId) {
    const logPath = path.join(HOOK_LOG_DIR, `${surfaceId}.jsonl`)
    if (!fs.existsSync(logPath)) return []
    try {
      return fs.readFileSync(logPath, 'utf8').split('\n')
    } catch (err: any) {
      // Unreadable is not fatal — the caller falls through to recorded
      // history — but it is worth saying, because the fallback silently
      // produces a worse answer.
      console.error(`[resume-target] Failed to read hook log for ${surfaceId.slice(0, 8)}: ${err.message}`)
      return []
    }
  }
}

/** The shape of a node this module needs. Deliberately narrower than TerminalNodeData. */
export interface ResumableSurface {
  id: NodeId
  sessionId: PtySessionId
  claudeSessionHistory?: Array<{ claudeSessionId: ClaudeSessionId }>
  terminalSessions?: Array<{ claudeSessionId?: ClaudeSessionId }>
}

/** Most recent agent chat id recorded for a surface, whichever agent it runs. */
export function lastAgentSessionId(
  history: Array<{ claudeSessionId: ClaudeSessionId }>
): ClaudeSessionId | undefined {
  return history.length > 0 ? history[history.length - 1].claudeSessionId : undefined
}

/**
 * Pull an agent chat id out of a hook or status-line payload.
 *
 * Claude calls it `session_id`; Cursor calls it `conversation_id`. Returns the
 * empty string rather than undefined because the ingest path treats `''` as
 * "nothing recorded" throughout.
 */
export function agentSessionIdFromPayload(
  payload: Record<string, unknown> | undefined
): ClaudeSessionId | '' {
  if (!payload) return ''
  if (typeof payload.session_id === 'string' && payload.session_id) return asClaudeSessionId(payload.session_id)
  if (typeof payload.conversation_id === 'string' && payload.conversation_id) return asClaudeSessionId(payload.conversation_id)
  return ''
}

/** Hook kinds that carry a *main* conversation id, newest-first search order. */
const TURN_LEVEL_HOOKS = new Set(['UserPromptSubmit', 'Stop', 'status-line', 'SessionStart'])

/**
 * Last-resort: read the most recent main-session id out of a surface's hook log.
 *
 * Only turn-level events count. `PreToolUse` in particular carries *subagent*
 * conversation ids, and resuming one of those drops the user into a subagent's
 * transcript instead of their own.
 */
export function peekAgentSessionIdFromHookLog(
  surfaceId: PtySessionId,
  deps: ResumeTargetDeps = REAL_RESUME_TARGET_DEPS
): ClaudeSessionId | undefined {
  const lines = deps.readHookLog(surfaceId)
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line) continue
    let entry: { hookType?: string; type?: string; payload?: Record<string, unknown> }
    try {
      entry = JSON.parse(line)
    } catch {
      // A partially written final line is normal — the log is appended to by a
      // shell script that may be killed mid-write.
      continue
    }
    if (!TURN_LEVEL_HOOKS.has(entry.hookType || entry.type || '')) continue
    const sessionId = agentSessionIdFromPayload(entry.payload)
    if (sessionId) return sessionId
  }
  return undefined
}

/**
 * Resolve a Cursor/Codex chat id to resume, across restart / unarchive / revive.
 *
 * Preference order — live signal, then either hook log, then recorded history,
 * then per-terminal-session records. History comes late on purpose: see the
 * ghost-id note at the top of this file.
 */
export function resolveNonClaudeResumeId(
  node: ResumableSurface,
  liveAgentSessionId?: ClaudeSessionId | null,
  deps: ResumeTargetDeps = REAL_RESUME_TARGET_DEPS
): ClaudeSessionId | undefined {
  if (liveAgentSessionId) return liveAgentSessionId

  const fromHook =
    peekAgentSessionIdFromHookLog(node.sessionId, deps)
    ?? peekAgentSessionIdFromHookLog(asPtySessionId(node.id), deps)
  if (fromHook) return fromHook

  const fromHistory = lastAgentSessionId(node.claudeSessionHistory ?? [])
  if (fromHistory) return fromHistory

  const sessions = node.terminalSessions ?? []
  for (let i = sessions.length - 1; i >= 0; i--) {
    const id = sessions[i].claudeSessionId
    if (id) return id
  }
  return undefined
}

/**
 * Walk backwards through a terminal's Claude session history for the most
 * recent session whose transcript still exists on disk.
 *
 * Returns undefined when none does — which is a real answer, not a failure:
 * the caller re-archives rather than launching a surface that will die.
 *
 * With no cwd there is nothing to check against, so the newest recorded id is
 * returned unverified. That is a deliberate best-effort: a terminal with no
 * recorded cwd is rare, and refusing to resume it would be worse than trying.
 */
export function findValidClaudeSession(
  history: Array<{ claudeSessionId: ClaudeSessionId }>,
  cwd: string | undefined,
  deps: ResumeTargetDeps = REAL_RESUME_TARGET_DEPS
): ClaudeSessionId | undefined {
  if (!cwd || history.length === 0) return lastAgentSessionId(history)
  for (let i = history.length - 1; i >= 0; i--) {
    const id = history[i].claudeSessionId
    if (deps.transcriptExists(cwd, id)) return id
  }
  return undefined
}
