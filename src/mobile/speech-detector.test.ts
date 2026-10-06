// @vitest-environment node
import { readFileSync } from 'fs'
import { join } from 'path'
import * as ort from 'onnxruntime-node'
import { beforeAll, describe, expect, it } from 'vitest'
import { SileroVad } from './speech-detector'

/**
 * The real model, through the same streaming wrapper the phone uses — on
 * onnxruntime-node rather than ONNX Runtime web, which run the same graph.
 * "Control." is `say -v Samantha` at 16 kHz (testdata/); the noise is seeded.
 */
const here = __dirname
const word = (() => {
  const bytes = readFileSync(join(here, 'vad/testdata/control-16k-s16le.pcm'))
  return new Int16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length))
})()

let seed = 11
const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1
const signal = (seconds: number, f: (i: number) => number) => Int16Array.from({ length: seconds * 16_000 }, (_, i) => Math.round(f(i)))
const whiteNoise = (amplitude: number) => signal(3, () => random() * amplitude)
/** Three notes of a chord, swelling twice a second: music to a voice detector. */
const music = signal(3, (i) => 4800 * (Math.sin((2 * Math.PI * 261.6 * i) / 16_000) + Math.sin((2 * Math.PI * 329.6 * i) / 16_000) + Math.sin((2 * Math.PI * 392 * i) / 16_000)) * (0.6 + 0.4 * Math.sin((2 * Math.PI * 2 * i) / 16_000)))
/** The word a second into `background`. */
const over = (background: Int16Array) => {
  const out = Int16Array.from(background)
  for (let i = 0; i < word.length; i++) out[16_000 + i] = Math.max(-32768, Math.min(32767, out[16_000 + i] + word[i]))
  return out
}

let vad: SileroVad
beforeAll(async () => {
  const session = await ort.InferenceSession.create(join(here, 'vad/silero_vad_16k_op15.onnx'))
  const sr = new ort.Tensor('int64', BigInt64Array.from([16_000n]), [])
  vad = new SileroVad(async (input, state) => {
    const out = await session.run({ input: new ort.Tensor('float32', input, [1, 576]), state: new ort.Tensor('float32', state, [2, 1, 128]), sr })
    return { p: (out.output.data as Float32Array)[0], state: out.stateN.data as Float32Array }
  })
})

/** How many 32 ms frames it hears as speech. */
async function speechFrames(audio: Int16Array): Promise<number> {
  vad.reset()
  let count = 0
  for (let i = 0; i + 512 <= audio.length; i += 512) if (await vad.score(audio.slice(i, i + 512)) >= 0.5) count++
  return count
}

describe('Silero VAD', () => {
  it('hears no speech in loud noise or music, however loud', async () => {
    expect(await speechFrames(whiteNoise(200))).toBe(0)
    expect(await speechFrames(whiteNoise(6000))).toBe(0)
    expect(await speechFrames(music)).toBe(0)
  })

  it('hears "Control" — about its length — on its own, over loud noise, and over music', async () => {
    const wordFrames = Math.round(word.length / 512)
    for (const audio of [over(whiteNoise(200)), over(whiteNoise(3000)), over(music)]) {
      const frames = await speechFrames(audio)
      expect(frames).toBeGreaterThan(wordFrames * 0.5)
      expect(frames).toBeLessThan(wordFrames * 1.5)
    }
  })
})
