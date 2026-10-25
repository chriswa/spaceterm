import { DICTATION_RESUME_GRACE_MS } from '../shared/protocol'
import type { SpeechResponse, VoiceOperator } from './voice-operator'

/**
 * Dictation for clients that cannot transcribe for themselves — the phone.
 *
 * A browser can neither speak Wispr's gRPC stream nor pass its CORS check, and
 * Wispr's refresh tokens rotate, so exactly one process may hold them: Voice
 * Operator. The client streams PCM here over its ordinary connection, and this
 * relays it to Voice Operator's transcription sessions in order.
 *
 * Each session belongs to the device that opened it (its `client-hello`
 * device id; a client without one owns by connection), so a phone that
 * reconnects owns it still. A device cannot touch another's. One whose
 * connection drops has {@link DICTATION_RESUME_GRACE_MS} to come back and
 * carry on (`resume`) before its dictation is cancelled: Wi-Fi coming back
 * drops the phone's socket for a moment, and that once cost a dictation
 * (October 2026). Audio carries its offset, so what the phone resends after a
 * drop is taken once, and a finish whose reply was lost can be asked again.
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
  /** Samples taken so far: where the next chunk must start. */
  received: number
  /** Asked to finish: the outcome, given again to a repeated finish. */
  result?: Promise<DictationOutcome<string>>
  /** Calls off the cancel its owner's disconnect set going. */
  cancelGrace?: () => void
}

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
  /** Run `fn` after `ms`, returning a way to call it off. */
  schedule?: (ms: number, fn: () => void) => () => void
}

const REAL_SCHEDULE = (ms: number, fn: () => void): (() => void) => {
  const timer = setTimeout(fn, ms)
  return () => clearTimeout(timer)
}

/** Why a dictation cannot be finished or resumed: its connection was gone too long, or it never was. */
const GONE = 'That dictation is no longer on the Mac: it has ended, or the connection was gone too long'

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
      received: 0,
    })
    this.setListening(id, true)
    return { ok: true, value: id }
  }

  /**
   * Queue one chunk of s16 PCM starting `at` samples in (after what came
   * before, when absent). What was already taken is dropped, and so is a chunk
   * that would leave a gap: the client resumes, and resends from `received`.
   * Fire-and-forget for the client; failures surface at finish.
   */
  audio(owner: string, id: string, pcm: Uint8Array, at?: number): void {
    const session = this.owned(owner, id)
    if (!session || session.result) return
    this.heardFrom(session)
    const start = at ?? session.received
    const samples = Math.floor(pcm.length / 2)
    if (start > session.received) return
    const skip = session.received - start
    if (skip >= samples) return
    const fresh = skip > 0 ? pcm.subarray(skip * 2, samples * 2) : pcm
    session.received += samples - skip
    session.chain = session.chain.then(async () => {
      if (session.failure) return
      const response = await this.voice.sendTranscriptionAudio(id, fresh)
      if (response?.status !== 204) session.failure = describe(response, 'take the audio')
    })
  }

  /** A client back after a drop: how many samples of its dictation are here, to send the rest from. */
  resume(owner: string, id: string): DictationOutcome<number> {
    const session = this.owned(owner, id)
    if (!session) return { ok: false, error: GONE }
    this.heardFrom(session)
    return { ok: true, value: session.received }
  }

  /** No more audio. Asked again — the reply was lost with the connection — it answers the same. */
  finish(owner: string, id: string): Promise<DictationOutcome<string>> {
    const session = this.owned(owner, id)
    if (!session) return Promise.resolve({ ok: false, error: GONE })
    this.heardFrom(session)
    session.result ??= this.finishOnce(id, session)
    return session.result
  }

  private async finishOnce(id: string, session: Session): Promise<DictationOutcome<string>> {
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
    // Kept a while, for a finish asked again; gone from Voice Operator now either way.
    this.schedule(DICTATION_RESUME_GRACE_MS, () => {
      if (this.sessions.get(id) === session) this.sessions.delete(id)
    })
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
    const cancelLimit = this.schedule(WORDS_FOR_CONTROL_LIMIT_MS, () => this.settle(id))
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
    const session = this.owned(owner, id)
    if (!session) return
    session.cancelGrace?.()
    this.sessions.delete(id)
    // Finishing or finished, it is Voice Operator's no longer, nor still being spoken.
    if (session.result) return
    this.setListening(id, false)
    void this.voice.cancelTranscription(id)
  }

  /**
   * A connection of the owner's went away. Its dictations still being spoken
   * are cancelled unless it comes back within the grace and carries on —
   * Control holds for them meanwhile, as the user may still be talking. Words
   * for Control not yet handed on are let go of now: the message carrying
   * them went with the connection.
   *
   * Armed on every drop, even with another connection of the owner's still
   * up: anything the owner sends about the dictation calls it off, so a stale
   * socket's late close cannot cancel a dictation going on elsewhere.
   */
  disconnected(owner: string): void {
    for (const [id, session] of this.sessions) {
      if (session.owner !== owner || session.result) continue
      session.cancelGrace?.()
      session.cancelGrace = this.schedule(DICTATION_RESUME_GRACE_MS, () => {
        session.cancelGrace = undefined
        this.cancel(owner, id)
      })
    }
    this.delivered(owner)
  }

  /** The owner is here, about this dictation: a disconnect's cancel is off. */
  private heardFrom(session: Session): void {
    session.cancelGrace?.()
    session.cancelGrace = undefined
  }

  private schedule(ms: number, fn: () => void): () => void {
    return (this.hooks.schedule ?? REAL_SCHEDULE)(ms, fn)
  }

  private owned(owner: string, id: string): Session | undefined {
    const session = this.sessions.get(id)
    return session?.owner === owner ? session : undefined
  }
}
