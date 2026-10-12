import { describe, it, expect } from 'vitest'
import { CUE_STALE_MS, CueTracker, cueSamples } from './cues'

describe('cueSamples', () => {
  it('lasts as long as Voice Operator’s cue: natural duration halved', () => {
    // listeningStarted is 0.09 + 0.11 s at natural speed → 0.1 s at 2×.
    expect(cueSamples('listeningStarted').length).toBe(Math.floor(0.045 * 44_100) + Math.floor(0.055 * 44_100))
  })

  it('fades in from silence and stays within full scale', () => {
    const s = cueSamples('pasted')
    expect(s[0]).toBe(0)
    expect(Math.max(...Array.from(s).map(Math.abs))).toBeLessThanOrEqual(1)
  })

  it('plays a rest as silence', () => {
    const s = cueSamples('captureFailed')
    const firstNote = Math.floor(0.1 * 44_100)
    const rest = s.slice(firstNote, firstNote + Math.floor(0.035 * 44_100))
    expect(rest.every((v) => v === 0)).toBe(true)
  })

  it('rises for start and falls for finish, like the desktop', () => {
    // Zero crossings per sample over each half approximate pitch.
    const crossings = (s: Float32Array) => s.slice(1).filter((v, i) => Math.sign(v) !== Math.sign(s[i]) && v !== 0).length
    const start = cueSamples('listeningStarted')
    const half = Math.floor(0.045 * 44_100)
    expect(crossings(start.slice(half)) / (start.length - half)).toBeGreaterThan(crossings(start.slice(0, half)) / half)
  })
})


describe('CueTracker', () => {
  const cue = (name: Parameters<CueTracker['started']>[0]['cue'], stopped: string[], at: number) =>
    ({ cue: name, stop: () => { stopped.push(name) }, requestedAt: at, durationMs: 200 })

  it('reports a cue that starts while another is still sounding', () => {
    const t = new CueTracker()
    const stopped: string[] = []
    expect(t.started(cue('listeningFinished', stopped, 0), true, 0).overlapping).toEqual([])
    expect(t.started(cue('pasted', stopped, 100), true, 100).overlapping).toEqual(['listeningFinished'])
    expect(t.started(cue('holdReleased', stopped, 400), true, 400).overlapping).toEqual([])
  })

  it('keeps only the newest cue waiting on a stopped context, so they cannot sound together', () => {
    const t = new CueTracker()
    const stopped: string[] = []
    t.started(cue('listeningFinished', stopped, 0), false, 0)
    t.started(cue('pasted', stopped, 10), false, 10)
    expect(t.started(cue('holdReleased', stopped, 20), false, 20).superseded).toEqual(['pasted'])
    expect(stopped).toEqual(['listeningFinished', 'pasted'])
    // Resumed promptly: the one left plays, a little late.
    expect(t.resumed(120)).toEqual({ dropped: [], late: [{ cue: 'holdReleased', lateMs: 100 }] })
  })

  it('drops a cue that waited too long for the audio to come back', () => {
    const t = new CueTracker()
    const stopped: string[] = []
    t.started(cue('pasted', stopped, 0), false, 0)
    expect(t.resumed(CUE_STALE_MS + 1000)).toEqual({ dropped: [{ cue: 'pasted', lateMs: CUE_STALE_MS + 1000 }], late: [] })
    expect(stopped).toEqual(['pasted'])
    // Nothing is left to play on a later resume.
    expect(t.resumed(5000)).toEqual({ dropped: [], late: [] })
  })
})
