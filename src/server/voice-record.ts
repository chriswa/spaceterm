import * as fs from 'fs'
import * as path from 'path'

/**
 * The record of what hands-free mode heard and decided, kept on the Mac for
 * review: every wake-word and speech check (what Apple's model heard, and
 * whether it counted), every Smart Turn verdict, and every phone dictation's
 * transcript — each with its time, and with the audio it was decided on.
 *
 * `voice-decisions.jsonl` holds one JSON object per line. Its `clip` names a
 * WAV in `voice-clips/` (16 kHz mono): the clip that was checked for the wake
 * word, or the eight seconds Smart Turn heard. Clips are pruned to the newest
 * `MAX_CLIPS`; the lines are kept.
 *
 * This is the one place hands-free keeps what was said, on purpose — so a
 * "Control" heard as "patrol", or a finished sentence Smart Turn called
 * unfinished, can be found and listened to afterwards.
 */

export const MAX_CLIPS = 400

/** What it writes to, so a test can supply its own. */
export interface VoiceRecordDeps {
  appendLine(line: string): void
  writeClip(name: string, wav: Uint8Array): void
  /** Clip names, any order. */
  listClips(): string[]
  removeClip(name: string): void
}

export function realVoiceRecordDeps(dir: string): VoiceRecordDeps {
  const clips = path.join(dir, 'voice-clips')
  const ensure = () => fs.mkdirSync(clips, { recursive: true })
  return {
    appendLine: (line) => fs.appendFileSync(path.join(dir, 'voice-decisions.jsonl'), `${line}\n`),
    writeClip: (name, wav) => { ensure(); fs.writeFileSync(path.join(clips, name), wav) },
    listClips: () => { try { return fs.readdirSync(clips).filter((f) => f.endsWith('.wav')) } catch { return [] } },
    removeClip: (name) => { try { fs.unlinkSync(path.join(clips, name)) } catch { /* already gone */ } },
  }
}

/** 16 kHz mono 16-bit WAV of `samples` (floats in -1..1). */
export function wavOf(samples: Float32Array, rate = 16_000): Uint8Array {
  const out = Buffer.alloc(44 + samples.length * 2)
  out.write('RIFF', 0, 'ascii')
  out.writeUInt32LE(36 + samples.length * 2, 4)
  out.write('WAVEfmt ', 8, 'ascii')
  out.writeUInt32LE(16, 16)
  out.writeUInt16LE(1, 20)
  out.writeUInt16LE(1, 22)
  out.writeUInt32LE(rate, 24)
  out.writeUInt32LE(rate * 2, 28)
  out.writeUInt16LE(2, 32)
  out.writeUInt16LE(16, 34)
  out.write('data', 36, 'ascii')
  out.writeUInt32LE(samples.length * 2, 40)
  for (let i = 0; i < samples.length; i++) out.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), 44 + i * 2)
  return out
}

/** s16le bytes as floats. */
export function floatsOf(pcm: Uint8Array): Float32Array {
  const count = pcm.length >> 1
  const view = new DataView(pcm.buffer, pcm.byteOffset, count * 2)
  const out = new Float32Array(count)
  for (let i = 0; i < count; i++) out[i] = view.getInt16(i * 2, true) / 32768
  return out
}

/**
 * Levels for the record: the loudest 32 ms frame, and how long the audio has
 * been quieter than `QUIET_DB` at its end — for a turn check, how much pause
 * Smart Turn heard after the last word.
 */
export function levels(samples: Float32Array, rate = 16_000): { peakDb: number; trailingQuietMs: number } {
  const frame = 512
  const QUIET_DB = -45
  const dbs: number[] = []
  for (let i = 0; i + frame <= samples.length; i += frame) {
    let sum = 0
    for (let j = i; j < i + frame; j++) sum += samples[j] * samples[j]
    const rms = Math.sqrt(sum / frame)
    dbs.push(rms > 0 ? 20 * Math.log10(rms) : -120)
  }
  let quiet = 0
  for (let i = dbs.length - 1; i >= 0 && dbs[i] < QUIET_DB; i--) quiet++
  return { peakDb: Math.round(dbs.length ? Math.max(...dbs) : -120), trailingQuietMs: Math.round((quiet * frame * 1000) / rate) }
}

export class VoiceRecord {
  private clipCount: number | undefined

  constructor(private readonly deps: VoiceRecordDeps, private readonly log: (message: string) => void = () => {}) {}

  /** A wake-word or speech check: the clip, what was heard, and what was decided. */
  check(entry: {
    device: string; mode: string; match: boolean; heard?: string; wakeWord?: boolean; error?: string; elapsedMs: number
  }, pcm: Uint8Array, now = new Date()): void {
    const samples = floatsOf(pcm)
    const clip = this.clip(now, `${entry.mode}-${entry.match ? 'match' : 'no'}`, samples)
    this.write({ t: now.toISOString(), kind: entry.mode === 'speech' ? 'speech-check' : 'wake-word-check', ...entry, clip, clipMs: Math.round(samples.length / 16), ...levels(samples) })
  }

  /** A Smart Turn verdict on a dictation's last eight seconds. */
  turn(entry: { dictation: string; probability: number | null; elapsedMs: number; error?: string }, audio: Float32Array, now = new Date()): void {
    const clip = this.clip(now, `turn-${entry.probability === null ? 'none' : entry.probability.toFixed(2)}`, audio)
    this.write({ t: now.toISOString(), kind: 'turn', ...entry, clip, windowMs: Math.round(audio.length / 16), ...levels(audio) })
  }

  /** A phone dictation's outcome, so the turn verdicts before it can be read against what was said. */
  dictation(entry: { device: string; dictation: string; text?: string; error?: string }, now = new Date()): void {
    this.write({ t: now.toISOString(), kind: 'dictation', ...entry })
  }

  private write(record: Record<string, unknown>): void {
    try {
      this.deps.appendLine(JSON.stringify(record))
    } catch (err) {
      this.log(`could not write the voice record: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  private clip(now: Date, label: string, samples: Float32Array): string | undefined {
    const name = `${now.toISOString().replace(/[:.]/g, '-')}-${label}.wav`
    try {
      this.deps.writeClip(name, wavOf(samples))
      this.clipCount = (this.clipCount ?? this.deps.listClips().length - 1) + 1
      if (this.clipCount > MAX_CLIPS) {
        // Names start with the time, so the oldest sort first.
        const all = this.deps.listClips().sort()
        for (const old of all.slice(0, all.length - MAX_CLIPS)) this.deps.removeClip(old)
        this.clipCount = Math.min(all.length, MAX_CLIPS)
      }
      return name
    } catch (err) {
      this.log(`could not keep a voice clip: ${err instanceof Error ? err.message : String(err)}`)
      return undefined
    }
  }
}
