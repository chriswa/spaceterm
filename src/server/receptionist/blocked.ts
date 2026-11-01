/**
 * Agents blocked on the user: sitting in a prompt in their terminal that only
 * the user can answer — a permission to use a tool, a question, or approval of
 * a plan. Until it is answered the agent does nothing at all, so Control is
 * told of every one, watched or not (`Receptionist.agentBlocked`), and every
 * turn lists those still blocked (`renderBlocked` in prompt.ts).
 *
 * On 2026-11-01 Molly asked permission to run a `kill`, and Control was told
 * only as one more stop, "is now waiting for permission", with nothing of what
 * she wanted to do: it passed over it in silence, and nothing ever raised it again.
 */

import type { ClaudeState } from '../../shared/state'
import { speakableToolText } from '../speakable-tool-text'

/** The tool call an agent is asking about: the latest PermissionRequest hook's `tool_name` and `tool_input`. */
export interface BlockingPrompt {
  tool: string
  input: unknown
}

export type BlockedState = 'waiting_permission' | 'waiting_question' | 'waiting_plan'

export function isBlocked(state: ClaudeState): state is BlockedState {
  return state === 'waiting_permission' || state === 'waiting_question' || state === 'waiting_plan'
}

/** Characters of a command, path or other input a permission request shows. */
const PERMISSION_DETAIL_CHARS = 400
/** Characters of a question, with its options. */
const QUESTION_CHARS = 1_500
/** Characters of a plan: enough to say what it is, not to read it all aloud. */
const PLAN_CHARS = 1_500

/** The PermissionRequest hook payload's tool call, if it has one. */
export function blockingPrompt(payload: unknown): BlockingPrompt | undefined {
  if (!payload || typeof payload !== 'object') return undefined
  const { tool_name: tool, tool_input: input } = payload as Record<string, unknown>
  return typeof tool === 'string' && tool ? { tool, input } : undefined
}

/** In a few words, what the agent waits on: for the WAITING ON THE USER line. */
export function blockedBrief(state: BlockedState, prompt: BlockingPrompt | undefined): string {
  switch (state) {
    case 'waiting_permission': return prompt ? `for permission to use ${prompt.tool}` : 'for permission to use a tool'
    case 'waiting_question': return 'with a question'
    case 'waiting_plan': return 'for approval of its plan'
  }
}

/**
 * What the agent waits on, in full enough for the user to decide without
 * going to the screen. The prompt is the one the last PermissionRequest
 * carried; without one, as after a server restart, only what kind of prompt.
 */
export function describeBlock(state: BlockedState, prompt: BlockingPrompt | undefined): string {
  switch (state) {
    case 'waiting_permission':
      return prompt ? `it asks permission to use ${prompt.tool}: ${permissionDetail(prompt)}` : 'it asks permission to use a tool'
    case 'waiting_question': {
      const asked = prompt && speakableToolText(prompt.tool, prompt.input)
      return asked ? `it asks the user a question. ${cap(asked, QUESTION_CHARS)}` : 'it asks the user a question'
    }
    case 'waiting_plan': {
      const plan = prompt && speakableToolText(prompt.tool, prompt.input)
      return plan ? `it wants the user to approve its plan. ${cap(plan, PLAN_CHARS)}` : 'it wants the user to approve its plan'
    }
  }
}

/** The part of a tool call that says what it would do: a command, a file, an address. */
function permissionDetail({ tool, input }: BlockingPrompt): string {
  const fields = input && typeof input === 'object' ? input as Record<string, unknown> : {}
  const field = (name: string) => typeof fields[name] === 'string' && (fields[name] as string).trim() ? (fields[name] as string).trim() : undefined
  if (tool === 'Bash') {
    const command = field('command')
    const description = field('description')
    if (command) return `${description ? `${description}, by running ` : 'running '}\`${cap(command, PERMISSION_DETAIL_CHARS)}\``
  }
  const target = field('file_path') ?? field('notebook_path') ?? field('url') ?? field('query') ?? field('path') ?? field('pattern')
  if (target) return cap(target, PERMISSION_DETAIL_CHARS)
  let json: string | undefined
  try { json = JSON.stringify(input) } catch { /* Unserialisable: say nothing of it. */ }
  return json && json !== '{}' ? cap(json, PERMISSION_DETAIL_CHARS) : '(no details given)'
}

function cap(text: string, chars: number): string {
  return text.length > chars ? `${text.slice(0, chars - 1)}…` : text
}
