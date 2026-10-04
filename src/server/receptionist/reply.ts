/**
 * What the receptionist's model says back, and how it becomes speech.
 *
 * The model answers every turn with one JSON object: the parts it wants spoken,
 * and the tools it wants run. JSON rather than real tool use because the model
 * runs through claude-print-daemon's warm `claude -p` processes, which is what
 * keeps a turn near the API's own latency; the price is that the shape is
 * checked here instead of by the API.
 */
import { redactUnheard } from '../summary-chat'

/** Who a spoken part comes from: the receptionist itself, or an agent by handle. */
export const CONTROL = 'control'

export type SayPart = { from: string; text: string }

export type ToolCall =
  | { tool: 'read'; agent: string; search?: string }
  | { tool: 'ask_agent'; agent: string; question: string }
  | { tool: 'monitor'; agent: string }
  | { tool: 'send'; agent: string; message: string }
  | { tool: 'interrupt'; agent: string }
  | { tool: 'spawn'; directory: string; title: string; prompt: string }
  | { tool: 'recall'; search: string }
  | { tool: 'list_agents'; namedOnly?: boolean }
  | { tool: 'find_agent'; query: string }
  | { tool: 'nearby' }
  | { tool: 'force_user_camera'; target: string }

export interface Reply {
  say: SayPart[]
  tools: ToolCall[]
}

/** Tools whose results the model must see before it can speak. */
export function isBlocking(call: ToolCall): boolean {
  return call.tool === 'read' || call.tool === 'recall' || call.tool === 'list_agents' || call.tool === 'find_agent' || call.tool === 'nearby'
}

/**
 * Parse one model reply. Throws with a reason the model can be shown when the
 * reply is not the agreed shape, so a retry can tell it what went wrong.
 */
export function parseReply(raw: string): Reply {
  const json = extractJsonObject(raw)
  if (json === undefined) throw new Error('reply was not a JSON object')
  let value: unknown
  try { value = JSON.parse(json) } catch (err) {
    throw new Error(`reply was not valid JSON: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (!isRecord(value)) throw new Error('reply was not a JSON object')
  const say = value.say ?? []
  const tools = value.tools ?? []
  if (!Array.isArray(say)) throw new Error('"say" must be an array')
  if (!Array.isArray(tools)) throw new Error('"tools" must be an array')
  return {
    say: say.map(parseSayPart).filter(part => part.text !== ''),
    tools: tools.map(parseToolCall),
  }
}

function parseSayPart(value: unknown): SayPart {
  if (!isRecord(value) || typeof value.text !== 'string') throw new Error('each "say" part needs a "text" string')
  const from = typeof value.from === 'string' && value.from.trim() ? value.from.trim() : CONTROL
  return { from, text: value.text.trim() }
}

function parseToolCall(value: unknown): ToolCall {
  if (!isRecord(value) || typeof value.tool !== 'string') throw new Error('each tool call needs a "tool" name')
  if (value.tool === 'nearby') return { tool: 'nearby' }
  if (value.tool === 'force_user_camera') {
    if (typeof value.target !== 'string' || !value.target.trim()) throw new Error('"force_user_camera" needs a "target"')
    return { tool: 'force_user_camera', target: value.target.trim() }
  }
  if (value.tool === 'list_agents') return value.named_only === true ? { tool: 'list_agents', namedOnly: true } : { tool: 'list_agents' }
  if (value.tool === 'find_agent') {
    if (typeof value.query !== 'string' || !value.query.trim()) throw new Error('"find_agent" needs a "query"')
    return { tool: 'find_agent', query: value.query.trim() }
  }
  if (value.tool === 'recall') {
    if (typeof value.search !== 'string' || !value.search.trim()) throw new Error('"recall" needs a "search"')
    return { tool: 'recall', search: value.search.trim() }
  }
  if (value.tool === 'spawn') {
    const field = (name: string): string => {
      const text = typeof value[name] === 'string' ? (value[name] as string).trim() : ''
      if (!text) throw new Error(`"spawn" needs a "${name}"`)
      return text
    }
    return { tool: 'spawn', directory: field('directory'), title: field('title'), prompt: field('prompt') }
  }
  const agent = typeof value.agent === 'string' ? value.agent.trim() : ''
  if (!agent) throw new Error(`tool "${value.tool}" needs an "agent" handle`)
  switch (value.tool) {
    case 'read':
      return typeof value.search === 'string' && value.search.trim()
        ? { tool: 'read', agent, search: value.search.trim() }
        : { tool: 'read', agent }
    case 'ask_agent':
      if (typeof value.question !== 'string' || !value.question.trim()) throw new Error('"ask_agent" needs a "question"')
      return { tool: 'ask_agent', agent, question: value.question.trim() }
    case 'monitor':
      return { tool: 'monitor', agent }
    case 'send':
      if (typeof value.message !== 'string' || !value.message.trim()) throw new Error('"send" needs a "message"')
      return { tool: 'send', agent, message: value.message.trim() }
    case 'interrupt':
      return { tool: 'interrupt', agent }
    default:
      throw new Error(`unknown tool "${value.tool}"`)
  }
}

/**
 * The outermost `{…}` in a reply. Haiku sometimes wraps JSON in a code fence
 * or a sentence of preamble despite being told not to; neither is worth a
 * retry when the object itself is intact.
 */
function extractJsonObject(raw: string): string | undefined {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  return start >= 0 && end > start ? raw.slice(start, end + 1) : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** One part, ready for the speech backend: words and the voice to say them in. */
export type SpokenPart = { text: string; voice?: string }

/** A spoken part, and how much of its start is the "Kevin here." the model never wrote. */
export type RenderedPart = SpokenPart & { introLength: number }

/** What a handle resolves to when it is spoken: its name, assigned on first use, and its voice. */
export type Speaker = { name: string; voice: string }

/**
 * Turn a reply's parts into speech.
 *
 * `{handle}` placeholders become names, and an agent's own part is introduced
 * in its own voice — "Kevin here." — whenever the voice changes to it, so the
 * voice and the name arrive together and the listener learns which is which. The receptionist's parts
 * get no introduction.
 *
 * `resolve` assigns a name the first time a handle is spoken, which is the
 * whole of when names get assigned: nothing is named until it is mentioned. A
 * placeholder that resolves to nothing is spoken as "an agent" rather than as
 * its handle.
 */
export function renderSpeech(
  say: readonly SayPart[],
  resolve: (handle: string) => Speaker | undefined,
  controlVoice: string,
): RenderedPart[] {
  const named = (text: string): string =>
    text.replace(/\{([A-Za-z0-9_-]+)\}/g, (_whole, handle: string) => resolve(handle)?.name ?? 'an agent')
  let previousVoice: string | undefined
  return say.map(part => {
    const speaker = part.from === CONTROL ? undefined : resolve(part.from)
    // A part attributed to a handle that is not an agent is still the
    // receptionist talking; giving it a voice it does not own would break
    // the one rule the voices exist for.
    if (!speaker) {
      previousVoice = controlVoice
      return { text: named(part.text), voice: controlVoice, introLength: 0 }
    }
    // Introduced when the speaker changes, not on every part: an agent quoted
    // twice in a row is still the one voice already introduced.
    const intro = previousVoice === speaker.voice ? '' : `${speaker.name} here. `
    previousVoice = speaker.voice
    return { text: `${intro}${named(part.text)}`, voice: speaker.voice, introLength: intro.length }
  })
}

/**
 * The listener's view of a spoken reply, cut to what they heard.
 *
 * `heard` is Voice Operator's `character_offset` into the parts joined with a
 * single space — the convention the speech backends share. Parts after the cut
 * are dropped, and the part it fell in is cut the way Summary Chat cuts an
 * answer: see `redactUnheard`, whose rules about the half-heard word apply
 * unchanged within a part.
 */
export function redactSpoken<P extends SpokenPart>(parts: readonly P[], heard: number): P[] {
  const kept: P[] = []
  let start = 0
  for (const part of parts) {
    const end = start + part.text.length
    if (heard >= end) {
      kept.push(part)
    } else {
      kept.push({ ...part, text: redactUnheard(part.text, Math.max(0, heard - start)) })
      return kept
    }
    start = end + 1
  }
  return kept
}
