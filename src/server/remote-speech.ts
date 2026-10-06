import { randomUUID } from 'crypto'
import type { ServerMessage, SpeechProgressEvent } from '../shared/protocol'
import { speechPartStarts, type SpeechBackend, type SpeechContent, type SpeechResponse, type SpeechStatus, type SynthesizedSpeech, type TimedWord } from './voice-operator'
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
  /** One sentence's audio and its word timings, or undefined when it could not be made. */
  synthesize(text: string, voice: string | undefined, signal: AbortSignal): Promise<SynthesizedSpeech | undefined>
  /** Send to a connected client; false when it is not connected. */
  send(clientId: string, msg: ServerMessage): boolean
  isConnected(clientId: string): boolean
  /** Job ids; random unless a test wants them predictable. */
  newId?(): string
  /** A job starting and ending, for the phone's audio record (mobile-events.ts). */
  record?(clientId: string, kind: string, detail: Record<string, unknown>): void
}

/** A sentence to speak. `start`/`end` index the job's whole text — see `joinSpeechParts`. */
interface Sentence { text: string; start: number; end: number; voice?: string }

/** A sentence's audio as sent: how long it runs, and where its words fall, when they were timed. */
interface SentenceAudio { seconds: number; words?: TimedWord[] }

/** The sentence the client is playing, and when it said it started. */
interface Playing { index: number; startedAt: number; audio: SentenceAudio }

interface Job {
  id: string
  clientId: string
  sentences: Sentence[]
  state: SpeechStatus['state']
  playback: NonNullable<SpeechStatus['playback_state']>
  /**
   * What was heard: past the last sentence the client finished playing, and
   * on a cut, into the one it was part way through — see `cutOff`.
   */
  offset: number
  /** Each sentence's audio, once synthesized. */
  audio: SentenceAudio[]
  playing?: Playing
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

/**
 * Split speech content into sentences, each carrying its own voice.
 *
 * Segmentation is per part — a sentence never spans a voice change — but every
 * offset is into `joinSpeechParts(content)`, so an interruption offset from the
 * phone means the same thing as one from Voice Operator. Unvoiced parts, and
 * plain text, take `voice`.
 */
export function splitSpeech(content: SpeechContent, voice?: string): Sentence[] {
  const parts = typeof content === 'string' ? [{ text: content }] : content
  const starts = speechPartStarts(parts)
  const out: Sentence[] = []
  for (const [index, part] of parts.entries()) {
    const base = starts[index]
    const partVoice = part.voice ?? voice
    for (const sentence of splitSentences(part.text)) {
      out.push({
        text: sentence.text, start: base + sentence.start, end: base + sentence.end,
        ...(partVoice ? { voice: partVoice } : {}),
      })
    }
  }
  return out
}

const randomJobId = () => `rs_${randomUUID()}`

export class RemoteSpeech {
  private readonly jobs = new Map<string, Job>()
  /**
   * Each client's jobs are sent one after another, in the order they were
   * spoken: "let me check" and the answer behind it used to be synthesized
   * side by side, and their sentences reached the phone interleaved.
   */
  private readonly lanes = new Map<string, Promise<void>>()

  constructor(private readonly deps: RemoteSpeechDeps) {}

  /**
   * Speech that plays on `clientId`, or on `fallback` (Voice Operator) when
   * that client is not connected when an answer starts — a conversation begun
   * on the phone still answers if the phone has gone.
   */
  forClient(clientId: string, fallback: SpeechBackend): SpeechBackend {
    return {
      speak: (content, voice) => this.deps.isConnected(clientId) ? this.speak(clientId, content, voice) : fallback.speak(content, voice),
      status: (id, opts, init, timeoutMs) => this.jobs.has(id) ? this.status(id, opts, init?.signal ?? undefined) : fallback.status(id, opts, init, timeoutMs),
      drop: (id) => this.jobs.has(id) ? this.drop(id) : fallback.drop(id),
    }
  }

  /** The client's account of its playback. `now` is when it arrived. */
  progress(clientId: string, id: string, index: number, event: SpeechProgressEvent, now = Date.now()): void {
    const job = this.jobs.get(id)
    if (!job || job.clientId !== clientId || job.state !== 'in_progress') return
    if (event === 'started') {
      const audio = job.audio[index]
      if (audio) job.playing = { index, startedAt: now, audio }
      if (job.playback !== 'speaking') this.change(job, () => { job.playback = 'speaking' })
    } else if (event === 'finished') {
      if (!job.sentences[index]) return
      if (job.playing?.index === index) job.playing = undefined
      this.change(job, () => {
        job.offset = Math.max(job.offset, heardThrough(job.sentences, index))
        if (index === job.sentences.length - 1) job.state = 'completed'
      })
      if (index === job.sentences.length - 1) this.deps.record?.(job.clientId, 'speech-job-ended', { id: job.id.slice(0, 11), state: 'completed' })
    } else {
      serverLog(`[remote-speech] ${id} could not be played on ${clientId.slice(0, 8)}`)
      this.end(job, 'synthesis_failed')
    }
  }

  /** The client went away: whatever it was playing has stopped where it got to. */
  clientGone(clientId: string, now = Date.now()): void {
    this.lanes.delete(clientId)
    for (const job of this.jobs.values()) {
      if (job.clientId === clientId && job.state === 'in_progress') {
        this.cutOff(job, now)
        this.end(job, 'cancelled_by_client')
      }
    }
  }

  private async speak(clientId: string, content: SpeechContent, voice: string | undefined): Promise<SpeechResponse> {
    const sentences = splitSpeech(content, voice)
    if (!sentences.length) return { status: 400, body: { error: 'text_required' } }
    const job: Job = {
      id: this.deps.newId?.() ?? randomJobId(),
      clientId,
      sentences,
      state: 'in_progress',
      playback: 'queued',
      offset: 0,
      audio: [],
      version: 1,
      abort: new AbortController(),
      changed: new Set(),
    }
    this.jobs.set(job.id, job)
    this.deps.record?.(clientId, 'speech-job', { id: job.id.slice(0, 11), sentences: sentences.length, chars: sentences.reduce((n, s) => n + s.text.length, 0) })
    this.prune()
    const lane = (this.lanes.get(clientId) ?? Promise.resolve()).then(() => this.pump(job))
    this.lanes.set(clientId, lane.catch(() => undefined))
    return { status: 202, body: this.snapshot(job) }
  }

  /** Synthesize each sentence in turn and send it on; the client queues them. */
  private async pump(job: Job): Promise<void> {
    for (const [index, sentence] of job.sentences.entries()) {
      // Dropped while it waited its turn in the lane, or between sentences.
      if (job.state !== 'in_progress') return
      const audio = await this.deps.synthesize(sentence.text, sentence.voice, job.abort.signal)
      if (job.state !== 'in_progress') return
      if (!audio) {
        serverLog(`[remote-speech] ${job.id} sentence ${index + 1}/${job.sentences.length} could not be synthesized`)
        this.end(job, 'synthesis_failed')
        return
      }
      // s16le mono: two bytes a sample.
      job.audio[index] = { seconds: audio.pcm.byteLength / 2 / audio.sampleRate, words: audio.words }
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
    const body = this.snapshot(job)
    // Mid-speech, where the voice is now: word by word through the sentence
    // playing, as Voice Operator reports the speech it plays itself.
    if (job.state === 'in_progress') body.character_offset = this.heardOffset(job, Date.now())
    return { status: httpStatus(job.state), body }
  }

  private async drop(id: string, now = Date.now()): Promise<SpeechResponse> {
    const job = this.jobs.get(id)
    if (!job) return { status: 404, body: { error: 'unknown_job' } }
    if (job.state === 'in_progress') {
      this.cutOff(job, now)
      this.end(job, 'cancelled_by_client')
    }
    return { status: httpStatus(job.state), body: this.snapshot(job) }
  }

  /**
   * Count what was heard of the sentence playing when the job was cut off.
   *
   * The phone reports only sentence boundaries, and a sentence can run for
   * seconds: counting only finished ones once told the receptionist the
   * listener had heard none of a question they were already answering. So the
   * time since the phone said the sentence started is looked up in its word
   * timings, by Voice Operator's own rule for speech it plays itself: a word
   * counts once it has started, and the offset lands just past it, so
   * `redactUnheard` marks it as the word the listener cut in on.
   *
   * The clock is this server's, so it is off by however long the "started"
   * report took to arrive, less however long the phone keeps playing until the
   * stop reaches it. Both are network hops on the same link, far shorter than
   * a word.
   *
   * Untimed audio, from an older Voice Operator or words it could not align,
   * counts nothing of the sentence rather than guessing.
   */
  private cutOff(job: Job, now: number): void {
    job.offset = this.heardOffset(job, now)
  }

  /** How much of the job has been heard at `now`, without changing the job: see `cutOff`. */
  private heardOffset(job: Job, now: number): number {
    const playing = job.playing
    if (!playing) return job.offset
    const elapsed = (now - playing.startedAt) / 1000
    if (elapsed >= playing.audio.seconds) return Math.max(job.offset, heardThrough(job.sentences, playing.index))
    const word = playing.audio.words?.filter((w) => w.start <= elapsed).at(-1)
    return word ? Math.max(job.offset, job.sentences[playing.index].start + word.characterEnd) : job.offset
  }

  private end(job: Job, state: Exclude<SpeechStatus['state'], 'in_progress'>): void {
    this.deps.record?.(job.clientId, 'speech-job-ended', { id: job.id.slice(0, 11), state, heardChars: job.offset })
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

/**
 * The offset that says every sentence up to `index` was heard in full: the
 * start of the next one, past the whitespace between them, which is what
 * `redactUnheard` reads as a sentence finished. An offset at the sentence's own
 * last character reads as a cut just past its last word, which dropped that
 * word from what was heard.
 */
function heardThrough(sentences: readonly Sentence[], index: number): number {
  return sentences[index + 1]?.start ?? sentences[index].end
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
