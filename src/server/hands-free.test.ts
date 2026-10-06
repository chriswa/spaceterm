import { describe, expect, it } from 'vitest'
import { checkWakeWord, parseHandsFreeTuning } from './hands-free'

describe('parseHandsFreeTuning', () => {
  it('has no overrides and no complaint when the file is absent or empty', () => {
    expect(parseHandsFreeTuning(undefined)).toEqual({ tuning: {}, problems: [] })
    expect(parseHandsFreeTuning('  ')).toEqual({ tuning: {}, problems: [] })
  })

  it('keeps known keys and names what it dropped', () => {
    const { tuning, problems } = parseHandsFreeTuning(JSON.stringify({
      noSpeechBeforeMs: 900, silenceAftrMs: 300, endSilenceMs: 'long', wordMinMs: -1,
    }))
    expect(tuning).toEqual({ noSpeechBeforeMs: 900 })
    expect(problems).toHaveLength(3)
    expect(problems[0]).toContain('silenceAftrMs')
  })

  it('says so when the file is not a JSON object', () => {
    expect(parseHandsFreeTuning('{').problems[0]).toMatch(/not JSON/)
    expect(parseHandsFreeTuning('[1]').problems).toEqual(['not a JSON object'])
  })
})

describe('checkWakeWord', () => {
  const pcm = new Uint8Array([0, 0])

  it('passes the verdict through', async () => {
    const asked: string[] = []
    const voice = {
      checkWakeWord: async (_pcm: Uint8Array, word: string, match: string) => {
        asked.push(`${word} ${match}`)
        return { status: 200, body: { match: true, heard: 'Control, what is' } }
      },
    }
    expect(await checkWakeWord(voice, pcm)).toEqual({ ok: true, match: true })
    // The start of what was said, not a word on its own.
    expect(asked).toEqual(['control start'])
  })

  it('explains a Voice Operator that is not running, or too old', async () => {
    expect(await checkWakeWord({ checkWakeWord: async () => undefined }, pcm)).toMatchObject({ ok: false, error: expect.stringContaining('not running') })
    const old = { checkWakeWord: async () => ({ status: 404, body: { error: 'not_found' } }) }
    expect(await checkWakeWord(old, pcm)).toMatchObject({ ok: false, error: expect.stringContaining('not_found') })
  })
})
