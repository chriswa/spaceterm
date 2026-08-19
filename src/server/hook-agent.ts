import { homedir } from 'os'
import * as path from 'path'
import type { AgentType } from '../shared/agent-type'

/** Where each agent writes its transcript, used to attribute a hook to an agent. */
const TRANSCRIPT_ROOTS: ReadonlyArray<{ agent: AgentType; root: string }> = [
  { agent: 'claude', root: path.join(homedir(), '.claude', 'projects') },
  { agent: 'cursor', root: path.join(homedir(), '.cursor', 'projects') },
  { agent: 'codex', root: path.join(homedir(), '.codex', 'sessions') },
]

/**
 * Which agent emitted a hook or status-line payload — or undefined when the
 * shape is not distinctive enough to tell.
 *
 * One surface can carry hooks from more than one agent: a `cursor-agent` run
 * started inside a Claude terminal fires its own SessionStart on the Claude
 * surface's id. Attributing that Cursor session to the surface points the Claude
 * transcript watcher at a `.claude/.../<cursor-id>.jsonl` that is never written,
 * and pollutes the surface's resume history with an id its own agent cannot
 * resume. The reliable discriminator is where the agent says it writes its
 * transcript; Cursor additionally stamps `cursor_version`/`conversation_id` on
 * payloads whose SessionStart omits the path.
 */
export function hookPayloadAgentType(payload: Record<string, unknown> | undefined): AgentType | undefined {
  if (!payload) return undefined
  const transcriptPath = typeof payload.transcript_path === 'string' ? payload.transcript_path : undefined
  if (transcriptPath) {
    for (const { agent, root } of TRANSCRIPT_ROOTS) {
      if (isUnder(transcriptPath, root)) return agent
    }
  }
  if (typeof payload.cursor_version === 'string' || typeof payload.conversation_id === 'string') return 'cursor'
  return undefined
}

/**
 * Whether a hook payload was emitted by an agent other than the surface's own.
 *
 * Deliberately conservative: only a *confidently* foreign hook — one we can
 * attribute to a known agent that is not the surface's — counts. An
 * unclassifiable payload, or a surface whose agent is not yet known, is treated
 * as belonging to the surface so nothing that used to be recorded stops being.
 */
export function isForeignAgentHook(
  payload: Record<string, unknown> | undefined,
  surfaceAgent: AgentType | undefined,
): boolean {
  const emitting = hookPayloadAgentType(payload)
  return emitting !== undefined && surfaceAgent !== undefined && emitting !== surfaceAgent
}

function isUnder(filePath: string, root: string): boolean {
  const rel = path.relative(root, filePath)
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}
