import { describe, expect, it } from 'vitest'
import { effortSteps, parseClaudeEffort } from './claude-effort'

describe('parseClaudeEffort', () => {
  it('reads the level from a status-line payload', () => {
    expect(parseClaudeEffort({ effort: { level: 'medium' }, thinking: { enabled: true } })).toBe('medium')
    expect(parseClaudeEffort({ effort: { level: 'xhigh' } })).toBe('xhigh')
  })

  it('reports thinking switched off as its own level, whatever the effort says', () => {
    expect(parseClaudeEffort({ effort: { level: 'high' }, thinking: { enabled: false } })).toBe('off')
  })

  it('says nothing for a payload without one, or with a level it does not know', () => {
    expect(parseClaudeEffort(undefined)).toBeUndefined()
    expect(parseClaudeEffort({ model: { display_name: 'Opus 5.5' } })).toBeUndefined()
    expect(parseClaudeEffort({ effort: { level: 'ludicrous' } })).toBeUndefined()
    expect(parseClaudeEffort({ effort: { level: 'off' } })).toBeUndefined()
  })
})

describe('effortSteps', () => {
  it('counts levels, signed by direction', () => {
    expect(effortSteps('high', 'max')).toBe(2)
    expect(effortSteps('high', 'high')).toBe(0)
    expect(effortSteps('high', 'off')).toBe(-3)
  })
})
