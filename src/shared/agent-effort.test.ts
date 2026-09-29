import { describe, expect, it } from 'vitest'
import { effortSteps, parseCodexEffort, parseStatusLineEffort } from './agent-effort'

describe('parseStatusLineEffort', () => {
  it("reads Claude Code's level", () => {
    expect(parseStatusLineEffort({ effort: { level: 'medium' }, thinking: { enabled: true } })).toBe('medium')
    expect(parseStatusLineEffort({ effort: { level: 'xhigh' } })).toBe('xhigh')
  })

  it('reports thinking switched off as its own level, whatever the effort says', () => {
    expect(parseStatusLineEffort({ effort: { level: 'high' }, thinking: { enabled: false } })).toBe('off')
  })

  it("reads Cursor's, folded into the model's parameters or name", () => {
    expect(parseStatusLineEffort({ model: { id: 'grok-4.5', display_name: 'Grok 4.5 High Fast', param_summary: 'High Fast' } })).toBe('high')
    expect(parseStatusLineEffort({ model: { display_name: 'Cursor Grok 4.5 Max' } })).toBe('max')
    expect(parseStatusLineEffort({ model: { param_summary: 'Extra High' } })).toBe('xhigh')
  })

  it('says nothing for a payload without one, or with a level it does not know', () => {
    expect(parseStatusLineEffort(undefined)).toBeUndefined()
    expect(parseStatusLineEffort({ model: { display_name: 'Opus 5.5' } })).toBeUndefined()
    expect(parseStatusLineEffort({ effort: { level: 'ludicrous' } })).toBeUndefined()
    expect(parseStatusLineEffort({ effort: { level: 'off' } })).toBeUndefined()
  })
})

describe('parseCodexEffort', () => {
  it('reads a level on the Codex scale and nothing else', () => {
    expect(parseCodexEffort({ model: 'gpt-5.6-terra', effort: 'medium' })).toBe('medium')
    expect(parseCodexEffort({ effort: 'minimal' })).toBe('minimal')
    expect(parseCodexEffort({ effort: 'max' })).toBeUndefined()
    expect(parseCodexEffort({})).toBeUndefined()
  })
})

describe('effortSteps', () => {
  it("counts levels on the agent's own scale, signed by direction", () => {
    expect(effortSteps('claude', 'high', 'max')).toBe(2)
    expect(effortSteps('claude', 'high', 'off')).toBe(-3)
    expect(effortSteps('codex', 'medium', 'none')).toBe(-3)
    expect(effortSteps('codex', 'medium', 'xhigh')).toBe(2)
  })

  it('is zero for a level off the scale', () => {
    expect(effortSteps('codex', 'medium', 'max')).toBe(0)
  })
})
