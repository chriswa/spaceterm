import { describe, it, expect } from 'vitest'
import { CUE_STALE_MS, CueTracker, cueSamples } from './cues'

describe('cueSamples', () => {
  it('plays each note at twice its natural speed, as Voice Operator does', () => {
    // nothingToSay is 0.10 + 0.04 + 0.16 s at natural speed.
    expect(cueSamples('nothingToSay').length).toBe(Math.floor(0.05 * 44_100) + Math.floor(0.02 * 44_100) + Math.floor(0.08 * 44_100))
  })

  it('fades in from silence and stays within full scale', () => {
    const s = cueSamples('conversationClosed')
    expect(s[0]).toBe(0)
    expect(Math.max(...Array.from(s).map(Math.abs))).toBeLessThanOrEqual(1)
  })

  it('plays a rest as silence', () => {
    const s = cueSamples('error')
    const firstNote = Math.floor(0.1 * 44_100)
    const rest = s.slice(firstNote, firstNote + Math.floor(0.035 * 44_100))
    expect(rest.every((v) => v === 0)).toBe(true)
  })

  it('"nothing to say" steps down, beep then boop', () => {
    // Zero crossings per sample over each note approximate pitch.
    const crossings = (s: Float32Array) => s.slice(1).filter((v, i) => Math.sign(v) !== Math.sign(s[i]) && v !== 0).length
    const s = cueSamples('nothingToSay')
    const beep = s.slice(0, Math.floor(0.05 * 44_100))
    const boop = s.slice(s.length - Math.floor(0.08 * 44_100))
    expect(crossings(beep) / beep.length).toBeGreaterThan(crossings(boop) / boop.length)
  })
  it('the "taken, no reply coming" jingle is unlike every other cue', () => {
    const others = ['error', 'nothingToSay', 'handsFreeReady', 'conversationClosed', 'dictationStart', 'dictationEnd', 'controlShutdown'] as const
    const jingle = cueSamples('heardUnattached').length
    for (const other of others) expect(cueSamples(other).length).not.toBe(jingle)
  })
})

describe('CueTracker', () => {
  const cue = (name: Parameters<CueTracker['started']>[0]['cue'], stopped: string[], at: number) =>
    ({ cue: name, stop: () => { stopped.push(name) }, requestedAt: at, durationMs: 200 })

  it('reports a cue that starts while another is still sounding', () => {
    const t = new CueTracker()
    const stopped: string[] = []
    expect(t.started(cue('error', stopped, 0), true, 0).overlapping).toEqual([])
    expect(t.started(cue('nothingToSay', stopped, 100), true, 100).overlapping).toEqual(['error'])
    expect(t.started(cue('conversationClosed', stopped, 400), true, 400).overlapping).toEqual([])
  })

  it('keeps only the newest cue waiting on a stopped context, so they cannot sound together', () => {
    const t = new CueTracker()
    const stopped: string[] = []
    t.started(cue('error', stopped, 0), false, 0)
    t.started(cue('nothingToSay', stopped, 10), false, 10)
    expect(t.started(cue('conversationClosed', stopped, 20), false, 20).superseded).toEqual(['nothingToSay'])
    expect(stopped).toEqual(['error', 'nothingToSay'])
    // Resumed promptly: the one left plays, a little late.
    expect(t.resumed(120)).toEqual({ dropped: [], late: [{ cue: 'conversationClosed', lateMs: 100 }] })
  })

  it('drops a cue that waited too long for the audio to come back', () => {
    const t = new CueTracker()
    const stopped: string[] = []
    t.started(cue('nothingToSay', stopped, 0), false, 0)
    expect(t.resumed(CUE_STALE_MS + 1000)).toEqual({ dropped: [{ cue: 'nothingToSay', lateMs: CUE_STALE_MS + 1000 }], late: [] })
    expect(stopped).toEqual(['nothingToSay'])
    // Nothing is left to play on a later resume.
    expect(t.resumed(5000)).toEqual({ dropped: [], late: [] })
  })
})
