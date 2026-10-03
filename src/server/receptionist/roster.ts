import * as path from 'path'
import type { NodeId } from '../../shared/ids'
import type { ClaudeState } from '../../shared/state'
import { finalAgentMessage, type TranscriptMessage } from '../summary-chat'

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
}

/**
 * The short id the model uses for an agent. Derived from the node id rather
 * than handed out, so it is the same in every turn and survives a restart of
 * the server — the history refers to agents by it.
 */
export function handleFor(nodeId: NodeId): string {
  return `a${nodeId.replace(/[^A-Za-z0-9]/g, '').slice(0, 6).toLowerCase()}`
}

/** The short id the model uses for a directory node. See `handleFor`. */
export function directoryHandleFor(nodeId: NodeId): string {
  return `d${nodeId.replace(/[^A-Za-z0-9]/g, '').slice(0, 6).toLowerCase()}`
}

/** A directory node on the canvas: somewhere a new agent can be started. */
export interface RosterDirectory {
  nodeId: NodeId
  cwd: string
}

export function renderDirectories(directories: readonly RosterDirectory[]): string {
  return directories.map(directory => `[${directoryHandleFor(directory.nodeId)}] ${directory.cwd}`).join('\n')
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

/**
 * The roster as the model sees it each turn: one block per agent, named if the
 * agent has a name yet. The last request and reply are what lets "the one doing
 * the water simulation" find its agent without a tool call.
 */
export function renderRoster(
  agents: readonly RosterAgent[],
  nameOf: (nodeId: NodeId) => string | undefined,
  readTranscript: (path: string) => TranscriptMessage[],
): string {
  if (!agents.length) return 'No agents are running.'
  return agents.map(agent => {
    const name = nameOf(agent.nodeId)
    const lines = [`[${handleFor(agent.nodeId)}]${name ? ` ${name}` : ' (no name yet)'}: ${agent.title}`]
    if (agent.cwd) lines.push(`  directory: ${path.basename(agent.cwd)}`)
    lines.push(`  state: ${STATE_WORDS[agent.state]}`)
    const messages = agent.transcriptPath ? readTranscript(agent.transcriptPath) : []
    const request = lastUserMessage(messages)
    if (request) lines.push(`  last asked: ${clip(request, ROSTER_LAST_REQUEST_CHARS)}`)
    const reply = finalAgentMessage(messages)
    if (reply) lines.push(`  last said: ${clip(reply, ROSTER_LAST_MESSAGE_CHARS)}`)
    return lines.join('\n')
  }).join('\n')
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

function lastUserMessage(messages: readonly TranscriptMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') return messages[i].text
  }
  return undefined
}

function clip(text: string, chars: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= chars ? flat : `${flat.slice(0, chars - 1)}…`
}
