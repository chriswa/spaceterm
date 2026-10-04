import * as path from 'path'
import type { NodeId } from '../../shared/ids'
import type { ClaudeState } from '../../shared/state'
import { finalAgentMessage, type TranscriptMessage } from '../summary-chat'
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

/** A directory node on the canvas: somewhere a new agent can be started. */
export interface RosterDirectory {
  nodeId: NodeId
  cwd: string
}

export function renderDirectories(directories: readonly RosterDirectory[], handleOf: (nodeId: NodeId) => string): string {
  return directories.map(directory => `[${handleOf(directory.nodeId)}] ${directory.cwd}`).join('\n')
}

/** Per-agent characters of the last agent message shown in the roster. */
const ROSTER_LAST_MESSAGE_CHARS = 400
/** Per-agent characters of the request that message answered. */
const ROSTER_LAST_REQUEST_CHARS = 160
/** Characters a `read` returns, newest first, so the end of the turn survives. */
const READ_CHARS = 6_000
const SEARCH_HITS = 6
const SEARCH_CONTEXT_CHARS = 400

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
 * The roster as the model sees it each turn: one block per agent, named if the
 * agent has a name yet. The last request and reply are what lets "the one doing
 * the water simulation" find its agent without a tool call.
 */
export function renderRoster(
  agents: readonly RosterAgent[],
  nameOf: (nodeId: NodeId) => string | undefined,
  readTranscript: (path: string) => TranscriptMessage[],
  handleOf: (nodeId: NodeId) => string,
  now = Date.now(),
): string {
  if (!agents.length) return 'No agents are running.'
  return [...agents].sort(byRelevance).map(agent => {
    const name = nameOf(agent.nodeId)
    const lines = [`${agentToken(handleOf(agent.nodeId), name)}${name ? '' : ' (no name yet)'}: ${agent.title}`]
    if (agent.unread) lines.push('  UNREAD: it has news the user has not looked at')
    if (agent.cwd) lines.push(`  directory: ${path.basename(agent.cwd)}`)
    lines.push(`  state: ${STATE_WORDS[agent.state]}${agent.stateSince ? `, for ${ago(now - agent.stateSince)}` : ''}`)
    if (agent.lastActivityAt) lines.push(`  last active: ${ago(now - agent.lastActivityAt)} ago`)
    if (agent.cacheWarmUntil !== undefined) lines.push(`  cache: ${cacheWords(agent, now)}`)
    if (agent.takesSideQuestions === false) lines.push(`  ${NO_SIDE_QUESTIONS}`)
    if (agent.startedAt) lines.push(`  started: ${ago(now - agent.startedAt)} ago`)
    if (agent.messagingId) lines.push(`  messaging id: ${agent.messagingId}`)
    const messages = agent.transcriptPath ? readTranscript(agent.transcriptPath) : []
    const request = lastUserMessage(messages)
    if (request) lines.push(`  last asked: ${clip(request, ROSTER_LAST_REQUEST_CHARS)}`)
    const reply = finalAgentMessage(messages)
    if (reply) lines.push(`  last said: ${clip(reply, ROSTER_LAST_MESSAGE_CHARS)}`)
    return lines.join('\n')
  }).join('\n')
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
export function cacheWords(agent: RosterAgent, now: number): string {
  const until = agent.cacheWarmUntil ?? 0
  const size = agent.cacheWarmTokens ? ` (${Math.round(agent.cacheWarmTokens / 1000)}k tokens)` : ''
  return until > now ? `warm for ${ago(until - now)} more${size}` : `cold for ${ago(now - until)}${size}`
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
 * The `read` tool: the agent's recent conversation, or the passages matching a
 * search. Only the window the transcript reader keeps is searchable — the same
 * window Summary Chat reads — which covers the current piece of work but not a
 * long session's early hours.
 */
export function readAgent(messages: readonly TranscriptMessage[], search?: string): string {
  if (!messages.length) return 'Nothing readable in this transcript yet.'
  if (search) return searchMessages(messages, search)
  const rendered: string[] = []
  let budget = READ_CHARS
  for (let i = messages.length - 1; i >= 0 && budget > 0; i--) {
    const line = `${speakerLabel(messages[i])}: ${clip(messages[i].text, budget)}`
    rendered.unshift(line)
    budget -= line.length
  }
  return rendered.join('\n\n')
}

function searchMessages(messages: readonly TranscriptMessage[], search: string): string {
  const terms = search.toLowerCase().split(/\s+/).filter(Boolean)
  const hits: string[] = []
  for (let i = messages.length - 1; i >= 0 && hits.length < SEARCH_HITS; i--) {
    const text = messages[i].text
    const lower = text.toLowerCase()
    const at = terms.map(term => lower.indexOf(term)).filter(index => index >= 0).sort((a, b) => a - b)[0]
    if (at === undefined) continue
    const start = Math.max(0, at - SEARCH_CONTEXT_CHARS / 2)
    const excerpt = text.slice(start, start + SEARCH_CONTEXT_CHARS)
    hits.push(`${speakerLabel(messages[i])}: ${start > 0 ? '…' : ''}${excerpt}${start + SEARCH_CONTEXT_CHARS < text.length ? '…' : ''}`)
  }
  return hits.length ? hits.join('\n\n') : `No recent passage mentions "${search}".`
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
