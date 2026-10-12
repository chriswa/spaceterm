import { describe, expect, it } from 'vitest'
import { MAX_CLIPS, VoiceRecord, floatsOf, levels, wavOf, type VoiceRecordDeps } from './voice-record'

function fakeDeps() {
  const lines: Array<Record<string, unknown>> = []
  const clips = new Map<string, Uint8Array>()
  const deps: VoiceRecordDeps = {
    appendLine: (line) => { lines.push(JSON.parse(line)) },
    writeClip: (name, wav) => { clips.set(name, wav) },
    listClips: () => [...clips.keys()],
    removeClip: (name) => { clips.delete(name) },
  }
  return { deps, lines, clips }
}

/** s16le: `ms` of a loud tone, then `quietMs` of silence. */
function pcm(ms: number, quietMs = 0): Uint8Array {
  const n = (ms + quietMs) * 16
  const out = new Uint8Array(n * 2)
  const view = new DataView(out.buffer)
  for (let i = 0; i < ms * 16; i++) view.setInt16(i * 2, Math.round(Math.sin(i / 10) * 8000), true)
  return out
}

describe('VoiceRecord', () => {
  it('records a wake-word check with what was heard, the decision, and its clip', () => {
    const { deps, lines, clips } = fakeDeps()
    new VoiceRecord(deps).check({ device: 'Phone', mode: 'wake-word', match: false, heard: 'Patrol, what is', elapsedMs: 150 }, pcm(800), new Date('2026-10-12T21:00:00Z'))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ t: '2026-10-12T21:00:00.000Z', kind: 'wake-word-check', match: false, heard: 'Patrol, what is', clipMs: 800 })
    expect(clips.has(lines[0].clip as string)).toBe(true)
    // A real WAV, the clip's own samples.
    const wav = clips.get(lines[0].clip as string)!
    expect(Buffer.from(wav.subarray(0, 4)).toString('ascii')).toBe('RIFF')
    expect(wav.length).toBe(44 + 800 * 16 * 2)
  })

  it('records a turn verdict with how much quiet Smart Turn heard after the last word', () => {
    const { deps, lines } = fakeDeps()
    new VoiceRecord(deps).turn({ dictation: 'd1', probability: 0.1, elapsedMs: 120 }, floatsOf(pcm(2000, 800)))
    expect(lines[0]).toMatchObject({ kind: 'turn', dictation: 'd1', probability: 0.1, windowMs: 2800 })
    expect(lines[0].trailingQuietMs).toBeGreaterThanOrEqual(750)
    expect(lines[0].trailingQuietMs).toBeLessThanOrEqual(800)
  })

  it('keeps only the newest clips, and every line', () => {
    const { deps, lines, clips } = fakeDeps()
    const record = new VoiceRecord(deps)
    const start = Date.parse('2026-10-12T21:00:00Z')
    for (let i = 0; i < MAX_CLIPS + 5; i++) record.check({ device: 'Phone', mode: 'speech', match: true, elapsedMs: 1 }, pcm(10), new Date(start + i * 1000))
    expect(lines).toHaveLength(MAX_CLIPS + 5)
    expect(clips.size).toBe(MAX_CLIPS)
    expect(clips.has(lines[0].clip as string)).toBe(false)
    expect(clips.has(lines.at(-1)!.clip as string)).toBe(true)
  })

  it('never throws when it cannot write', () => {
    const logged: string[] = []
    const broken: VoiceRecordDeps = { appendLine: () => { throw new Error('disk full') }, writeClip: () => { throw new Error('disk full') }, listClips: () => [], removeClip: () => {} }
    new VoiceRecord(broken, (m) => logged.push(m)).dictation({ device: 'Phone', dictation: 'd1', text: 'hi' })
    expect(logged[0]).toContain('disk full')
  })
})

describe('levels and wavOf', () => {
  it('a silent clip is all trailing quiet', () => {
    expect(levels(new Float32Array(16_000))).toEqual({ peakDb: -120, trailingQuietMs: 992 })
    expect(wavOf(new Float32Array(3)).length).toBe(50)
  })
})
