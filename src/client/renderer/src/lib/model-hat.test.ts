import { describe, expect, it } from 'vitest'
import { modelHat } from './model-hat'

describe('modelHat', () => {
  it('gives each non-Opus family its hat', () => {
    expect(modelHat('claude', 'Fable 5.1')).toBe('crown')
    expect(modelHat('claude', 'Sonnet 5.5')).toBe('cap')
    expect(modelHat('claude', 'Haiku 4.5')).toBe('dunce')
  })

  it('leaves Opus bare', () => {
    expect(modelHat('claude', 'Opus 5.5')).toBeNull()
    expect(modelHat('claude', 'Opus 5.5 (1M context)')).toBeNull()
  })

  it('wears nothing for an unknown or missing model', () => {
    expect(modelHat('claude', undefined)).toBeNull()
    expect(modelHat('claude', 'Mystery 9')).toBeNull()
  })

  it('hats any agent running a Claude model, and nothing else', () => {
    expect(modelHat('cursor', 'Sonnet 5.5')).toBe('cap')
    expect(modelHat('cursor', 'Grok 4.5 High Fast')).toBeNull()
    expect(modelHat('codex', 'gpt-5.6-terra')).toBeNull()
    expect(modelHat('terminal', 'Haiku 4.5')).toBeNull()
  })
})
