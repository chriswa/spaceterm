import { createHash } from 'crypto'
import * as fs from 'fs'
import * as path from 'path'

/**
 * Has the speaker finished their turn? Smart Turn v3.2 (pipecat-ai/smart-turn,
 * BSD-2): an 8 MB int8 model — Whisper Tiny's encoder and a linear classifier —
 * that listens to the last eight seconds of a turn and judges, from grammar,
 * intonation and pace together, whether it sounds finished. "Tell Kevin to run
 * the tests and" is not; "Tell Kevin to run the tests." is.
 *
 * Hands-free mode asks at each pause in a dictation (hands-free.ts), so a
 * finished thought ends it quickly and a thinking pause does not.
 *
 * Runs here, in the server, which already holds every dictation's audio on its
 * way to Voice Operator. Whisper's feature extraction is ported below and
 * checked number for number against the Python reference
 * (`turn-detector.test.ts`). The model is fetched once from Hugging Face, at a
 * pinned revision, checked by hash, and kept in `~/.spaceterm/models`; it is
 * loaded when the first hands-free dictation starts and stays loaded — about
 * 130 MB of the server's memory, mostly ONNX Runtime itself (measured on an
 * M1 Max) — and answers in about 45 ms, features included, on the CPU.
 */

export const TURN_SAMPLE_RATE = 16_000
/** The model hears the last eight seconds; shorter turns are padded at the front. */
export const TURN_WINDOW_SECONDS = 8
const WINDOW = TURN_WINDOW_SECONDS * TURN_SAMPLE_RATE

// Whisper's log-mel spectrogram: 25 ms frames every 10 ms, 80 mel bands to 8 kHz.
const N_FFT = 400
const HOP = 160
const N_MELS = 80
const N_FREQS = N_FFT / 2 + 1
export const TURN_FRAMES = WINDOW / HOP

/** The last eight seconds of `audio`, zero-padded at the front — as Smart Turn's reference does. */
export function lastWindow(audio: Float32Array): Float32Array {
  if (audio.length >= WINDOW) return audio.slice(audio.length - WINDOW)
  const out = new Float32Array(WINDOW)
  out.set(audio, WINDOW - audio.length)
  return out
}

/** Slaney's mel scale, as librosa and transformers' `mel_filter_bank` use it. */
function hertzToMel(hz: number): number {
  const minLogHertz = 1000
  const minLogMel = 15
  const logstep = 27 / Math.log(6.4)
  return hz < minLogHertz ? (3 * hz) / 200 : minLogMel + Math.log(hz / minLogHertz) * logstep
}

function melToHertz(mel: number): number {
  const minLogHertz = 1000
  const minLogMel = 15
  const logstep = Math.log(6.4) / 27
  return mel < minLogMel ? (200 * mel) / 3 : minLogHertz * Math.exp(logstep * (mel - minLogMel))
}

/** Triangular filters, Slaney-normalised: `[mel][frequency bin]`. */
function melFilters(): Float64Array[] {
  const fftFreqs = Array.from({ length: N_FREQS }, (_, i) => (i * (TURN_SAMPLE_RATE / 2)) / (N_FREQS - 1))
  const minMel = hertzToMel(0)
  const maxMel = hertzToMel(TURN_SAMPLE_RATE / 2)
  const filterFreqs = Array.from({ length: N_MELS + 2 }, (_, i) => melToHertz(minMel + ((maxMel - minMel) * i) / (N_MELS + 1)))
  const filters: Float64Array[] = []
  for (let m = 0; m < N_MELS; m++) {
    const row = new Float64Array(N_FREQS)
    const lower = filterFreqs[m]
    const centre = filterFreqs[m + 1]
    const upper = filterFreqs[m + 2]
    const enorm = 2 / (upper - lower)
    for (let k = 0; k < N_FREQS; k++) {
      const f = fftFreqs[k]
      const down = (f - lower) / (centre - lower)
      const up = (upper - f) / (upper - centre)
      row[k] = Math.max(0, Math.min(down, up)) * enorm
    }
    filters.push(row)
  }
  return filters
}

let tables: { filters: Float64Array[]; window: Float64Array; cos: Float64Array; sin: Float64Array } | undefined

function getTables() {
  if (tables) return tables
  // A periodic Hann window, as `window_function(400, "hann")`.
  const window = Float64Array.from({ length: N_FFT }, (_, n) => 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / N_FFT))
  const cos = new Float64Array(N_FREQS * N_FFT)
  const sin = new Float64Array(N_FREQS * N_FFT)
  for (let k = 0; k < N_FREQS; k++) {
    for (let n = 0; n < N_FFT; n++) {
      const angle = (2 * Math.PI * ((k * n) % N_FFT)) / N_FFT
      cos[k * N_FFT + n] = Math.cos(angle)
      sin[k * N_FFT + n] = Math.sin(angle)
    }
  }
  tables = { filters: melFilters(), window, cos, sin }
  return tables
}

/**
 * Whisper's input features for an eight-second window, as transformers'
 * `WhisperFeatureExtractor(chunk_length=8)` computes them with
 * `do_normalize=True`: the waveform scaled to zero mean and unit variance,
 * a centred STFT with reflect padding, the power spectrum through the mel
 * filters, log10, the last frame dropped, floored at 8 below the peak, and
 * mapped by (x + 4) / 4. Returns `[mel][frame]`, 80 × 800, row-major.
 */
export function whisperFeatures(window8s: Float32Array): Float32Array {
  if (window8s.length !== WINDOW) throw new Error(`expected ${WINDOW} samples, got ${window8s.length}`)
  const { filters, window, cos, sin } = getTables()

  // Zero mean, unit variance, over the whole window, padding included.
  let mean = 0
  for (let i = 0; i < WINDOW; i++) mean += window8s[i]
  mean /= WINDOW
  let variance = 0
  for (let i = 0; i < WINDOW; i++) variance += (window8s[i] - mean) ** 2
  variance /= WINDOW
  const scale = 1 / Math.sqrt(variance + 1e-7)

  // Reflect-padded by half a frame either side, so frame t is centred on sample t × HOP.
  const pad = N_FFT / 2
  const padded = new Float64Array(WINDOW + 2 * pad)
  for (let i = 0; i < padded.length; i++) {
    let j = i - pad
    if (j < 0) j = -j
    else if (j >= WINDOW) j = 2 * (WINDOW - 1) - j
    padded[i] = (window8s[j] - mean) * scale
  }

  const frames = TURN_FRAMES // 801 frames, the last dropped
  const logMel = new Float64Array(N_MELS * frames)
  const frame = new Float64Array(N_FFT)
  const power = new Float64Array(N_FREQS)
  // Frames that lie wholly in the padding are all alike: computed once.
  let constantFrame: Float64Array | undefined
  let peak = -Infinity
  for (let t = 0; t < frames; t++) {
    const start = t * HOP
    let flat = true
    for (let n = 0; n < N_FFT; n++) {
      frame[n] = padded[start + n] * window[n]
      if (padded[start + n] !== padded[start]) flat = false
    }
    let mel: Float64Array
    if (flat && constantFrame && padded[start] === padded[0]) {
      mel = constantFrame
    } else {
      for (let k = 0; k < N_FREQS; k++) {
        let re = 0
        let im = 0
        const row = k * N_FFT
        for (let n = 0; n < N_FFT; n++) {
          re += frame[n] * cos[row + n]
          im -= frame[n] * sin[row + n]
        }
        power[k] = re * re + im * im
      }
      mel = new Float64Array(N_MELS)
      for (let m = 0; m < N_MELS; m++) {
        const filter = filters[m]
        let sum = 0
        for (let k = 0; k < N_FREQS; k++) sum += filter[k] * power[k]
        mel[m] = Math.log10(Math.max(1e-10, sum))
      }
      if (flat && padded[start] === padded[0]) constantFrame = mel
    }
    for (let m = 0; m < N_MELS; m++) {
      logMel[m * frames + t] = mel[m]
      if (mel[m] > peak) peak = mel[m]
    }
  }

  const out = new Float32Array(N_MELS * frames)
  const floor = peak - 8
  for (let i = 0; i < out.length; i++) out[i] = (Math.max(logMel[i], floor) + 4) / 4
  return out
}

/** Where the model comes from: Hugging Face, at a pinned revision, checked by hash. */
export const SMART_TURN_MODEL = {
  file: 'smart-turn-v3.2-cpu.onnx',
  url: 'https://huggingface.co/pipecat-ai/smart-turn-v3/resolve/f766f81d3cfdf7737ac64aad813d91bbfd56bf93/smart-turn-v3.2-cpu.onnx',
  sha256: '2bb026316b14a660486a75b1733cd3fbab8c2fd0314dc9af7be49f8cca967e4f',
}

/** The model, loaded: features in, probability the turn is complete out. */
export interface TurnModel {
  run(features: Float32Array): Promise<number>
}

export interface TurnDetectorDeps {
  /** Load the model — fetching it first if it is not on disk yet. */
  load(): Promise<TurnModel>
  log(message: string): void
}

/** Fetch the model into `dir` once; afterwards, just its path. */
async function ensureModel(dir: string, log: (message: string) => void): Promise<string> {
  const file = path.join(dir, SMART_TURN_MODEL.file)
  if (fs.existsSync(file)) return file
  log(`fetching ${SMART_TURN_MODEL.file} (8 MB) from Hugging Face`)
  const response = await fetch(SMART_TURN_MODEL.url)
  if (!response.ok) throw new Error(`fetching the turn model failed: HTTP ${response.status}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  const hash = createHash('sha256').update(bytes).digest('hex')
  if (hash !== SMART_TURN_MODEL.sha256) throw new Error(`the turn model's hash is ${hash}, not the pinned one`)
  fs.mkdirSync(dir, { recursive: true })
  const partial = `${file}.partial`
  fs.writeFileSync(partial, bytes)
  fs.renameSync(partial, file)
  return file
}

/** The real thing: ONNX Runtime on the CPU, one thread, as the reference runs it. */
export function realTurnDetectorDeps(modelDir: string, log: (message: string) => void): TurnDetectorDeps {
  return {
    log,
    async load() {
      const file = await ensureModel(modelDir, log)
      const ort = await import('onnxruntime-node')
      const session = await ort.InferenceSession.create(file, {
        executionMode: 'sequential', interOpNumThreads: 1, intraOpNumThreads: 1, graphOptimizationLevel: 'all',
        // No pre-grown arena: measured, it saves about 13 MB of the ~130 MB the runtime costs.
        enableCpuMemArena: false, enableMemPattern: false,
      })
      return {
        async run(features) {
          const input = new ort.Tensor('float32', features, [1, N_MELS, TURN_FRAMES])
          const outputs = await session.run({ [session.inputNames[0]]: input })
          return Number((outputs[session.outputNames[0]].data as Float32Array)[0])
        },
      }
    },
  }
}

/**
 * The turn model, loaded on first use and kept. A model that will not load
 * says so once in the log and answers nothing afterwards, so hands-free
 * mode falls back on silence alone.
 */
export class TurnDetector {
  private loading: Promise<TurnModel | undefined> | undefined

  constructor(private readonly deps: TurnDetectorDeps) {}

  /** Load the model now, ahead of the first question — a dictation that will ask has begun. */
  warm(): void {
    void this.model()
  }

  /** Probability, 0..1, that 16 kHz `audio` — the turn so far, ending now — is finished. Undefined without a model. */
  async probability(audio: Float32Array): Promise<number | undefined> {
    const model = await this.model()
    if (!model) return undefined
    return model.run(whisperFeatures(lastWindow(audio)))
  }

  private model(): Promise<TurnModel | undefined> {
    this.loading ??= this.deps.load().then((model) => {
      this.deps.log('turn model loaded')
      return model
    }, (err) => {
      this.deps.log(`turn model unavailable: ${err instanceof Error ? err.message : String(err)}`)
      return undefined
    })
    return this.loading
  }
}
