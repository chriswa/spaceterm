import * as fs from 'fs'
import { speakableToolText } from './speakable-tool-text'

/**
 * An agent's transcript — Claude Code's, Cursor's or Codex's JSONL — as the
 * messages a listener could be told about: what the user said, what the agent
 * said, and runs of tool calls condensed into one line of activity each.
 * Control reads agents through this (receptionist/roster.ts), as does agent
 * search.
 */

export type TranscriptMessage = { role: 'user' | 'assistant'; text: string }

/** At most this many messages in the recent window `readTranscript` gives. */
const MAX_MESSAGES = 24
/** And at most this many characters, besides the latest user message. */
const MAX_CHARS = 48_000
/**
 * How many of a run's tool calls are named individually.
 *
 * The tail, not the head: "what is it doing now" is the question Control is
 * asked, and the newest calls are the ones that answer it. The rest
 * are counted rather than dropped silently — a trace that quietly truncated
 * would read as a complete account of a much smaller run.
 */
const TOOL_RUN_LISTED = 10
/** Per-call budget. Long enough to identify a target, short enough to stay speakable. */
const TOOL_TARGET_CHARS = 90
/**
 * Marks a synthetic message as a record of what the agent *did*.
 *
 * Explicit because these lines enter the same list as things the agent *said*,
 * and an account that reports a shell command as a statement is worse than
 * one that omits it.
 */
const TOOL_ACTIVITY_MARKER = '[agent tool activity, not speech]'
export function readTranscript(filePath: string): TranscriptMessage[] {
  let raw: string
  try { raw = fs.readFileSync(filePath, 'utf8') } catch { return [] }
  return parseTranscript(raw)
}

/**
 * Select the speakable messages from a raw JSONL transcript.
 *
 * Split from readTranscript so the selection rules — which agent shapes count
 * as human speech, and how much backwards context fits — can be tested against
 * fixture text rather than files on disk.
 */
export function parseTranscript(raw: string): TranscriptMessage[] {
  return selectSpeakable(parseWholeTranscript(raw))
}

/**
 * Every message in a transcript, in the same shape `readTranscript` gives but
 * without its window — for searching the early hours of a long session.
 */
export function readWholeTranscript(filePath: string): TranscriptMessage[] {
  let raw: string
  try { raw = fs.readFileSync(filePath, 'utf8') } catch { return [] }
  return parseWholeTranscript(raw)
}

export function parseWholeTranscript(raw: string): TranscriptMessage[] {
  const extracted: Extracted[] = []
  for (const line of raw.split('\n')) {
    if (!line) continue
    try {
      extracted.push(...extractEntry(JSON.parse(line) as Record<string, any>))
    } catch { /* Ignore a partial JSONL write. */ }
  }
  return coalesceToolRuns(extracted)
}

/**
 * One tool call, reduced to what a listener would want to hear about it.
 *
 * The name alone is nearly useless — "the agent ran thirty-five Bash commands"
 * describes a night of work and a typo equally well. The target is what carries
 * the meaning, so it is kept and bounded rather than dropped.
 */
type ToolCall = { name: string; target?: string }

/**
 * What one transcript entry yields.
 *
 * Two kinds because tool calls have to be *coalesced* before they can become
 * messages, and coalescing needs to see the run. An entry can yield both: an
 * agent that says something and then calls a tool writes one entry per block,
 * but older transcripts put them together.
 */
type Extracted =
  | { kind: 'message'; role: 'user' | 'assistant'; text: string }
  | { kind: 'tools'; calls: ToolCall[] }

/**
 * Turn runs of tool calls into one synthetic assistant message each.
 *
 * Coalescing is the whole point. A long unattended run is exactly what a
 * listener most wants an account of, and it is also the run with the least
 * prose: one observed turn spent six minutes on 35 shell calls and 24 thinking
 * blocks while emitting a single sentence, so the transcript offered two
 * speakable messages and the model reported that nothing had been decided. Emitting
 * one message *per call* would have been worse than nothing — 35 messages would
 * have consumed the entire budget and pushed the prose out of the window.
 *
 * Thinking blocks cannot help here: the transcript stores a signature with the
 * text empty, so there is nothing in them to read.
 */
function coalesceToolRuns(items: Extracted[]): TranscriptMessage[] {
  const messages: TranscriptMessage[] = []
  let run: ToolCall[] = []
  const flush = (): void => {
    if (!run.length) return
    messages.push({ role: 'assistant', text: renderToolRun(run) })
    run = []
  }
  for (const item of items) {
    if (item.kind === 'tools') { run.push(...item.calls); continue }
    // Prose closes the run it follows, so the trace stays in step with the
    // narration around it rather than collapsing a whole turn into one blob.
    flush()
    messages.push({ role: item.role, text: item.text })
  }
  flush()
  return messages
}

function renderToolRun(calls: ToolCall[]): string {
  const counts = new Map<string, number>()
  for (const call of calls) counts.set(call.name, (counts.get(call.name) ?? 0) + 1)
  const tally = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, count]) => (count > 1 ? `${name} x${count}` : name))
    .join(', ')
  const listed = calls.slice(-TOOL_RUN_LISTED)
  const omitted = calls.length - listed.length
  const plural = (n: number): string => (n === 1 ? 'call' : 'calls')
  const header = `${TOOL_ACTIVITY_MARKER} ${calls.length} ${plural(calls.length)}: ${tally}.`
  const elision = omitted ? `\n(${omitted} earlier ${plural(omitted)} not listed.)` : ''
  const lines = listed.map(call => (call.target ? `- ${call.name}: ${call.target}` : `- ${call.name}`))
  return `${header}${elision}\n${lines.join('\n')}`
}

/**
 * The most identifying string in a tool's input.
 *
 * A priority-ordered key sweep rather than a per-tool table: the table would be
 * a second list of tool names to keep in step with Claude Code, and would go
 * quietly wrong for every tool added after it was written. This ordering reads
 * the right field for each of the tools that actually appear — `file_path` for
 * Read and Edit, `pattern` for Grep and Glob, `command` for Bash, `url` for
 * WebFetch, `description` for Task, `skill` for Skill — and degrades to "no target" rather than to
 * a wrong one.
 */
const TOOL_TARGET_KEYS = [
  'skill', 'file_path', 'notebook_path', 'pattern', 'command', 'url', 'path', 'description', 'query', 'prompt',
]

function toolTarget(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined
  for (const key of TOOL_TARGET_KEYS) {
    const raw = (input as Record<string, unknown>)[key]
    // Codex passes a shell invocation as an argv array; everything else is a
    // string. Both describe one target, so both render as one.
    const value = Array.isArray(raw)
      ? raw.filter((part): part is string => typeof part === 'string').join(' ')
      : raw
    if (typeof value !== 'string' || !value.trim()) continue
    // Commands are routinely multi-line. A trace that kept the newlines would
    // break the one-line-per-call shape this is readable because of.
    const collapsed = value.trim().replace(/\s+/g, ' ')
    return collapsed.length > TOOL_TARGET_CHARS ? `${collapsed.slice(0, TOOL_TARGET_CHARS)}…` : collapsed
  }
  return undefined
}

/**
 * Narrow a whole transcript to its recent window.
 *
 * One message is not optional: the latest user message. It is the *anchor*,
 * where the current piece of work starts. Everything else is history, and
 * history competes for a budget newest-first: the agent's most recent output,
 * which is what the listener is asking about, then older background if room
 * remains.
 *
 * The anchor is exempt from *both* caps. Exempt from `MAX_CHARS` alone, a
 * surface whose latest turn ran past 24 agent messages — exactly the long
 * unattended run a listener most wants an account of — selected 24 assistant
 * messages and no user message, and so no turn at all. Holding every other
 * message to the same two caps is what keeps the rule small enough to state.
 */
function selectSpeakable(all: TranscriptMessage[]): TranscriptMessage[] {
  const anchor = all.map(message => message.role).lastIndexOf('user')
  if (anchor < 0) return []
  const kept = new Set<number>([anchor])
  // The anchor is exempt, and that now means exempt rather than merely
  // un-evictable. It used to be kept *and* charged, which let a long pasted
  // user message spend the whole budget on itself and leave the agent's reply
  // — the thing the listener actually wants to hear — outside the window. Exempting it costs at most one message's overrun, which is the
  // price the exemption was always going to have.
  let chars = 0
  /** Take one message if both budgets allow; false means this direction is done. */
  const admit = (index: number): boolean => {
    if (kept.has(index)) return true
    if (kept.size >= MAX_MESSAGES) return false
    if (chars + all[index].text.length > MAX_CHARS) return false
    kept.add(index)
    chars += all[index].text.length
    return true
  }
  // The agent's final message goes in before anything else competes for room.
  // It is what the listener asks about, so it is the last thing that should
  // lose a budget fight — but it still fights, because a run of two hundred
  // prose entries is a real transcript shape and exempting it outright would
  // hand over the whole history.
  const run = finalAgentRun(all, anchor)
  for (let i = run.length - 1; i >= 0; i--) if (!admit(run[i])) break
  for (let i = all.length - 1; i > anchor; i--) if (!admit(i)) break
  for (let i = anchor - 1; i >= 0; i--) if (!admit(i)) break
  return Array.from(kept).sort((a, b) => a - b).map(index => all[index])
}

/**
 * Indices of the trailing run of agent prose, newest-last.
 *
 * "The agent's final message" is a run rather than one entry because Claude Code
 * writes each content block as its own transcript entry: a message interrupted
 * by nothing at all still arrives in pieces. The run ends at the first thing
 * that is not the agent talking — a user turn, or a record of work it did — so
 * a reply is rejoined while the tool calls that preceded it stay out.
 *
 * Stops at `after` so it can never reach back past the anchor, which is what
 * keeps a transcript with no agent reply from returning the whole history.
 */
function finalAgentRun(all: TranscriptMessage[], after = -1): number[] {
  const run: number[] = []
  for (let i = all.length - 1; i > after; i--) {
    const message = all[i]
    if (message.role !== 'assistant') break
    if (isToolActivity(message)) break
    run.unshift(i)
  }
  return run
}

/**
 * The agent's final message, as one speakable string, or '' when its last act
 * was a tool call rather than a sentence.
 *
 * An empty result is an ordinary state — the agent is still working — and the
 * caller reports it as such rather than as an unreadable transcript.
 */
export function finalAgentMessage(messages: TranscriptMessage[]): string {
  return finalAgentRun(messages).map(index => messages[index].text).join('\n\n')
}

/** Whether a message is a record of tool calls rather than words the agent wrote. */
export function isToolActivity(message: TranscriptMessage): boolean {
  return message.role === 'assistant' && message.text.startsWith(TOOL_ACTIVITY_MARKER)
}

/**
 * The agent's last words, even when tool calls came after them — '' only when
 * nothing it wrote since the last user turn. An agent that says "committing
 * and ending now" and then self-terminates leaves no message after its last
 * tool call, and `finalAgentMessage` would report that as silence.
 */
export function lastAgentProse(messages: TranscriptMessage[]): string {
  let end = messages.length
  while (end > 0 && isToolActivity(messages[end - 1])) end--
  return finalAgentMessage(messages.slice(0, end))
}

function extractEntry(entry: Record<string, any>): Extracted[] {
  // Claude Code files what it injects — a loaded skill's whole SKILL.md, above
  // all — as a user turn marked `isMeta`. Taken as speech, it became the
  // anchor: an agent that ended by loading self-terminate read back as its
  // prompt and then the skill's text, as though the user had pasted it.
  if (entry.isMeta === true) return []
  // Claude's transcript shape, and Cursor's, which differ only in whether the
  // role sits on `type` or `role`.
  const role = entry.type === 'user' || entry.type === 'assistant' ? entry.type
    : entry.role === 'user' || entry.role === 'assistant' ? entry.role
      : undefined
  if (role && entry.message) return fromContent(role, entry.message.content)
  // Codex writes a separate canonical user_message event. Using it avoids
  // accidentally treating its injected environment/developer context as human
  // speech. Assistant output remains in response_item messages.
  if (entry.type === 'event_msg' && entry.payload?.type === 'user_message' && typeof entry.payload.message === 'string') {
    const text = entry.payload.message.trim()
    return text ? [{ kind: 'message', role: 'user', text }] : []
  }
  // Codex rollout shape. Its current recorder emits a human turn as a
  // response_item message, rather than the older user_message event above.
  // Do not accept every `role: user` item: Codex injects environment context
  // through that same role. `user.text` is the recorder's explicit marker for
  // text the human supplied, and keeps that setup out of the spoken history.
  if (entry.type === 'response_item' && entry.payload?.type === 'message') {
    if (entry.payload.role === 'assistant') return fromContent('assistant', entry.payload.content)
    if (entry.payload.role === 'user' && isCodexHumanMessage(entry.payload)) {
      return fromContent('user', entry.payload.content)
    }
    return []
  }
  // Codex records a tool call as its own entry, with the input as a JSON string
  // rather than an object — the one shape difference that matters here.
  if (entry.type === 'response_item' && entry.payload?.type === 'function_call') {
    const call = codexFunctionCall(entry.payload)
    return call ? [{ kind: 'tools', calls: [call] }] : []
  }
  return []
}

/** Whether a Codex `response_item` user message is actual human input. */
function isCodexHumanMessage(payload: Record<string, any>): boolean {
  const kinds = payload.internal_chat_message_metadata_passthrough?.content_item_kinds
  return Array.isArray(kinds) && kinds.includes('user.text')
}

function codexFunctionCall(payload: Record<string, any>): ToolCall | undefined {
  if (typeof payload.name !== 'string' || !payload.name) return undefined
  let input: unknown
  try {
    input = typeof payload.arguments === 'string' ? JSON.parse(payload.arguments) : payload.arguments
  } catch { /* An unparseable argument string still leaves a usable tool name. */ }
  return { name: payload.name, target: toolTarget(input) }
}

/**
 * Split one message's content blocks into what was said and what was done.
 *
 * The two are separated here rather than downstream because only this point can
 * see both: `speakableToolText` promotes the handful of tools whose input *is*
 * the message back into speech, and everything else it declines becomes
 * activity. Without that split a plan would be filed as a shell command, and a
 * shell command would be quoted as though the agent had said it.
 */
function fromContent(role: 'user' | 'assistant', content: unknown): Extracted[] {
  if (typeof content === 'string') {
    const text = content.trim()
    return text ? [{ kind: 'message', role, text }] : []
  }
  if (!Array.isArray(content)) return []
  const spokenParts: string[] = []
  const calls: ToolCall[] = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    const type = (block as { type?: unknown }).type
    if (type === 'text' || type === 'input_text' || type === 'output_text') {
      const text = (block as { text?: unknown }).text
      if (typeof text === 'string' && text.trim()) spokenParts.push(text.trim())
      continue
    }
    if (type !== 'tool_use') continue
    const { name, input } = block as { name?: unknown; input?: unknown }
    const spoken = speakableToolText(name, input)
    if (spoken) { spokenParts.push(spoken); continue }
    // Only the agent acts. A `tool_use` under a user role would be a shape this
    // code does not understand, and inventing activity from it would be worse
    // than ignoring it.
    if (role === 'assistant' && typeof name === 'string' && name) {
      calls.push({ name, target: toolTarget(input) })
    }
  }
  const out: Extracted[] = []
  // Speech first: an agent narrates, then acts, and the trace reads as the
  // consequence of the sentence above it.
  if (spokenParts.length) out.push({ kind: 'message', role, text: spokenParts.join('\n\n') })
  if (calls.length) out.push({ kind: 'tools', calls })
  return out
}
