/**
 * What the receptionist's model says back, and how it becomes speech.
 *
 * The model answers every turn with one JSON object: the parts it wants spoken,
 * and the tools it wants run. JSON rather than real tool use because the model
 * runs through claude-print-daemon's warm `claude -p` processes, which is what
 * keeps a turn near the API's own latency; the price is that the shape is
 * checked here instead of by the API.
 */
import { interruptedWordStart, redactUnheard } from '../summary-chat'
import { AGENT_TOKEN, stripBraces } from './agent-token'
import type { VoiceGender } from './name-voice-table'

/** Who a spoken part comes from: the receptionist itself, or an agent by its token. */
export const CONTROL = 'control'

export type SayPart = { from: string; text: string }

/** A name Control gives an agent, with the gender its voice must match. */
export type GivenName = { name: string; gender: VoiceGender }

/**
 * A tool call. Actions run before any of the reply's words are said, which
 * report them afterwards: see `Receptionist.speak`.
 */
export type ToolCall = (
  | { tool: 'read'; agent: string; search?: string }
  | { tool: 'ask_agent'; agent: string; question: string }
  | { tool: 'monitor'; agent: string }
  | { tool: 'send'; agent: string; message: string }
  | { tool: 'interrupt'; agent: string }
  | { tool: 'archive_agent'; agent: string }
  | { tool: 'unarchive_agent'; agent: string }
  | { tool: 'spawn'; directory: string; title: string; prompt: string; name?: GivenName }
  /** At least one of `title` and `name`. */
  | { tool: 'rename_agent'; agent: string; title?: string; name?: GivenName }
  | { tool: 'recall'; search: string }
  | { tool: 'list_agents'; namedOnly?: boolean }
  | { tool: 'find_agent'; query: string }
  | { tool: 'nearby' }
  | { tool: 'force_user_camera'; target: string }
  | { tool: 'go_quiet' }
  | { tool: 'backlog_add'; item: string }
  /** `about` describes a particular item to take, rather than whichever matters most. */
  | { tool: 'backlog_next'; about?: string }
)

export interface Reply {
  say: SayPart[]
  tools: ToolCall[]
}

/**
 * A reply that calls go_quiet, with nothing said: the user asked for silence,
 * so not one more word is spoken, whatever the model wrote.
 */
export function silencedIfQuiet(reply: Reply): Reply {
  if (!reply.tools.some(call => call.tool === 'go_quiet')) return reply
  return { say: [], tools: reply.tools }
}

/**
 * Tools that only find things out. They change nothing the user hears about,
 * so they run at once, never waiting for speech.
 */
export function isLookup(call: ToolCall): boolean {
  return call.tool === 'read' || call.tool === 'recall' || call.tool === 'list_agents' || call.tool === 'find_agent' || call.tool === 'nearby' ||
    call.tool === 'backlog_next'
}

/**
 * Control's own bookkeeping: changes nothing the user hears about, and has no
 * result the model must wait for, so it is done as soon as a reply is
 * accepted, never waiting for speech and never costing another step.
 */
export function isBookkeeping(call: ToolCall): boolean {
  return call.tool === 'backlog_add'
}

/** Tools that do something for the user, and so get a spoken confirmation, said once they have run. */
export function isAction(call: ToolCall): boolean {
  return !isLookup(call) && !isBookkeeping(call)
}

/**
 * Tools whose results the model must see before it can go on: the lookups,
 * and unarchive_agent, which waits for the agent to be ready so that the
 * model's next step can send to it.
 */
export function isBlocking(call: ToolCall): boolean {
  return isLookup(call) || call.tool === 'unarchive_agent'
}

/**
 * An action as the record's own lines put it once done — "SENT TO {Kevin}: …"
 * — for the transcript to show, struck out, when it never ran. Agents stay
 * tokens, which the transcript reads as names.
 */
export function actionHeadline(call: ToolCall): string {
  const who = (ref: string) => `{${stripBraces(ref)}}`
  switch (call.tool) {
    case 'send': return `SENT TO ${who(call.agent)}: ${call.message}`
    case 'ask_agent': return `ASKED ${who(call.agent)}: ${call.question}`
    case 'monitor': return `WATCHED ${who(call.agent)}`
    case 'interrupt': return `INTERRUPTED ${who(call.agent)}`
    case 'archive_agent': return `ARCHIVED ${who(call.agent)}`
    case 'unarchive_agent': return `UNARCHIVED ${who(call.agent)}`
    case 'spawn': return `STARTED AN AGENT in ${call.directory}: ${call.prompt}`
    case 'rename_agent': return `RENAMED ${who(call.agent)}: ${[call.name?.name, call.title && `"${call.title}"`].filter(Boolean).join(' ')}`
    case 'force_user_camera': return `TOOK YOU TO ${call.target}`
    case 'go_quiet': return 'WENT QUIET'
    default: return showToolCall(call)
  }
}

/** A tool call as the model wrote it, to show the model again. */
export function showToolCall(call: ToolCall): string {
  return JSON.stringify(call)
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
  // A call the model put among the parts is taken as one in "tools": it
  // runs before any words are said, wherever it was written.
  const parts: SayPart[] = []
  const placed: ToolCall[] = []
  for (const item of say) {
    if (isRecord(item) && 'tool' in item) {
      placed.push(parseToolCall(item))
      continue
    }
    const part = parseSayPart(item)
    if (part.text !== '') parts.push(part)
  }
  return { say: parts, tools: [...placed, ...tools.map(parseToolCall)] }
}

function parseSayPart(value: unknown): SayPart {
  if (!isRecord(value) || typeof value.text !== 'string') throw new Error('each "say" part needs a "text" string')
  const from = typeof value.from === 'string' ? stripBraces(value.from) : ''
  return { from: from || CONTROL, text: value.text.trim() }
}

/** Every tool, so a wrong name is answered with the right ones rather than a guess at its fields. */
const TOOL_NAMES: Record<ToolCall['tool'], true> = {
  read: true, ask_agent: true, monitor: true, send: true, interrupt: true, archive_agent: true, unarchive_agent: true,
  spawn: true, rename_agent: true, recall: true, list_agents: true, find_agent: true, nearby: true, force_user_camera: true, go_quiet: true,
  backlog_add: true, backlog_next: true,
}
const TOOL_LIST = Object.keys(TOOL_NAMES).join(', ')

function parseToolCall(value: unknown): ToolCall {
  if (!isRecord(value) || typeof value.tool !== 'string') {
    throw new Error(`each tool call needs a "tool" name, one of: ${TOOL_LIST}`)
  }
  if (!Object.hasOwn(TOOL_NAMES, value.tool)) throw new Error(`unknown tool "${value.tool}"; the tools are: ${TOOL_LIST}`)
  // The shape of a native tool call, which a model without its instructions falls back on.
  if ('input' in value) throw new Error(`a tool call's fields go beside "tool", not under "input"`)
  if (value.tool === 'nearby') return { tool: 'nearby' }
  if (value.tool === 'go_quiet') return { tool: 'go_quiet' }
  if (value.tool === 'backlog_next') {
    const about = typeof value.about === 'string' ? value.about.trim() : ''
    return about ? { tool: 'backlog_next', about } : { tool: 'backlog_next' }
  }
  if (value.tool === 'backlog_add') {
    if (typeof value.item !== 'string' || !value.item.trim()) throw new Error('"backlog_add" needs an "item"')
    return { tool: 'backlog_add', item: value.item.trim() }
  }
  if (value.tool === 'force_user_camera') {
    const target = typeof value.target === 'string' ? stripBraces(value.target) : ''
    if (!target) throw new Error('"force_user_camera" needs a "target"')
    return { tool: 'force_user_camera', target }
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
    const name = givenName(value, 'spawn')
    return { tool: 'spawn', directory: stripBraces(field('directory')), title: field('title'), prompt: field('prompt'), ...(name && { name }) }
  }
  const agent = typeof value.agent === 'string' ? stripBraces(value.agent) : ''
  if (!agent) throw new Error(`tool "${value.tool}" needs an "agent"`)
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
    case 'archive_agent':
      return { tool: 'archive_agent', agent }
    case 'unarchive_agent':
      return { tool: 'unarchive_agent', agent }
    case 'rename_agent': {
      const title = typeof value.title === 'string' ? value.title.trim() : ''
      const name = givenName(value, 'rename_agent')
      if (!title && !name) throw new Error('"rename_agent" needs a "title", a "name", or both')
      return { tool: 'rename_agent', agent, ...(title && { title }), ...(name && { name }) }
    }
    default:
      throw new Error(`unknown tool "${value.tool}"`)
  }
}

const GENDERS: Record<VoiceGender, true> = { masculine: true, feminine: true }

/**
 * A tool call's "name" and its "gender", or undefined if it gives no name.
 * The gender is required with a name: it picks the voice the name is spoken
 * in, and nothing but the model can tell a name's gender.
 */
function givenName(value: Record<string, unknown>, tool: string): GivenName | undefined {
  const name = typeof value.name === 'string' ? value.name.trim() : ''
  if (!name) {
    if (value.gender !== undefined) throw new Error(`"${tool}" has a "gender" but no "name"`)
    return undefined
  }
  const gender = value.gender
  if (typeof gender !== 'string' || !Object.hasOwn(GENDERS, gender)) {
    throw new Error(`"${tool}" with a "name" needs a "gender" for it, "masculine" or "feminine", which picks its voice`)
  }
  return { name: stripBraces(name), gender: gender as VoiceGender }
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

/** What an agent token resolves to when it is spoken: its name, assigned on first use, and its voice. */
export type Speaker = { name: string; voice: string }

/**
 * Turn a reply's parts into speech.
 *
 * Agent tokens become names, and an agent's own part is introduced in its own
 * voice — "Kevin here." — whenever the voice changes to it, so the voice and
 * the name arrive together and the listener learns which is which. The
 * receptionist's parts get no introduction.
 *
 * `resolve` takes a token as written, without its braces, and assigns a name
 * the first time an agent is spoken of, which is the whole of when names get
 * assigned: nothing is named until it is mentioned. A token that resolves to
 * nothing is spoken as "an agent" rather than as its handle.
 */
export function renderSpeech(
  say: readonly SayPart[],
  resolve: (ref: string) => Speaker | undefined,
  controlVoice: string,
): RenderedPart[] {
  const named = (text: string): string => nameAgents(text, ref => resolve(ref)?.name)
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
 * Every agent token in `text` as the agent's name, spoken once.
 *
 * The model sometimes writes the name beside the token as well — "Kevin
 * {amber-otter}", or as an aside, "{royal-anchor}, Naomi, looked into it" —
 * which spoken is "Naomi, Naomi, looked into it". The token form and the
 * instructions are meant to stop that; this is the net under them. A name
 * right beside the token that is that same agent's name is dropped, with the
 * commas that set it off. Anything else beside a token, including another
 * agent's name, is left as written.
 */
function nameAgents(text: string, nameOf: (ref: string) => string | undefined): string {
  let out = ''
  let consumed = 0
  for (const match of text.matchAll(AGENT_TOKEN)) {
    let before = out + text.slice(consumed, match.index)
    consumed = match.index + match[0].length
    const name = nameOf(match[1])
    if (!name) {
      out = before + 'an agent'
      continue
    }
    const word = escapeRegExp(name)
    // A comma after a name set off by one before it closes the same aside: "Naomi, {…}, looked" → "Naomi looked".
    const dropClosingComma = (): void => {
      const comma = /^\s*,/.exec(text.slice(consumed))
      if (comma) consumed += comma[0].length
    }
    const echoBefore = new RegExp(`(?<![A-Za-z0-9])${word}(\\s*,\\s*|\\s+)$`, 'i').exec(before)
    if (echoBefore) {
      before = before.slice(0, echoBefore.index)
      if (echoBefore[1].includes(',')) dropClosingComma()
    } else {
      const echoAfter = new RegExp(`^(\\s*,\\s*|\\s+)${word}(?![A-Za-z0-9])`, 'i').exec(text.slice(consumed))
      if (echoAfter) {
        consumed += echoAfter[0].length
        if (echoAfter[1].includes(',')) dropClosingComma()
      }
    }
    out = before + name
  }
  return out + text.slice(consumed)
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
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

/**
 * How much of each part of a cut-off reply was heard, as the record stores
 * the part (its spoken intro left off): what the transcript view leaves
 * standing, striking out the rest. `heard` is as for `redactSpoken`, and the
 * word the voice was cut off in counts as unheard, as there.
 */
export function heardLengths(parts: readonly RenderedPart[], heard: number): number[] {
  let start = 0
  return parts.map(part => {
    const at = Math.min(Math.max(0, heard - start), part.text.length)
    start += part.text.length + 1
    const cut = at >= part.text.length ? at : interruptedWordStart(part.text, at)
    return Math.max(0, cut - part.introLength)
  })
}
