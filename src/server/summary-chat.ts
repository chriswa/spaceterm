import * as fs from 'fs'
import * as path from 'path'
import { homedir, userInfo } from 'os'
import { randomUUID } from 'crypto'
import { execFileSync } from 'child_process'
import { serverLog } from './server-log'

const DISCOVERY_PATH = path.join(homedir(), 'Library', 'Application Support', 'VoiceOperator', 'speech-service.json')
const MAX_MESSAGES = 24
const MAX_CHARS = 48_000
const SUMMARY_CHAT_DIR = path.join(process.env.SPACETERM_HOME ?? path.join(homedir(), '.spaceterm'), 'summary-chat')
const AUDIT_PATH = path.join(SUMMARY_CHAT_DIR, 'sessions.jsonl')
const HAIKU_URL = 'https://api.anthropic.com/v1/messages'
const HAIKU_MODEL = 'claude-haiku-4-5-20251001'
const MAX_HAIKU_HISTORY_MESSAGES = 12
const BLOCKED_VOICE_IDS = new Set(['af_nicole'])
const SPEECH_LONG_POLL_TIMEOUT_MS = 5 * 60_000
const SUMMARY_SYSTEM_PROMPT = `You are a fast voice companion helping a user understand a coding-agent conversation. Speak in two to four concise sentences of plain English. Later messages supersede earlier ones. Do not use markdown, lists, code, preambles, or quotation marks. Answer only with words to speak.`

type TranscriptMessage = { role: 'user' | 'assistant'; text: string }
type HaikuMessage = { role: 'user' | 'assistant'; content: string }
type SpeechStatus = {
  id: string
  state: 'in_progress' | 'completed' | 'interrupted_by_user' | 'cancelled_by_client' | 'synthesis_failed'
  playback_state?: 'queued' | 'speaking' | 'waiting_for_user'
  character_offset?: number
}

interface Conversation {
  auditId: string
  nodeId: string
  sourceAgentSessionId?: string
  haikuHistory: HaikuMessage[]
  voice?: string
  speechId?: string
  isSpeaking: boolean
  lastUsedAt: number
}

/**
 * Owns the direct Haiku conversations which make an agent transcript speakable.
 * Each conversation is keyed by stable node id, so follow-up dictation retains
 * the original transcript and prior spoken answers.
 */
export class SummaryChat {
  private readonly conversations = new Map<string, Conversation>()
  private voices: string[] = []
  private voiceRefreshTimer: ReturnType<typeof setInterval>

  constructor(
    private readonly onSpeakingChanged: (nodeId: string, speaking: boolean, voice?: string) => void,
    private readonly onStatusChanged: (nodeId: string, state: 'thinking' | 'ready' | 'target' | 'error', message?: string) => void,
  ) {
    this.voiceRefreshTimer = setInterval(() => { void this.refreshVoices() }, 5_000)
    void this.refreshVoices()
  }

  dispose(): void {
    clearInterval(this.voiceRefreshTimer)
    for (const conversation of Array.from(this.conversations.values())) void this.cancelSpeech(conversation)
  }

  /** The conversation unqualified Voice Operator commands currently target. */
  getTargetNodeId(): string | undefined {
    return Array.from(this.conversations.values())
      .sort((a, b) => b.lastUsedAt - a.lastUsedAt)[0]?.nodeId
  }

  async start(nodeId: string, transcriptPath: string | undefined, sourceAgentSessionId?: string): Promise<void> {
    if (!transcriptPath) {
      serverLog(`[summary-chat] ${nodeId.slice(0, 8)} has no resolved transcript`)
      this.onStatusChanged(nodeId, 'error', 'This surface has no transcript to summarize yet.')
      return
    }
    const messages = readTranscript(transcriptPath)
    if (!messages.length || !messages.some(message => message.role === 'user')) {
      serverLog(`[summary-chat] ${nodeId.slice(0, 8)} transcript has no user-facing messages`)
      this.onStatusChanged(nodeId, 'error', 'This transcript has no user messages to summarize yet.')
      return
    }

    const previous = this.conversations.get(nodeId)
    if (previous) await this.cancelSpeech(previous)
    const conversation: Conversation = {
      auditId: randomUUID(),
      nodeId,
      sourceAgentSessionId,
      haikuHistory: [],
      voice: this.voiceFor(nodeId),
      isSpeaking: false,
      lastUsedAt: Date.now(),
    }
    this.conversations.set(nodeId, conversation)
    this.onStatusChanged(nodeId, 'target')
    const prompt = initialPrompt(messages)
    this.recordInitialSnapshot(conversation, transcriptPath, messages, prompt)
    await this.ask(conversation, prompt, 'initial')
  }

  async followUp(text: string): Promise<void> {
    const conversation = Array.from(this.conversations.values())
      .sort((a, b) => b.lastUsedAt - a.lastUsedAt)[0]
    if (!conversation) {
      serverLog('[summary-chat] voice command ignored: no active summary conversation')
      return
    }
    const heard = await this.heardPrefix(conversation)
    const context = heard === undefined
      ? ''
      : `\nThe listener interrupted your previous answer after character ${heard}; do not assume they heard the rest. `
    await this.ask(conversation, `${context}The listener asks: ${text}`, 'follow-up')
  }

  private async ask(conversation: Conversation, prompt: string, kind: 'initial' | 'follow-up'): Promise<void> {
    conversation.lastUsedAt = Date.now()
    this.onStatusChanged(conversation.nodeId, 'thinking')
    try {
      const text = await this.askHaiku(conversation, prompt)
      this.appendAudit({
        event: 'haiku-response', auditId: conversation.auditId, nodeId: conversation.nodeId,
        kind, provider: 'messages-api', responseCharacters: text.length,
      })
      if (!text) return
      // The Voice Operator may have appeared after this chat started. Lock a
      // deterministic voice as soon as its voice list becomes available.
      conversation.voice ??= this.voiceFor(conversation.nodeId)
      const speech = await this.speak(text, conversation.voice)
      conversation.speechId = speech?.id
      if (speech?.id) {
        void this.monitorSpeech(conversation, speech.id)
      }
      serverLog(`[summary-chat] ${conversation.nodeId.slice(0, 8)} spoke ${text.length} chars`)
    } catch (err) {
      serverLog(`[summary-chat] ${conversation.nodeId.slice(0, 8)} Haiku failed: ${err instanceof Error ? err.message : String(err)}`)
      this.onStatusChanged(conversation.nodeId, 'error', 'Summary Chat could not reach Haiku.')
    } finally {
      this.onStatusChanged(conversation.nodeId, 'ready')
    }
  }

  /**
   * Voice Operator's former low-latency path: call Haiku's Messages endpoint
   * directly with the Claude Code OAuth credential kept in the macOS Keychain.
   * Keep a bounded history locally because this endpoint is stateless.
   */
  private async askHaiku(conversation: Conversation, prompt: string): Promise<string> {
    const pending: HaikuMessage = { role: 'user', content: prompt }
    const messages = boundedHaikuHistory([...conversation.haikuHistory, pending])
    const response = await fetch(HAIKU_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${claudeCodeOAuthToken()}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'anthropic-version': '2023-06-01',
        'user-agent': 'claude-code/2.1.47',
      },
      body: JSON.stringify({
        model: HAIKU_MODEL,
        max_tokens: 250,
        system: [
          { type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." },
          { type: 'text', text: SUMMARY_SYSTEM_PROMPT },
        ],
        messages,
      }),
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok) throw new Error(`Messages API returned ${response.status}`)
    const payload = await response.json() as { content?: Array<{ type?: string; text?: string }> }
    const text = payload.content
      ?.filter(block => block.type === 'text' && typeof block.text === 'string')
      .map(block => block.text!)
      .join('')
      .trim()
    if (!text) throw new Error('Messages API returned no text')
    conversation.haikuHistory = boundedHaikuHistory([...conversation.haikuHistory, pending, { role: 'assistant', content: text }])
    return text
  }

  private recordInitialSnapshot(conversation: Conversation, transcriptPath: string, messages: TranscriptMessage[], prompt: string): void {
    try {
      fs.mkdirSync(SUMMARY_CHAT_DIR, { recursive: true })
      const snapshotPath = path.join(SUMMARY_CHAT_DIR, `${conversation.auditId}.initial-prompt.txt`)
      fs.writeFileSync(snapshotPath, prompt)
      const messageCharacters = messages.reduce((total, message) => total + message.text.length, 0)
      this.appendAudit({
        event: 'started', auditId: conversation.auditId, nodeId: conversation.nodeId,
        sourceAgentSessionId: conversation.sourceAgentSessionId ?? null,
        transcriptPath, snapshotPath, messageCount: messages.length,
        messageCharacters, promptCharacters: prompt.length,
      })
    } catch (err) {
      serverLog(`[summary-chat] failed to record audit snapshot: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  private appendAudit(entry: Record<string, unknown>): void {
    try {
      fs.mkdirSync(SUMMARY_CHAT_DIR, { recursive: true })
      fs.appendFileSync(AUDIT_PATH, JSON.stringify({ timestamp: new Date().toISOString(), ...entry }) + '\n')
    } catch (err) {
      serverLog(`[summary-chat] failed to append audit: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  private async heardPrefix(conversation: Conversation): Promise<number | undefined> {
    if (!conversation.speechId) return undefined
    const status = await this.speechRequest<SpeechStatus>(`/v1/speech/${encodeURIComponent(conversation.speechId)}?wait=0`)
    if (!status || status.state !== 'interrupted_by_user') return undefined
    return status.character_offset ?? 0
  }

  private async cancelSpeech(conversation: Conversation): Promise<void> {
    const speechId = conversation.speechId
    if (!speechId) return
    conversation.speechId = undefined
    await this.speechRequest(`/v1/speech/${encodeURIComponent(speechId)}`, { method: 'DELETE' })
    if (conversation.isSpeaking) {
      conversation.isSpeaking = false
      this.onSpeakingChanged(conversation.nodeId, false)
    }
  }

  private async monitorSpeech(conversation: Conversation, speechId: string): Promise<void> {
    let firstPoll = true
    while (conversation.speechId === speechId) {
      // Voice Operator exposes a stable job-level lifecycle: `in_progress`
      // covers all sentence handoffs, while a long poll wakes only at a
      // terminal state (or its 30-second timeout). The public indicator is
      // therefore tied to the job, not fragile per-sentence playback events.
      const wait = firstPoll ? 0 : 30
      firstPoll = false
      // The default request timeout is intentionally short for one-shot
      // operations. A speech monitor, however, must tolerate a stalled local
      // service without falsely declaring the job finished.
      const status = await this.speechRequest<SpeechStatus>(
        `/v1/speech/${encodeURIComponent(speechId)}?wait=${wait}`,
        undefined,
        wait === 0 ? 3_000 : SPEECH_LONG_POLL_TIMEOUT_MS,
      )
      if (!status) {
        if (conversation.speechId === speechId) {
          conversation.speechId = undefined
          if (conversation.isSpeaking) {
            conversation.isSpeaking = false
            this.onSpeakingChanged(conversation.nodeId, false)
          }
        }
        return
      }
      if (status.state === 'in_progress') {
        if (!conversation.isSpeaking) {
          conversation.isSpeaking = true
          this.onSpeakingChanged(conversation.nodeId, true, conversation.voice)
        }
        continue
      }
      if (conversation.speechId === speechId) {
        conversation.speechId = undefined
        if (conversation.isSpeaking) {
          conversation.isSpeaking = false
          this.onSpeakingChanged(conversation.nodeId, false)
        }
      }
      return
    }
  }

  private async refreshVoices(): Promise<void> {
    const response = await this.speechRequest<{ voices?: Array<{ id?: string }> }>('/v1/voices')
    const voices = response?.voices
      ?.map(voice => voice.id)
      .filter((id): id is string => Boolean(id) && !BLOCKED_VOICE_IDS.has(id))
      .sort() ?? []
    if (voices.length) this.voices = voices
  }

  private voiceFor(nodeId: string): string | undefined {
    if (!this.voices.length) return undefined
    let hash = 0
    for (const char of nodeId) hash = ((hash * 31) + char.charCodeAt(0)) >>> 0
    return this.voices[hash % this.voices.length]
  }

  private async speak(text: string, voice: string | undefined): Promise<SpeechStatus | undefined> {
    return this.speechRequest<SpeechStatus>('/v1/speech', {
      method: 'POST', body: JSON.stringify({ text, ...(voice ? { voice } : {}) }),
    })
  }

  private async speechRequest<T>(endpoint: string, init?: RequestInit, timeoutMs = 3_000): Promise<T | undefined> {
    let port: number | undefined
    try {
      const discovery = JSON.parse(fs.readFileSync(DISCOVERY_PATH, 'utf8')) as { port?: unknown }
      if (typeof discovery.port === 'number' && discovery.port > 0 && discovery.port < 65536) port = discovery.port
    } catch {
      return undefined
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}${endpoint}`, {
        ...init,
        headers: { 'content-type': 'application/json', ...init?.headers },
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!response.ok && response.status !== 202 && response.status !== 409) return undefined
      return await response.json() as T
    } catch {
      return undefined
    }
  }
}

function initialPrompt(messages: TranscriptMessage[]): string {
  const anchor = latestSubstantialUserMessage(messages)
  const background = messages.slice(0, anchor)
  const turn = messages.slice(anchor)
  const format = (items: TranscriptMessage[]) => items
    .map(message => `${message.role.toUpperCase()}: ${message.text}`)
    .join('\n\n')
  return `You are a fast voice companion helping a user understand a coding-agent conversation. Summarize ONLY the CURRENT TURN for text-to-speech in two to four concise sentences. The current turn starts at the user's latest substantial message and includes everything after it. A bare request to continue is not substantial; a short answer such as "yes" is substantial. Focus on what the agent concluded, accomplished, is blocked on, or needs next in response to that current request. Do not recap earlier work unless it is essential to make the current-turn answer intelligible.

BACKGROUND CONTEXT is only for disambiguation and for preparing to answer follow-up voice questions. It is not the subject of the summary. Later messages supersede earlier ones. Do not use markdown, lists, code, preambles, or quotation marks. Answer only with words to speak.

BACKGROUND CONTEXT:
${format(background) || '(none)'}

CURRENT TURN TO SUMMARIZE:
${format(turn)}`
}

/**
 * A plain "continue" extends the previous task; it should not cause a spoken
 * recap to be anchored on that single-word instruction. We intentionally keep
 * this narrow: terse but meaningful replies such as "yes" remain substantial.
 */
function latestSubstantialUserMessage(messages: TranscriptMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message.role === 'user' && !isBareContinuation(message.text)) return index
  }
  return messages.map(message => message.role).lastIndexOf('user')
}

function isBareContinuation(text: string): boolean {
  return /^(?:please\s+)?(?:continue|keep going|go on|proceed)(?:\s+please)?[.!…]*$/i.test(text.trim())
}

function boundedHaikuHistory(history: HaikuMessage[]): HaikuMessage[] {
  if (history.length <= MAX_HAIKU_HISTORY_MESSAGES) return history
  // Keep the initial prompt (which contains the focused transcript) and the
  // newest exchanges; this preserves grounding without unbounded request size.
  return [history[0], ...history.slice(-(MAX_HAIKU_HISTORY_MESSAGES - 1))]
}

function claudeCodeOAuthToken(): string {
  const account = process.env.USER || process.env.LOGNAME || userInfo().username
  try {
    const raw = execFileSync('/usr/bin/security', [
      'find-generic-password', '-s', 'Claude Code-credentials', '-a', account, '-w',
    ], { encoding: 'utf8', timeout: 3_000, stdio: ['ignore', 'pipe', 'ignore'] })
    const credentials = JSON.parse(raw) as { claudeAiOauth?: { accessToken?: unknown } }
    const token = credentials.claudeAiOauth?.accessToken
    if (typeof token === 'string' && token) return token
  } catch { /* Present the same generic failure regardless of Keychain details. */ }
  throw new Error('Claude Code OAuth credential is unavailable')
}

export function readTranscript(filePath: string): TranscriptMessage[] {
  let raw: string
  try { raw = fs.readFileSync(filePath, 'utf8') } catch { return [] }
  const result: TranscriptMessage[] = []
  for (const line of raw.split('\n')) {
    if (!line) continue
    try {
      const entry = JSON.parse(line) as Record<string, any>
      const message = extractMessage(entry)
      if (message) result.push(message)
    } catch { /* Ignore a partial JSONL write. */ }
  }
  // Always retain the latest user request, then fill backwards with as much
  // context as fits. This is deliberately message-based, never tool/thinking.
  const latestUser = result.map(message => message.role).lastIndexOf('user')
  if (latestUser < 0) return []
  const selected: TranscriptMessage[] = []
  let chars = 0
  for (let i = result.length - 1; i >= 0 && selected.length < MAX_MESSAGES; i--) {
    const message = result[i]
    if (i < latestUser && chars + message.text.length > MAX_CHARS) break
    selected.push(message)
    chars += message.text.length
  }
  return selected.reverse()
}

function extractMessage(entry: Record<string, any>): TranscriptMessage | undefined {
  // Claude's transcript shape.
  if ((entry.type === 'user' || entry.type === 'assistant') && entry.message) {
    const text = contentText(entry.message.content)
    return text ? { role: entry.type, text } : undefined
  }
  // Cursor's JSONL uses role at the top level rather than type.
  if ((entry.role === 'user' || entry.role === 'assistant') && entry.message) {
    const text = contentText(entry.message.content)
    return text ? { role: entry.role, text } : undefined
  }
  // Codex writes a separate canonical user_message event. Using it avoids
  // accidentally treating its injected environment/developer context as human
  // speech. Assistant output remains in response_item messages.
  if (entry.type === 'event_msg' && entry.payload?.type === 'user_message' && typeof entry.payload.message === 'string') {
    const text = entry.payload.message.trim()
    return text ? { role: 'user', text } : undefined
  }
  // Codex rollout shape. Ignore developer/system messages and tool calls.
  if (entry.type === 'response_item' && entry.payload?.type === 'message') {
    const role = entry.payload.role
    if (role !== 'assistant') return undefined
    const text = contentText(entry.payload.content)
    return text ? { role, text } : undefined
  }
  return undefined
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  return content
    .filter((block: any) => block?.type === 'text' || block?.type === 'input_text' || block?.type === 'output_text')
    .map((block: any) => typeof block.text === 'string' ? block.text : '')
    .join('\n')
    .trim()
}
