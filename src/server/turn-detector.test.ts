import { describe, expect, it } from 'vitest'
import { TURN_FRAMES, TurnDetector, lastWindow, whisperFeatures, type TurnModel } from './turn-detector'

/**
 * 2.5 s of a gliding two-tone "voice" under a swelling envelope, at the end of
 * an eight-second window — the same formula as the Python that produced the
 * expected values below (transformers 4.57 `WhisperFeatureExtractor`,
 * `chunk_length=8`, `do_normalize=True`, the Smart Turn reference's settings).
 */
function referenceSignal(): Float32Array {
  const n = 2.5 * 16_000
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const t = i / 16_000
    out[i] = (0.3 * Math.sin(2 * Math.PI * (180 + 60 * t) * t) + 0.1 * Math.sin(2 * Math.PI * 1250 * t)) * Math.sin((Math.PI * t) / 2.5)
  }
  return out
}

/** [mel, frame, value] from the Python reference. */
const REFERENCE: Array<[number, number, number]> = [
  [0, 0, -0.165529], [40, 0, -0.165529], [0, 560, 0.211664], [5, 600, 1.710078],
  [10, 650, 1.025412], [20, 700, -0.165529], [39, 720, -0.165529], [50, 750, -0.165529],
  [79, 780, -0.165529], [3, 799, -0.165529], [12, 799, 0.910719], [60, 640, -0.165529],
]
const REFERENCE_MEAN = -0.07196687161922455

describe('whisperFeatures', () => {
  it('matches transformers\' WhisperFeatureExtractor, which Smart Turn was trained on', () => {
    const features = whisperFeatures(lastWindow(referenceSignal()))
    expect(features.length).toBe(80 * TURN_FRAMES)
    for (const [mel, frame, value] of REFERENCE) expect(features[mel * TURN_FRAMES + frame]).toBeCloseTo(value, 4)
    const mean = features.reduce((sum, v) => sum + v, 0) / features.length
    expect(mean).toBeCloseTo(REFERENCE_MEAN, 4)
  })
})

describe('lastWindow', () => {
  it('pads a short turn at the front, so the audio sits at the end', () => {
    const window = lastWindow(Float32Array.from([1, 2, 3]))
    expect(window.length).toBe(128_000)
    expect(Array.from(window.slice(-3))).toEqual([1, 2, 3])
    expect(window[0]).toBe(0)
  })

  it('keeps only the last eight seconds of a long one', () => {
    const long = new Float32Array(200_000)
    long[long.length - 1] = 0.5
    long[0] = 0.25
    const window = lastWindow(long)
    expect(window.length).toBe(128_000)
    expect(window.at(-1)).toBe(0.5)
    expect(window.includes(0.25)).toBe(false)
  })
})

describe('TurnDetector', () => {
  it('loads the model once and asks it about the features of the last eight seconds', async () => {
    let loads = 0
    const seen: number[] = []
    const model: TurnModel = { run: async (features) => { seen.push(features.length); return 0.93 } }
    const detector = new TurnDetector({ load: async () => { loads++; return model }, log: () => {} })
    expect(await detector.probability(referenceSignal())).toBe(0.93)
    expect(await detector.probability(new Float32Array(16_000))).toBe(0.93)
    expect(loads).toBe(1)
    expect(seen).toEqual([80 * TURN_FRAMES, 80 * TURN_FRAMES])
  })

  it('without a model, answers nothing and says why once', async () => {
    const logged: string[] = []
    const detector = new TurnDetector({ load: async () => { throw new Error('offline') }, log: (m) => logged.push(m) })
    expect(await detector.probability(new Float32Array(16_000))).toBeUndefined()
    expect(await detector.probability(new Float32Array(16_000))).toBeUndefined()
    expect(logged).toEqual(['turn model unavailable: offline'])
  })

  it('can be loaded ahead of the first question', async () => {
    let loads = 0
    const detector = new TurnDetector({ load: async () => { loads++; return { run: async () => 0.1 } }, log: () => {} })
    detector.warm()
    detector.warm()
    expect(await detector.probability(new Float32Array(16_000))).toBe(0.1)
    expect(loads).toBe(1)
  })
})
