import { randomUUID } from 'crypto'
import type { ServerMessage, SpeechProgressEvent } from '../shared/protocol'
import type { SpeechBackend, SpeechResponse, SpeechStatus } from './voice-operator'
import { serverLog } from './server-log'

/**
 * Speech for a client that plays it itself — the phone. Remote dictation in
 * reverse: Voice Operator synthesizes (it holds the synthesizer), this relays
 * the audio to the client sentence by sentence, and the client says how far
 * it has played.
 *
 * Each job answers in Voice Operator's own job format — `speak`, a `status`
 * that long-polls, `drop` with how far the listener got — so Summary Chat
 * follows a phone's speech exactly as it follows the Mac's. Playback progress
 * comes from the phone, which is the only side that knows what was audible.
 */

export interface RemoteSpeechDeps {
  /** One sentence's audio, or undefined when it could not be made. */
  synthesize(text: string, voice: string | undefined, signal: AbortSignal): Promise<{ pcm: Uint8Array; sampleRate: number } | undefined>
  /** Send to a connected client; false when it is not connected. */
  send(clientId: string, msg: ServerMessage): boolean
  isConnected(clientId: string): boolean
  /** Job ids; random unless a test wants them predictable. */
  newId?(): string
}

interface Sentence { text: string; start: number; end: number }

interface Job {
  id: string
  clientId: string
  sentences: Sentence[]
  state: SpeechStatus['state']
  playback: NonNullable<SpeechStatus['playback_state']>
  /** End of the last sentence the client finished playing: what was heard. */
  offset: number
  version: number
  abort: AbortController
  changed: Set<() => void>
}

/** Finished jobs kept for a late status or drop; the oldest beyond this go. */
const KEEP_FINISHED = 32

/**
 * Split for speaking: each sentence with its place in the text, so what the
 * client has played maps back to a character offset. Whitespace between
 * sentences belongs to neither.
 */
export function splitSentences(text: string): Sentence[] {
  const out: Sentence[] = []
  for (const match of text.matchAll(/[^.!?]+(?:[.!?]+["')\]]*|$)/g)) {
    const raw = match[0]
    const lead = raw.length - raw.trimStart().length
    const trimmed = raw.trim()
    if (!trimmed) continue
    const start = match.index + lead
    out.push({ text: trimmed, start, end: start + trimmed.length })
  }
  return out
}

const randomJobId = () => `rs_${randomUUID()}`

export class RemoteSpeech {
  private readonly jobs = new Map<string, Job>()

  constructor(private readonly deps: RemoteSpeechDeps) {}

  /**
   * Speech that plays on `clientId`, or on `fallback` (Voice Operator) when
   * that client is not connected when an answer starts — a conversation begun
   * on the phone still answers if the phone has gone.
   */
  forClient(clientId: string, fallback: SpeechBackend): SpeechBackend {
    return {
      speak: (text, voice) => this.deps.isConnected(clientId) ? this.speak(clientId, text, voice) : fallback.speak(text, voice),
      status: (id, opts, init, timeoutMs) => this.jobs.has(id) ? this.status(id, opts, init?.signal ?? undefined) : fallback.status(id, opts, init, timeoutMs),
      drop: (id) => this.jobs.has(id) ? this.drop(id) : fallback.drop(id),
    }
  }

  /** The client's account of its playback. */
  progress(clientId: string, id: string, index: number, event: SpeechProgressEvent): void {
    const job = this.jobs.get(id)
    if (!job || job.clientId !== clientId || job.state !== 'in_progress') return
    if (event === 'started') {
      if (job.playback !== 'speaking') this.change(job, () => { job.playback = 'speaking' })
    } else if (event === 'finished') {
      const sentence = job.sentences[index]
      if (!sentence) return
      this.change(job, () => {
        job.offset = Math.max(job.offset, sentence.end)
        if (index === job.sentences.length - 1) job.state = 'completed'
      })
    } else {
      serverLog(`[remote-speech] ${id} could not be played on ${clientId.slice(0, 8)}`)
      this.end(job, 'synthesis_failed')
    }
  }

  /** The client went away: whatever it was playing has stopped where it got to. */
  clientGone(clientId: string): void {
    for (const job of this.jobs.values()) {
      if (job.clientId === clientId && job.state === 'in_progress') this.end(job, 'cancelled_by_client')
    }
  }

  private async speak(clientId: string, text: string, voice: string | undefined): Promise<SpeechResponse> {
    const sentences = splitSentences(text)
    if (!sentences.length) return { status: 400, body: { error: 'text_required' } }
    const job: Job = {
      id: this.deps.newId?.() ?? randomJobId(),
      clientId,
      sentences,
      state: 'in_progress',
      playback: 'queued',
      offset: 0,
      version: 1,
      abort: new AbortController(),
      changed: new Set(),
    }
    this.jobs.set(job.id, job)
    this.prune()
    void this.pump(job, voice)
    return { status: 202, body: this.snapshot(job) }
  }

  /** Synthesize each sentence in turn and send it on; the client queues them. */
  private async pump(job: Job, voice: string | undefined): Promise<void> {
    for (const [index, sentence] of job.sentences.entries()) {
      const audio = await this.deps.synthesize(sentence.text, voice, job.abort.signal)
      if (job.state !== 'in_progress') return
      if (!audio) {
        serverLog(`[remote-speech] ${job.id} sentence ${index + 1}/${job.sentences.length} could not be synthesized`)
        this.end(job, 'synthesis_failed')
        return
      }
      const sent = this.deps.send(job.clientId, {
        type: 'speech-audio',
        id: job.id,
        index,
        count: job.sentences.length,
        sampleRate: audio.sampleRate,
        pcm: Buffer.from(audio.pcm).toString('base64'),
      })
      if (!sent) {
        this.end(job, 'cancelled_by_client')
        return
      }
    }
  }

  private async status(id: string, opts: { wait?: number; since?: number } = {}, signal?: AbortSignal): Promise<SpeechResponse> {
    const job = this.jobs.get(id)
    if (!job) return { status: 404, body: { error: 'unknown_job' } }
    const wait = opts.wait ?? 0
    // As Voice Operator: with a cursor, wait for any change past it; without,
    // wait for the job to end.
    const settled = () => opts.since === undefined ? job.state !== 'in_progress' : job.version > opts.since
    if (wait > 0 && !settled()) {
      await new Promise<void>((resolve) => {
        let timer: ReturnType<typeof setTimeout> | undefined = undefined
        const done = () => {
          clearTimeout(timer)
          job.changed.delete(done)
          signal?.removeEventListener('abort', done)
          resolve()
        }
        timer = setTimeout(done, wait * 1000)
        job.changed.add(done)
        signal?.addEventListener('abort', done)
      })
    }
    return { status: httpStatus(job.state), body: this.snapshot(job) }
  }

  private async drop(id: string): Promise<SpeechResponse> {
    const job = this.jobs.get(id)
    if (!job) return { status: 404, body: { error: 'unknown_job' } }
    if (job.state === 'in_progress') this.end(job, 'cancelled_by_client')
    return { status: httpStatus(job.state), body: this.snapshot(job) }
  }

  private end(job: Job, state: Exclude<SpeechStatus['state'], 'in_progress'>): void {
    this.change(job, () => { job.state = state })
    job.abort.abort()
    // Stop the client too, unless it is the one that finished.
    if (state !== 'completed') this.deps.send(job.clientId, { type: 'speech-stop', id: job.id })
  }

  private change(job: Job, apply: () => void): void {
    apply()
    job.version++
    for (const notify of [...job.changed]) notify()
  }

  private snapshot(job: Job): SpeechStatus {
    return {
      id: job.id,
      state: job.state,
      ...(job.state === 'in_progress' ? { playback_state: job.playback } : {}),
      character_offset: job.offset,
      version: job.version,
    }
  }

  private prune(): void {
    const finished = [...this.jobs.values()].filter((j) => j.state !== 'in_progress')
    for (const job of finished.slice(0, Math.max(0, finished.length - KEEP_FINISHED))) this.jobs.delete(job.id)
  }
}

/** The HTTP status Voice Operator answers a job in this state with. */
function httpStatus(state: SpeechStatus['state']): number {
  switch (state) {
    case 'completed': return 200
    case 'interrupted_by_user': return 409
    case 'cancelled_by_client': return 410
    case 'synthesis_failed': return 500
    default: return 202
  }
}
