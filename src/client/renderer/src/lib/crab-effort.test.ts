import { describe, expect, it } from 'vitest'
import { crabEffortSteps } from './crab-effort'

describe('crabEffortSteps', () => {
  it('measures from the default of high', () => {
    expect(crabEffortSteps('claude', 'high')).toBe(0)
    expect(crabEffortSteps('claude', 'max')).toBe(2)
    expect(crabEffortSteps('claude', 'medium')).toBe(-1)
    expect(crabEffortSteps('claude', 'off')).toBe(-3)
  })

  it('shows nothing when the effort is unknown or the surface is not Claude', () => {
    expect(crabEffortSteps('claude', undefined)).toBe(0)
    expect(crabEffortSteps('cursor', 'low')).toBe(0)
  })
})
