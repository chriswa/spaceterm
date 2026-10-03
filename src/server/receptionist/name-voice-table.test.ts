import { describe, expect, it } from 'vitest'
import { NAME_VOICE_TABLE, RECEPTIONIST_VOICE, rosterEntry } from './name-voice-table'
import { phoneticKey } from './name-aliases'

/**
 * Conventional gender of each roster name, independent of the table, so a
 * table edit that pairs e.g. "Emma" with a masculine voice fails here.
 */
const FEMININE = new Set([
  'Bella', 'Beth', 'Chloe', 'Claire', 'Dana', 'Daphne', 'Diana', 'Emma',
  'Fiona', 'Gemma', 'Grace', 'Hazel', 'Heidi', 'Iris', 'Ivy', 'Jane',
  'Julia', 'Kate', 'Laura', 'Lily', 'Lucy', 'Maya', 'Mia', 'Molly',
  'Naomi', 'Nina', 'Nora', 'Olivia', 'Penny', 'Piper', 'Rachel', 'Rita',
  'Rose', 'Ruth', 'Sadie', 'Stella', 'Tessa', 'Vivian', 'Wendy', 'Zoe',
])
const MASCULINE = new Set([
  'Oliver', 'Jack', 'Henry', 'Leo', 'Max', 'Noah', 'Ethan', 'Lucas',
  'Mason', 'Logan', 'Nathan', 'Caleb', 'Isaac', 'Blake', 'Dean',
  'Evan', 'Grant', 'Jake', 'Kyle', 'Luke', 'Mark', 'Miles', 'Ross',
  'Scott', 'Wade', 'Wyatt', 'Bruno', 'Harvey', 'Leon', 'Marcus',
  'Oscar', 'Simon', 'Victor', 'George', 'Jonah', 'Roland', 'Vincent',
  'Nolan', 'Wesley', 'Felix', 'Jasper',
])

/** Kokoro's convention: the second letter of the id is f (female) or m (male). */
function voiceGender(voice: string): 'feminine' | 'masculine' {
  return voice[1] === 'f' ? 'feminine' : 'masculine'
}

describe('NAME_VOICE_TABLE', () => {
  it('has unique names, all with a phonetic key', () => {
    const names = NAME_VOICE_TABLE.map((e) => e.name)
    expect(new Set(names).size).toBe(names.length)
    for (const name of names) expect(phoneticKey(name), name).toBeDefined()
  })

  it('shares voices: names outnumber voices', () => {
    const voices = new Set(NAME_VOICE_TABLE.map((e) => e.voice))
    expect(NAME_VOICE_TABLE.length).toBeGreaterThan(voices.size)
  })

  it('pairs every name with a voice of its gender', () => {
    for (const e of NAME_VOICE_TABLE) {
      expect(FEMININE.has(e.name) || MASCULINE.has(e.name), `${e.name} is not in the test's gender lists — add it`).toBe(true)
      const expected = FEMININE.has(e.name) ? 'feminine' : 'masculine'
      expect(e.gender, e.name).toBe(expected)
      expect(voiceGender(e.voice), `${e.name} on ${e.voice}`).toBe(expected)
    }
  })

  it('never gives an agent name the receptionist voice, or the blocked af_nicole', () => {
    for (const e of NAME_VOICE_TABLE) {
      expect(e.voice).not.toBe(RECEPTIONIST_VOICE)
      expect(e.voice).not.toBe('af_nicole')
    }
  })

  it('keeps every Voice Operator name, including those moved off af_heart', () => {
    expect(NAME_VOICE_TABLE).toHaveLength(81)
    for (const name of ['Grace', 'Claire', 'Diana']) {
      expect(rosterEntry(name)?.gender).toBe('feminine')
    }
  })

  it('looks names up case-insensitively', () => {
    expect(rosterEntry('oLiVeR')?.name).toBe('Oliver')
    expect(rosterEntry('Control')).toBeUndefined()
  })
})
