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
  /** Audio posts, chained so chunks reach Voice Operator in the order sent. */
  chain: Promise<void>
  /** The first audio failure, reported at finish rather than dropped. */
  failure?: string
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
  /** Sessions still taking the user's voice: from start until finish is asked for, or a cancel. */
  private readonly listening = new Set<string>()

  /**
   * `onSpeaking` hears whether anyone is dictating now, on every change: what
   * the receptionist waits on, so it never talks over the user.
   */
  constructor(private readonly voice: Voice, private readonly onSpeaking: (speaking: boolean) => void = () => {}) {}

  /** Whether some client is dictating now. */
  get speaking(): boolean {
    return this.listening.size > 0
  }

  private setListening(id: string, on: boolean): void {
    const before = this.speaking
    if (on) this.listening.add(id)
    else this.listening.delete(id)
    if (this.speaking !== before) this.onSpeaking(this.speaking)
  }

  async start(owner: string, sampleRate: number): Promise<DictationOutcome<string>> {
    const response = await this.voice.startTranscription(sampleRate)
    const id = (response?.body as { id?: unknown } | undefined)?.id
    if (response?.status !== 201 || typeof id !== 'string') {
      return { ok: false, error: describe(response, 'start transcribing') }
    }
    this.sessions.set(id, { owner, chain: Promise.resolve() })
    this.setListening(id, true)
    return { ok: true, value: id }
  }

  /** Queue one chunk. Fire-and-forget for the client; failures surface at finish. */
  audio(owner: string, id: string, pcm: Uint8Array): void {
    const session = this.owned(owner, id)
    if (!session) return
    session.chain = session.chain.then(async () => {
      if (session.failure) return
      const response = await this.voice.sendTranscriptionAudio(id, pcm)
      if (response?.status !== 204) session.failure = describe(response, 'take the audio')
    })
  }

  async finish(owner: string, id: string): Promise<DictationOutcome<string>> {
    const session = this.owned(owner, id)
    if (!session) return { ok: false, error: 'That dictation has already ended' }
    // The user has stopped talking; what is left is transcribing.
    this.setListening(id, false)
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

  cancel(owner: string, id: string): void {
    if (!this.owned(owner, id)) return
    this.sessions.delete(id)
    this.setListening(id, false)
    void this.voice.cancelTranscription(id)
  }

  /** The client went away mid-dictation. */
  cancelAllFor(owner: string): void {
    for (const [id, session] of this.sessions) {
      if (session.owner === owner) this.cancel(owner, id)
    }
  }

  private owned(owner: string, id: string): Session | undefined {
    const session = this.sessions.get(id)
    return session?.owner === owner ? session : undefined
  }
}
