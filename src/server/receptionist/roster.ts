import * as path from 'path'
import type { NodeId } from '../../shared/ids'
import type { ClaudeState } from '../../shared/state'
import { isToolActivity, lastAgentProse, type TranscriptMessage } from '../agent-transcript'
import { agentToken } from './agent-token'

/**
 * What the receptionist knows about the agents, and the transcript reading its
 * `read` tool does.
 *
 * Only live Claude Code surfaces are agents here. Archived surfaces, Codex and
 * Cursor surfaces, and plain terminals are not in the roster at all — the
 * receptionist cannot mention what it is never shown.
 */

/** One live agent surface, as the server sees it at the start of a turn. */
export interface RosterAgent {
  nodeId: NodeId
  title: string
  cwd?: string
  state: ClaudeState
  transcriptPath?: string
  /** The surface's current Claude Code session, which a fork branches from. */
  claudeSessionId?: string
  /** The agent finished or changed state since the user last looked at it. */
  unread?: boolean
  /** epoch ms — when the agent entered its current state: for a stopped one, when it finished. */
  stateSince?: number
  /** epoch ms — the last time the agent itself did anything. Keystrokes do not count. */
  lastActivityAt?: number
  /** epoch ms — when the agent's prompt cache goes cold; continuing it before then is cheap. */
  cacheWarmUntil?: number
  /** How much context that cache holds: what going cold would cost to rebuild. */
  cacheWarmTokens?: number
  /** epoch ms — when the surface's first Claude session started. */
  startedAt?: number
  /** False when its Claude Code predates side questions and cannot take ask_agent until restarted; undefined when unknown. */
  takesSideQuestions?: boolean
  /** The name other Claude Code sessions message it by with SendMessage, such as `spaceterm-43`: see `claude-peer-names`. */
  messagingId?: string
}

/** Characters of an agent's last message that agent_details shows. */
const DETAILS_LAST_MESSAGE_CHARS = 1_500
/** Characters of the request that message answered. */
const DETAILS_LAST_REQUEST_CHARS = 500
/**
 * Characters of conversation one page of `read` holds. Pages hold whole
 * messages, newest first, and the rest are a "before" away: Control's session
 * keeps every result until compaction, so a long transcript is paged rather
 * than handed over at once.
 */
const READ_PAGE_CHARS = 10_000
/**
 * The longest single message `read` or an event shows; past it, a note says
 * how much was left out. Only a pasted log or a dump runs this long, and a
 * page always holds at least one message, so this is what bounds a page.
 */
export const MESSAGE_CHARS = 40_000

export const STATE_WORDS: Record<ClaudeState, string> = {
  stopped: 'stopped, waiting for the user',
  working: 'working',
  working_background: 'waiting on a background task',
  waiting_permission: 'waiting for permission',
  waiting_question: 'asking the user a question',
  waiting_plan: 'waiting for plan approval',
  potential_error: 'possibly stuck on an error',
}

/** Said of an agent whose Claude Code started before side questions existed. */
export const NO_SIDE_QUESTIONS = 'ask_agent: unavailable — it was started before side questions existed, and takes them after a restart'

/**
 * The list_agents roster: one line per agent, most worth checking first, with
 * only what a glance across every agent needs — who it is, whether it has
 * news, what it is doing, and whether its cache is warm. It is called often
 * and stays in Control's session until compaction, so everything else about
 * an agent is left to agent_details, for the one agent that needs it.
 */
export function renderRoster(
  agents: readonly RosterAgent[],
  nameOf: (nodeId: NodeId) => string | undefined,
  handleOf: (nodeId: NodeId) => string,
  now = Date.now(),
): string {
  if (!agents.length) return 'No agents are running.'
  return [...agents].sort(byRelevance).map(agent => {
    const fields = [`${agentHeading(agent, nameOf, handleOf)}: ${agent.title}`]
    if (agent.unread) fields.push('UNREAD')
    fields.push(`state: ${stateWords(agent, now)}`)
    if (agent.cacheWarmUntil !== undefined) fields.push(`cache: ${cacheWords(agent, now)}`)
    return fields.join(' | ')
  }).join('\n')
}

/**
 * The agent_details tool: one agent in depth — what the roster shows, and
 * what it leaves out, up to the start of its last exchange.
 */
export function renderAgentDetails(
  agent: RosterAgent,
  nameOf: (nodeId: NodeId) => string | undefined,
  messages: TranscriptMessage[],
  handleOf: (nodeId: NodeId) => string,
  /** Where it sits on the canvas, outermost first: see `pathWords`. */
  under?: string,
  now = Date.now(),
): string {
  const lines = [`${agentHeading(agent, nameOf, handleOf)}: ${agent.title}`]
  if (agent.unread) lines.push('  UNREAD: it has news the user has not looked at')
  if (under) lines.push(`  under: ${under}`)
  if (agent.cwd) lines.push(`  directory: ${path.basename(agent.cwd)}`)
  lines.push(`  state: ${stateWords(agent, now)}`)
  if (agent.lastActivityAt) lines.push(`  last active: ${ago(now - agent.lastActivityAt)} ago`)
  if (agent.cacheWarmUntil !== undefined) lines.push(`  cache: ${cacheWords(agent, now)}`)
  if (agent.takesSideQuestions === false) lines.push(`  ${NO_SIDE_QUESTIONS}`)
  if (agent.startedAt) lines.push(`  started: ${ago(now - agent.startedAt)} ago`)
  if (agent.messagingId) lines.push(`  messaging id: ${agent.messagingId}`)
  const request = lastUserMessage(messages)
  if (request) lines.push(`  last asked: ${clip(request, DETAILS_LAST_REQUEST_CHARS)}`)
  const reply = lastAgentProse(messages)
  if (reply) lines.push(`  last said: ${clip(reply, DETAILS_LAST_MESSAGE_CHARS)}`)
  return lines.join('\n')
}

function agentHeading(agent: RosterAgent, nameOf: (nodeId: NodeId) => string | undefined, handleOf: (nodeId: NodeId) => string): string {
  const name = nameOf(agent.nodeId)
  return `${agentToken(handleOf(agent.nodeId), name)}${name ? '' : ' (no name yet)'}`
}

function stateWords(agent: RosterAgent, now: number): string {
  return `${STATE_WORDS[agent.state]}${agent.stateSince ? `, for ${ago(now - agent.stateSince)}` : ''}`
}

/**
 * Most worth checking first: news the user has not seen, then whatever moved
 * most recently. The order is the answer to "what should I look at?", so the
 * model reads the list top down instead of having to rank it.
 */
function byRelevance(a: RosterAgent, b: RosterAgent): number {
  if (Boolean(a.unread) !== Boolean(b.unread)) return a.unread ? -1 : 1
  return (b.lastActivityAt ?? b.stateSince ?? 0) - (a.lastActivityAt ?? a.stateSince ?? 0)
}

/** The agent's prompt cache, as list_agents and read report it: whether ask_agent is cheap now. */
export function cacheWords(agent: Pick<RosterAgent, 'cacheWarmUntil' | 'cacheWarmTokens'>, now: number): string {
  const until = agent.cacheWarmUntil ?? 0
  const size = agent.cacheWarmTokens ? ` (${Math.round(agent.cacheWarmTokens / 1000)}k tokens)` : ''
  return until > now ? `warm for ${ago(until - now)} more${size}` : `cold for ${ago(now - until)}${size}`
}

/** What decides whether an ended agent can be asked. */
export type EndedCache = Pick<RosterAgent, 'claudeSessionId' | 'cwd' | 'cacheWarmUntil' | 'cacheWarmTokens'>

/**
 * Whether an agent that has ended can still be asked: only from a warm cache,
 * which its session is resumed headless to read (`ended-side-question.ts`).
 * Cold, asking it would pay for its whole conversation again, so it is
 * brought back with unarchive_agent instead, and only when the user agrees.
 */
export function endedAskable(agent: EndedCache, now: number): boolean {
  return Boolean(agent.claudeSessionId && agent.cwd) && agent.cacheWarmUntil !== undefined && agent.cacheWarmUntil > now
}

/** What read and the ended news say of an ended agent's cache: whether ask_agent can still reach it. */
export function endedCacheWords(agent: EndedCache, now: number): string {
  if (endedAskable(agent, now)) {
    return `This agent has ended, but its cache is ${cacheWords(agent, now)}, so ask_agent can still ask it without bringing it back.`
  }
  const cache = agent.cacheWarmUntil !== undefined ? `its cache is ${cacheWords(agent, now)}` : 'its cache is unknown'
  return `This agent has ended and ${cache}, so ask_agent cannot reach it: answer from its transcript. ` +
    'Asking it means bringing it back with unarchive_agent first, which only the user can agree to.'
}

/** A duration as it would be said: "40 seconds", "12 minutes", "3 hours 5 minutes", "2 days". */
export function ago(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds} seconds`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    const rest = minutes % 60
    return `${hours} hour${hours === 1 ? '' : 's'}${rest ? ` ${rest} minute${rest === 1 ? '' : 's'}` : ''}`
  }
  const days = Math.round(hours / 24)
  return `${days} day${days === 1 ? '' : 's'}`
}

/**
 * The `read` tool: one page of an agent's conversation, or of the messages
 * matching a search, newest first. A plain read leaves out tool calls, so its
 * pages go to what the agent and user said; a search covers both, and the
 * whole session.
 *
 * Messages are never cut short to fit a page — an agent's words are read in
 * order to be quoted, and a list missing its first entry, or an answer missing
 * its end, cannot be — and their line breaks are kept, so a list still reads
 * as one. Each message carries its number in the transcript, and `before`
 * takes one: the page that ends just before it. Numbers rather than page
 * counts, so that a working agent writing more between two reads does not
 * shift the page asked for.
 */
export function readAgent(messages: readonly TranscriptMessage[], { search, before }: { search?: string; before?: number } = {}): string {
  const numbered = messages.map((message, index) => ({ message, number: index + 1 }))
  const candidates = search
    ? matching(numbered, search)
    : numbered.filter(({ message }) => !isToolActivity(message))
  const earlier = before === undefined ? candidates : candidates.filter(({ number }) => number < before)
  if (!earlier.length) {
    if (before !== undefined && candidates.length) return `Nothing ${search ? 'matching' : 'readable'} before message ${before}.`
    return search ? `No passage mentions "${search}".` : 'Nothing readable in this transcript yet.'
  }
  const page: string[] = []
  let chars = 0
  let next = earlier.length - 1
  for (; next >= 0; next--) {
    const line = `[${earlier[next].number}] ${speakerLabel(earlier[next].message)}: ${capMessage(earlier[next].message.text)}`
    // At least one message, however long: a page that held nothing would never move.
    if (page.length && chars + line.length > READ_PAGE_CHARS) break
    page.unshift(line)
    chars += line.length
  }
  const oldest = earlier[next + 1].number
  const what = search ? 'matching messages' : 'messages'
  const footer = next >= 0
    ? `(${next + 1} earlier ${what} not shown: read again with "before": ${oldest} for the page before this one.)`
    : search ? '(No earlier matching messages.)' : '(No earlier messages: this reaches the start of the conversation.)'
  return `${page.join('\n\n')}\n\n${footer}`
}

/**
 * The messages a search finds: those with every word in it, or, when none has
 * them all, those with any. Whole messages are returned, so a loose match
 * costs a page of unrelated text; any word alone is the fallback, not the rule.
 */
function matching<T extends { message: TranscriptMessage }>(messages: readonly T[], search: string): T[] {
  const terms = search.toLowerCase().split(/\s+/).filter(Boolean)
  const lower = messages.map(({ message }) => message.text.toLowerCase())
  const all = messages.filter((_, i) => terms.every(term => lower[i].includes(term)))
  return all.length ? all : messages.filter((_, i) => terms.some(term => lower[i].includes(term)))
}

/** A message whole, unless it runs past `MESSAGE_CHARS`, in which case a note says how much is missing. */
export function capMessage(text: string): string {
  if (text.length <= MESSAGE_CHARS) return text
  return `${text.slice(0, MESSAGE_CHARS)}\n[… ${text.length - MESSAGE_CHARS} more characters of this message not shown]`
}

function speakerLabel(message: TranscriptMessage): string {
  return message.role === 'user' ? 'USER' : 'AGENT'
}

/**
 * What the user last asked, skipping what Claude Code injects as user turns —
 * `<task-notification>` and its kin, which arrive tagged — since "last asked"
 * is meant to say what the agent was set to do.
 */
function lastUserMessage(messages: readonly TranscriptMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user' && !messages[i].text.trimStart().startsWith('<')) return messages[i].text
  }
  return undefined
}

function clip(text: string, chars: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= chars ? flat : `${flat.slice(0, chars - 1)}…`
}
