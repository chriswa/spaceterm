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

describe('checkWakeWord, in the conversation window', () => {
  const pcm = new Uint8Array([0, 0])
  const heard = (text: string) => ({
    checkWakeWord: async (_pcm: Uint8Array, _word: string, match: string) => {
      expect(match).toBe('speech')
      return { status: 200, body: { match: text.trim() !== '', heard: text } }
    },
  })

  it('counts any real words as speech, and says when they began with the wake word', async () => {
    expect(await checkWakeWord(heard('Yes.'), pcm, 'speech')).toEqual({ ok: true, match: true, wakeWord: false })
    expect(await checkWakeWord(heard('No, tell Evan.'), pcm, 'speech')).toEqual({ ok: true, match: true, wakeWord: false })
    expect(await checkWakeWord(heard('Control.'), pcm, 'speech')).toEqual({ ok: true, match: true, wakeWord: true })
  })

  it('does not count filler, or nothing at all', async () => {
    expect(await checkWakeWord(heard('Hmm.'), pcm, 'speech')).toMatchObject({ ok: true, match: false })
    expect(await checkWakeWord(heard('Uh, um'), pcm, 'speech')).toMatchObject({ ok: true, match: false })
    expect(await checkWakeWord(heard(''), pcm, 'speech')).toMatchObject({ ok: true, match: false })
  })

  it('takes the ignored words from tuning, and logs only short clips, to find what is heard in nothing', async () => {
    const logged: string[] = []
    expect(await checkWakeWord(heard('Thank you.'), pcm, 'speech', ['thank you'], (m) => logged.push(m))).toMatchObject({ ok: true, match: false })
    // A phrase is taken out whole; its words alone still count.
    expect(await checkWakeWord(heard('Thank Kevin.'), pcm, 'speech', ['thank you'])).toMatchObject({ ok: true, match: true })
    await checkWakeWord(heard('Tell Kevin to run the tests again.'), pcm, 'speech', [], (m) => logged.push(m))
    expect(logged).toEqual(['speech check heard "thank you" — ignored'])
  })
})

describe('parseHandsFreeTuning, the conversation keys', () => {
  it('takes conversationMs as a number and ignoredWords as a list of words', () => {
    expect(parseHandsFreeTuning(JSON.stringify({ conversationMs: 20000, ignoredWords: ['you', 'thank you'] }))).toEqual({
      tuning: { conversationMs: 20000, ignoredWords: ['you', 'thank you'] }, problems: [],
    })
    expect(parseHandsFreeTuning(JSON.stringify({ ignoredWords: 'you' })).problems).toEqual(['"ignoredWords" must be a list of words'])
  })
})

