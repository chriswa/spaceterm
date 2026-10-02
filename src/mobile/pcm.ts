/**
 * Microphone samples → what Voice Operator takes: 16 kHz, signed 16-bit
 * little-endian mono, base64 for the JSON wire.
 *
 * 16 kHz is what Wispr transcribes at, and a third of what the phone records,
 * so resampling here cuts the upload to about 32 KB/s — the dominant cost of
 * dictating over LTE.
 */

export const TARGET_SAMPLE_RATE = 16_000

/**
 * A streaming resampler: feed it blocks at `inputRate`, get 16 kHz back, with
 * no clicks at the block boundaries. Averages each output sample's span of
 * input, which is a crude low-pass but plenty for speech recognition.
 */
export class Downsampler {
  private readonly ratio: number
  /** Fractional position of the next output sample within pending input. */
  private position = 0
  private pending: number[] = []

  constructor(inputRate: number) {
    if (inputRate < TARGET_SAMPLE_RATE) throw new Error(`Cannot upsample from ${inputRate} Hz`)
    this.ratio = inputRate / TARGET_SAMPLE_RATE
  }

  push(block: Float32Array): Int16Array {
    for (let i = 0; i < block.length; i++) this.pending.push(block[i])
    const out: number[] = []
    while (this.position + this.ratio <= this.pending.length) {
      const start = Math.floor(this.position)
      const end = Math.floor(this.position + this.ratio)
      let sum = 0
      for (let i = start; i < end; i++) sum += this.pending[i]
      out.push(sum / Math.max(1, end - start))
      this.position += this.ratio
    }
    const consumed = Math.floor(this.position)
    this.pending = this.pending.slice(consumed)
    this.position -= consumed
    return toInt16(out)
  }
}

function toInt16(samples: ArrayLike<number>): Int16Array {
  const out = new Int16Array(samples.length)
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    out[i] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff)
  }
  return out
}

/** Little-endian bytes as base64. Every platform this runs on is little-endian. */
export function pcmToBase64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength)
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

/**
 * Join a transcript onto what is already in the draft at the cursor: Wispr
 * returns text with a trailing space and no leading one, and dictation often
 * lands mid-sentence.
 */
export function insertDictation(draft: string, cursor: number, transcript: string): { text: string; cursor: number } {
  const spoken = transcript.trim()
  if (!spoken) return { text: draft, cursor }
  const before = draft.slice(0, cursor)
  const after = draft.slice(cursor)
  const lead = before.length > 0 && !/\s$/.test(before) ? ' ' : ''
  const trail = after.length > 0 && !/^\s/.test(after) ? ' ' : ''
  const inserted = lead + spoken + trail
  return { text: before + inserted + after, cursor: before.length + inserted.length }
}
