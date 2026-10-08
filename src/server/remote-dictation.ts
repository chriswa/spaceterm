import type { SpeechResponse, VoiceOperator } from './voice-operator'

/**
 * Dictation for clients that cannot transcribe for themselves — the phone.
 *
 * A browser can neither speak Wispr's gRPC stream nor pass its CORS check, and
 * Wispr's refresh tokens rotate, so exactly one process may hold them: Voice
 * Operator. The client streams PCM here over its ordinary connection, and this
 * relays it to Voice Operator's transcription sessions in order.
 *
 * Each session belongs to the client that opened it. A client cannot touch
 * another's, and a client that disconnects has its sessions cancelled.
 */

export type DictationOutcome<T> = { ok: true; value: T } | { ok: false; error: string }

interface Session {
  owner: string
  /** The words go to Control, which holds until they arrive: see `delivered`. */
  forControl: boolean
  /** Audio posts, chained so chunks reach Voice Operator in the order sent. */
  chain: Promise<void>
  /** The first audio failure, reported at finish rather than dropped. */
  failure?: string
  /** The last few seconds, as floats, for the turn model — only for 16 kHz sessions, and only with one. */
  recent?: { blocks: Float32Array[]; samples: number }
}

/** What the turn model hears: Smart Turn's eight-second window. */
const TURN_WINDOW_SAMPLES = 8 * 16_000

/**
 * How long words transcribed for Control may take to come back from the phone
 * before Control stops waiting for them. Only a phone that drops its
 * connection between the two ever needs it.
 */
export const WORDS_FOR_CONTROL_LIMIT_MS = 10_000

/** What else a relay can be asked to do, beyond relaying. */
export interface RemoteDictationHooks {
  /**
   * Whether anyone is dictating now, on every change: what the receptionist
   * waits on, so it never talks over the user.
   */
  onSpeaking?: (speaking: boolean) => void
  /**
   * The turn model (turn-detector.ts): the probability, from 16 kHz audio
   * ending now, that the speaker has finished. Undefined when there is none.
   */
  turnProbability?: (audio: Float32Array) => Promise<number | undefined>
  /** Run `fn` after `ms`, returning a way to call it off. */
  schedule?: (ms: number, fn: () => void) => () => void
}

const REAL_SCHEDULE = (ms: number, fn: () => void): (() => void) => {
  const timer = setTimeout(fn, ms)
  return () => clearTimeout(timer)
}

type Voice = Pick<VoiceOperator, 'startTranscription' | 'sendTranscriptionAudio' | 'finishTranscription' | 'cancelTranscription'>

/** Turn a reply into a sentence for the person holding the phone. */
function describe(response: SpeechResponse, doing: string): string {
  if (!response) return `Voice Operator is not running, so there is nothing to ${doing} with`
  const body = response.body as { error?: string; detail?: string } | undefined
  const reason = body?.detail ?? body?.error ?? `HTTP ${response.status}`
  return `Voice Operator could not ${doing}: ${reason}`
}

export class RemoteDictation {
  private readonly sessions = new Map<string, Session>()
  /**
   * Sessions the user is still talking in, as Control sees it: from start
   * until finish is asked for, or a cancel. One for Control lasts until its
   * words are back with Control, or are known to be none.
   */
  private readonly listening = new Set<string>()
  /** Sessions for Control whose words are on their way back to it, by owner: see `delivered`. */
  private readonly awaiting = new Map<string, { owner: string; cancelLimit: () => void }>()

  constructor(private readonly voice: Voice, private readonly hooks: RemoteDictationHooks = {}) {}

  /** Whether some client is dictating now. */
  get speaking(): boolean {
    return this.listening.size > 0
  }

  private setListening(id: string, on: boolean): void {
    const before = this.speaking
    if (on) this.listening.add(id)
    else this.listening.delete(id)
    if (this.speaking !== before) this.hooks.onSpeaking?.(this.speaking)
  }

  /** `forControl`: the words go to Control, which waits for them rather than resuming without them. */
  async start(owner: string, sampleRate: number, forControl = false): Promise<DictationOutcome<string>> {
    const response = await this.voice.startTranscription(sampleRate)
    const id = (response?.body as { id?: unknown } | undefined)?.id
    if (response?.status !== 201 || typeof id !== 'string') {
      return { ok: false, error: describe(response, 'start transcribing') }
    }
    this.sessions.set(id, {
      owner,
      forControl,
      chain: Promise.resolve(),
      ...(this.hooks.turnProbability && sampleRate === 16_000 ? { recent: { blocks: [], samples: 0 } } : {}),
    })
    this.setListening(id, true)
    return { ok: true, value: id }
  }

  /** Queue one chunk. Fire-and-forget for the client; failures surface at finish. */
  audio(owner: string, id: string, pcm: Uint8Array): void {
    const session = this.owned(owner, id)
    if (!session) return
    // Kept here as it arrives, so a turn check asked for after it hears it.
    if (session.recent) remember(session.recent, pcm)
    session.chain = session.chain.then(async () => {
      if (session.failure) return
      const response = await this.voice.sendTranscriptionAudio(id, pcm)
      if (response?.status !== 204) session.failure = describe(response, 'take the audio')
    })
  }

  async finish(owner: string, id: string): Promise<DictationOutcome<string>> {
    const session = this.owned(owner, id)
    if (!session) return { ok: false, error: 'That dictation has already ended' }
    // The user has stopped talking. Words for Control are still to come, and
    // Control waits for them; anything else is no concern of its.
    if (!session.forControl) this.setListening(id, false)
    const outcome = await this.transcribe(id, session)
    if (session.forControl) {
      if (outcome.ok && outcome.value.trim()) this.awaitWords(id, session.owner)
      else this.setListening(id, false)
    }
    return outcome
  }

  private async transcribe(id: string, session: Session): Promise<DictationOutcome<string>> {
    await session.chain
    this.sessions.delete(id)
    if (session.failure) {
      void this.voice.cancelTranscription(id)
      return { ok: false, error: session.failure }
    }
    const response = await this.voice.finishTranscription(id)
    const text = (response?.body as { text?: unknown } | undefined)?.text
    if (response?.status !== 200 || typeof text !== 'string') {
      return { ok: false, error: describe(response, 'finish transcribing') }
    }
    return { ok: true, value: text }
  }

  /** Words for Control are on their way back from the phone: still talking, to Control, until they arrive. */
  private awaitWords(id: string, owner: string): void {
    const schedule = this.hooks.schedule ?? REAL_SCHEDULE
    const cancelLimit = schedule(WORDS_FOR_CONTROL_LIMIT_MS, () => this.settle(id))
    this.awaiting.set(id, { owner, cancelLimit })
  }

  /**
   * The client has handed Control what it made of its dictation — words, or
   * word that there were none. Control stops waiting on its dictations.
   */
  delivered(owner: string): void {
    for (const [id, waiting] of this.awaiting) {
      if (waiting.owner === owner) this.settle(id)
    }
  }

  private settle(id: string): void {
    this.awaiting.get(id)?.cancelLimit()
    this.awaiting.delete(id)
    this.setListening(id, false)
  }

  cancel(owner: string, id: string): void {
    if (!this.owned(owner, id)) return
    this.sessions.delete(id)
    this.setListening(id, false)
    void this.voice.cancelTranscription(id)
  }

  /**
   * Whether the speaker sounds finished: the turn model's probability for this
   * dictation's last eight seconds, as received so far. `null` when there is
   * no turn model, so the client falls back on silence alone.
   */
  async turnComplete(owner: string, id: string): Promise<DictationOutcome<number | null>> {
    const session = this.owned(owner, id)
    if (!session) return { ok: false, error: 'That dictation has already ended' }
    if (!session.recent || !this.hooks.turnProbability) return { ok: true, value: null }
    const audio = new Float32Array(session.recent.samples)
    let offset = 0
    for (const block of session.recent.blocks) {
      audio.set(block, offset)
      offset += block.length
    }
    try {
      return { ok: true, value: (await this.hooks.turnProbability(audio)) ?? null }
    } catch (err) {
      return { ok: false, error: `The turn model failed: ${err instanceof Error ? err.message : String(err)}` }
    }
  }

  /** The client went away mid-dictation, or with words for Control not yet handed on. */
  cancelAllFor(owner: string): void {
    for (const [id, session] of this.sessions) {
      if (session.owner === owner) this.cancel(owner, id)
    }
    this.delivered(owner)
  }

  private owned(owner: string, id: string): Session | undefined {
    const session = this.sessions.get(id)
    return session?.owner === owner ? session : undefined
  }
}

/** Append s16le PCM as floats, keeping only the turn model's window. */
function remember(recent: { blocks: Float32Array[]; samples: number }, pcm: Uint8Array): void {
  const count = pcm.length >> 1
  const view = new DataView(pcm.buffer, pcm.byteOffset, count * 2)
  const block = new Float32Array(count)
  for (let i = 0; i < count; i++) block[i] = view.getInt16(i * 2, true) / 32768
  recent.blocks.push(block)
  recent.samples += count
  while (recent.blocks.length > 1 && recent.samples - recent.blocks[0].length >= TURN_WINDOW_SAMPLES) {
    recent.samples -= recent.blocks.shift()!.length
  }
}
