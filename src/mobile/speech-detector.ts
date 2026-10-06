import { EnergyScorer } from './wake-listener'

/**
 * Is someone talking in this frame? The probability, per 32 ms frame, that
 * hands-free mode's listener works from (wake-listener.ts).
 *
 * Silero VAD (snakers4/silero-vad, MIT; `vad/silero_vad_16k_op15.onnx`, 1.3 MB)
 * is a small voice-activity model trained to tell speech from everything else
 * — so loud white noise and music score as not-speech, and a word said over
 * them scores as speech (checked: `speech-detector.test.ts`). It runs here, on
 * the phone, in ONNX Runtime's WebAssembly build, well under a millisecond a
 * frame; nothing it hears leaves the phone.
 *
 * Without it — the runtime would not load — loudness stands in
 * (`EnergyScorer`), which hears music and chatter as speech.
 */

/** Scores frames of 512 16 kHz samples, in order: it carries state from one to the next. */
export interface FrameScorer {
  readonly name: string
  score(frame: Int16Array): number | Promise<number>
  /** Forget the audio so far: a new stream, after a gap. */
  reset(): void
}

/** One step of the model: 64 samples of context then 512 new, and its recurrent state. */
export type SileroStep = (input: Float32Array, state: Float32Array) => Promise<{ p: number; state: Float32Array }>

const CONTEXT = 64
const FRAME = 512
const STATE = 2 * 1 * 128

/**
 * Silero VAD's streaming wrapper, as its own `OnnxWrapper` does it: each frame
 * goes in behind the last 64 samples of the one before, with the state the
 * model handed back. The runtime is `step`'s, so the same code runs on
 * ONNX Runtime web here and on onnxruntime-node in a test.
 */
export class SileroVad implements FrameScorer {
  readonly name = 'silero'
  private state: Float32Array = new Float32Array(STATE)
  private context: Float32Array = new Float32Array(CONTEXT)

  constructor(private readonly step: SileroStep) {}

  async score(frame: Int16Array): Promise<number> {
    if (frame.length !== FRAME) throw new Error(`Silero takes ${FRAME} samples, got ${frame.length}`)
    const input = new Float32Array(CONTEXT + FRAME)
    input.set(this.context)
    for (let i = 0; i < FRAME; i++) input[CONTEXT + i] = frame[i] / 32768
    const { p, state } = await this.step(input, this.state)
    this.state = state
    this.context = input.slice(FRAME)
    return p
  }

  reset(): void {
    this.state = new Float32Array(STATE)
    this.context = new Float32Array(CONTEXT)
  }
}

/** Load Silero on ONNX Runtime web: the model and the runtime's WebAssembly are assets of this build. */
export async function loadSileroVad(): Promise<SileroVad> {
  const [ort, { default: modelUrl }, { default: wasmUrl }] = await Promise.all([
    import('onnxruntime-web/wasm'),
    import('./vad/silero_vad_16k_op15.onnx?url'),
    import('../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm?url'),
  ])
  // One thread: threads need cross-origin isolation, which the page does not have, and one frame is tiny.
  ort.env.wasm.numThreads = 1
  ort.env.wasm.wasmPaths = { wasm: wasmUrl }
  const session = await ort.InferenceSession.create(modelUrl, { executionProviders: ['wasm'] })
  const sr = new ort.Tensor('int64', BigInt64Array.from([16_000n]), [])
  return new SileroVad(async (input, state) => {
    const out = await session.run({
      input: new ort.Tensor('float32', input, [1, CONTEXT + FRAME]),
      state: new ort.Tensor('float32', state, [2, 1, 128]),
      sr,
    })
    return { p: (out.output.data as Float32Array)[0], state: out.stateN.data as Float32Array }
  })
}

/** Silero if it loads; loudness otherwise, saying why. */
export async function loadFrameScorer(log: (message: string) => void): Promise<FrameScorer> {
  try {
    const started = performance.now()
    const silero = await loadSileroVad()
    log(`speech detector: Silero VAD, loaded in ${Math.round(performance.now() - started)}ms`)
    return silero
  } catch (err) {
    log(`speech detector: Silero VAD would not load (${err instanceof Error ? err.message : String(err)}); using loudness`)
    return new EnergyScorer()
  }
}
