import { describe, expect, it } from 'vitest'
import { crabEffortSteps } from './crab-effort'

describe('crabEffortSteps', () => {
  it('measures Claude and Cursor from high', () => {
    expect(crabEffortSteps('claude', 'high')).toBe(0)
    expect(crabEffortSteps('claude', 'max')).toBe(2)
    expect(crabEffortSteps('claude', 'off')).toBe(-3)
    expect(crabEffortSteps('cursor', 'medium')).toBe(-1)
  })

  it('measures Codex from medium, on its own scale', () => {
    expect(crabEffortSteps('codex', 'medium')).toBe(0)
    expect(crabEffortSteps('codex', 'high')).toBe(1)
    expect(crabEffortSteps('codex', 'minimal')).toBe(-2)
  })

  it('shows nothing when the effort is unknown or the surface is a plain terminal', () => {
    expect(crabEffortSteps('claude', undefined)).toBe(0)
    expect(crabEffortSteps('terminal', 'low')).toBe(0)
  })
})
