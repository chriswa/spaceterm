import type { NodeData } from '../shared/state'
import type { NodeId } from '../shared/ids'
import { isTaskNotificationPrompt } from './claude-state/background-ledger'

/**
 * Names for forked surfaces. A fork starts as `[fork]`; its first real prompt
 * is sent to Haiku together with the parent's title, and the reply becomes
 * `[fork] <title>`.
 */

export const FORK_LABEL = '[fork]'

/** Asked of the model; the cap below gives it one word of slack before cutting. */
const TARGET_TITLE_WORDS = 5
const MAX_TITLE_WORDS = 6
const MAX_TITLE_CHARS = 60
/** Enough of a long prompt to say what it is about. */
const MAX_PROMPT_CHARS = 4000

/** Remove a leading `[fork]`, so forking a fork does not stack prefixes. */
export function stripForkLabel(name: string): string {
  let rest = name.trim()
  while (rest.toLowerCase().startsWith(FORK_LABEL)) rest = rest.slice(FORK_LABEL.length).trim()
  return rest
}

/** `[fork]`, or `[fork] <title>` when there is a title. */
export function forkName(title?: string | null): string {
  const rest = title ? stripForkLabel(title) : ''
  return rest ? `${FORK_LABEL} ${rest}` : FORK_LABEL
}

/**
 * What the source surface is called: its custom name, else the newest title
 * the agent CLI set on the terminal.
 */
export function surfaceTitle(node: NodeData): string | null {
  const name = node.name ? stripForkLabel(node.name) : ''
  if (name) return name
  if (node.type !== 'terminal') return null
  return node.shellTitleHistory?.find(t => t.trim())?.trim() ?? null
}

/**
 * Whether a submitted prompt is something the user wrote about the work.
 * Task notifications are Claude re-invoking itself, and a slash command says
 * nothing about what the fork is for; both wait for the next prompt.
 */
export function isNamingPrompt(prompt: unknown): prompt is string {
  if (typeof prompt !== 'string') return false
  const text = prompt.trim()
  return text.length > 0 && !text.startsWith('/') && !isTaskNotificationPrompt(text)
}

export function buildForkTitlePrompt(parentTitle: string | null, prompt: string): string {
  const clipped = prompt.length > MAX_PROMPT_CHARS ? prompt.slice(0, MAX_PROMPT_CHARS) + '…' : prompt
  return [
    'A coding-agent session was forked: the new session starts with the whole conversation of the original, then goes its own way.',
    `Write a title for the new session of at most ${TARGET_TITLE_WORDS} words.`,
    'It should say what the new session is doing, so it can be told apart from the original, while keeping enough of the original\'s subject to show they are related.',
    'Reply with the title only: no quotes, no trailing punctuation, no "fork".',
    '',
    `Original session's title: ${parentTitle ?? '(none)'}`,
    '',
    'First message sent to the new session:',
    '<message>',
    clipped,
    '</message>',
  ].join('\n')
}

/** The title in a model reply, cut to length, or null when there is none. */
export function parseForkTitleReply(raw: string): string | null {
  const line = raw.split('\n').map(l => l.trim()).find(l => l.length > 0)
  if (!line) return null
  let title = stripForkLabel(
    line
      .replace(/\p{C}/gu, '')
      .replace(/^(title:\s*)/i, '')
      .replace(/^["'`*]+|["'`*]+$/g, '')
      .replace(/[.!?:;,]+$/, ''),
  ).trim()
  title = title.split(/\s+/).slice(0, MAX_TITLE_WORDS).join(' ')
  if (title.length > MAX_TITLE_CHARS) title = title.slice(0, MAX_TITLE_CHARS).trimEnd()
  return title || null
}

export interface ForkTitlerDeps {
  /** One Haiku turn; resolves to the reply text. */
  ask(prompt: string): Promise<string>
  getNode(nodeId: NodeId): NodeData | undefined
  clearPending(nodeId: NodeId): void
  rename(nodeId: NodeId, name: string): void
  log(message: string): void
}

export class ForkTitler {
  constructor(private readonly deps: ForkTitlerDeps) {}

  /**
   * Called for every submitted prompt. Acts once per fork, on the first prompt
   * that passes {@link isNamingPrompt}; a failed call leaves the fork `[fork]`
   * rather than retrying on later prompts.
   *
   * Resolves when the fork has been named, or nothing is to be done.
   */
  async onPrompt(nodeId: NodeId, prompt: unknown): Promise<void> {
    const node = this.deps.getNode(nodeId)
    if (node?.type !== 'terminal' || !node.pendingForkTitle) return
    if (!isNamingPrompt(prompt)) return
    const { parentTitle } = node.pendingForkTitle
    this.deps.clearPending(nodeId)
    // Renamed by hand before the first prompt: that name stands.
    if (node.name !== FORK_LABEL) return

    let title: string | null
    try {
      const reply = await this.deps.ask(buildForkTitlePrompt(parentTitle, prompt))
      title = parseForkTitleReply(reply)
      if (!title) this.deps.log(`[fork-title] ${nodeId.slice(0, 8)}: unusable reply ${JSON.stringify(reply.slice(0, 200))}`)
    } catch (err) {
      this.deps.log(`[fork-title] ${nodeId.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`)
      return
    }
    if (!title) return
    // Renamed by hand while Haiku was answering: that name stands too.
    if (this.deps.getNode(nodeId)?.name !== FORK_LABEL) return
    this.deps.rename(nodeId, forkName(title))
  }
}
