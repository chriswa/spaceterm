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

/**
 * Voice Operator's `/v1/wake-word` as it really answers (WakeWordCheck.swift),
 * hearing `text` in the clip: `speech` says whether there were words and gives
 * them; `start` and `only` give the words only when they matched, and empty
 * otherwise. A fake that gave the words either way hid that "let me turn this
 * off" could never be seen behind a `start` check.
 */
function voiceHearing(text: string) {
  const asked: string[] = []
  const words = (t: string) => t.toLowerCase().replace(/[^\p{L}'\s]/gu, ' ').split(/\s+/).filter(Boolean)
  return {
    asked,
    checkWakeWord: async (_pcm: Uint8Array, word: string, match: 'start' | 'only' | 'speech') => {
      asked.push(`${word} ${match}`)
      if (match === 'speech') return { status: 200, body: { match: words(text).length > 0, heard: text } }
      const heard = words(text)
      const matched = match === 'start' ? heard[0] === word : heard.length === 1 && heard[0] === word
      return { status: 200, body: { match: matched, heard: matched ? text : '' } }
    },
  }
}

describe('checkWakeWord', () => {
  const pcm = new Uint8Array([0, 0])

  it('says whether the words began with the wake word', async () => {
    expect(await checkWakeWord(voiceHearing('Control, what is'), pcm)).toEqual({ ok: true, match: true, heard: 'Control, what is' })
    expect(await checkWakeWord(voiceHearing('Control.'), pcm)).toMatchObject({ ok: true, match: true })
    expect(await checkWakeWord(voiceHearing('It is under control'), pcm)).toMatchObject({ ok: true, match: false })
    expect(await checkWakeWord(voiceHearing('Controller'), pcm)).toMatchObject({ ok: true, match: false })
  })

  it('asks Voice Operator for the words, and judges the wake word itself', async () => {
    const voice = voiceHearing('Control, what is')
    await checkWakeWord(voice, pcm)
    await checkWakeWord(voice, pcm, 'speech')
    expect(voice.asked).toEqual(['control speech', 'control speech'])
  })

  it('passes on no words of speech that is neither the wake word nor the phrase', async () => {
    expect(await checkWakeWord(voiceHearing('I was telling Sam about dinner'), pcm)).toEqual({ ok: true, match: false })
  })

  it('explains a Voice Operator that is not running, or too old', async () => {
    expect(await checkWakeWord({ checkWakeWord: async () => undefined }, pcm)).toMatchObject({ ok: false, error: expect.stringContaining('not running') })
    const old = { checkWakeWord: async () => ({ status: 404, body: { error: 'not_found' } }) }
    expect(await checkWakeWord(old, pcm)).toMatchObject({ ok: false, error: expect.stringContaining('not_found') })
  })
})

describe('checkWakeWord, in the conversation window', () => {
  const pcm = new Uint8Array([0, 0])
  const heard = voiceHearing

  it('counts any real words as speech, and says when they began with the wake word', async () => {
    expect(await checkWakeWord(heard('Yes.'), pcm, 'speech')).toEqual({ ok: true, match: true, wakeWord: false, heard: 'Yes.' })
    expect(await checkWakeWord(heard('No, tell Evan.'), pcm, 'speech')).toEqual({ ok: true, match: true, wakeWord: false, heard: 'No, tell Evan.' })
    expect(await checkWakeWord(heard('Control.'), pcm, 'speech')).toEqual({ ok: true, match: true, wakeWord: true, heard: 'Control.' })
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

describe('checkWakeWord, for "let me turn this off"', () => {
  const pcm = new Uint8Array([0, 0])
  const heard = voiceHearing

  it('says when the start of speech could be the phrase, though it is not the wake word', async () => {
    expect(await checkWakeWord(heard('Let me turn'), pcm)).toEqual({ ok: true, match: false, heard: 'Let me turn', shutdown: 'start' })
    expect(await checkWakeWord(heard('Let me turn this off.'), pcm)).toEqual({ ok: true, match: false, heard: 'Let me turn this off.', shutdown: 'whole' })
    expect(await checkWakeWord(heard('Let me think'), pcm)).toEqual({ ok: true, match: false })
  })

  it('says when the whole of it was the phrase, and nothing else', async () => {
    expect(await checkWakeWord(heard('Let me turn this off.'), pcm, 'speech')).toMatchObject({ ok: true, match: true, shutdown: 'whole' })
    expect(await checkWakeWord(heard('Let me turn this off and on.'), pcm, 'speech')).not.toHaveProperty('shutdown')
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

