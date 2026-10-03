import { describe, expect, it } from 'vitest'
import { aliasEntries, phoneticKey, resolveName } from './name-aliases'
import { NAME_VOICE_TABLE } from './name-voice-table'

const ALL_NAMES = NAME_VOICE_TABLE.map((e) => e.name)

describe('resolveName', () => {
  // Ported from NameVoiceRegistryTests.testHomophoneResolvesToCanonical:
  // every canonical name resolves to itself, every alias to its canonical.
  it('resolves every roster name to itself, in any case', () => {
    for (const name of ALL_NAMES) {
      expect(resolveName(name, ALL_NAMES)).toBe(name)
      expect(resolveName(name.toUpperCase(), ALL_NAMES)).toBe(name)
    }
  })

  it('resolves every alias to its canonical name when that name is a candidate', () => {
    let exercised = 0
    for (const [alias, canonical] of aliasEntries()) {
      const name = ALL_NAMES.find((n) => n.toLowerCase() === canonical)
      if (!name) continue // "ruby": in the alias tables, not in the roster
      expect(resolveName(alias, [name]), `${alias} → ${name}`).toBe(name)
      exercised++
    }
    expect(exercised).toBeGreaterThan(200)
  })

  it('handles the classic mishearings', () => {
    expect(resolveName('heaven', ['Evan', 'Grace'])).toBe('Evan')
    expect(resolveName('Clare', ['Claire'])).toBe('Claire')
    expect(resolveName('Zach', ['Jack'])).toBe('Jack')
    expect(resolveName('Rosé', ['Rose'])).toBe('Rose')
  })

  it('returns only names among the candidates', () => {
    expect(resolveName('Evan', ['Grace'])).toBeUndefined()
    expect(resolveName('heaven', [])).toBeUndefined()
    expect(resolveName('Kevin', ALL_NAMES)).toBeUndefined()
  })

  it('falls back to a unique sound-alike candidate', () => {
    expect(phoneticKey('Dean')).toBe(phoneticKey('Diana'))
    expect(resolveName('Dean', ['Diana', 'Oscar'])).toBe('Diana')
    expect(resolveName('dene', ['Diana'])).toBe('Diana') // alias of dean, then phonetic
    // Ambiguous sound-alikes resolve to nothing rather than guessing.
    expect(resolveName('Dean', ['Diana', 'Dana'])).toBeUndefined()
    // An exact match beats a sound-alike.
    expect(resolveName('Dana', ['Diana', 'Dana'])).toBe('Dana')
  })

  it('finds the name within a phrase, ignoring punctuation', () => {
    expect(resolveName('tell Heaven, please', ['Evan', 'Grace'])).toBe('Evan')
    expect(resolveName('Grace?', ['Evan', 'Grace'])).toBe('Grace')
    expect(resolveName('nobody here', ['Evan'])).toBeUndefined()
  })
})
