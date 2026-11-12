import { describe, expect, it } from 'vitest'
import { jevTurnEndJudge, jevTurnEndRequest, readTurnEndProbability } from './turn-end'

describe('turn-end', () => {
  it('shows Jev the message and asks one strict question', () => {
    const request = jevTurnEndRequest('Next finding: a missing grant breaks previews.')
    expect(request.state).toEqual({ agent_message: 'Next finding: a missing grant breaks previews.' })
    expect(Object.keys(request.questions)).toEqual(['turn_end'])
  })

  it('reads a probability, and nothing else', () => {
    expect(readTurnEndProbability({ answers: { turn_end: { noul: 0.85 } } })).toBe(0.85)
    expect(readTurnEndProbability({ answers: { turn_end: { noul: 2 } } })).toBeUndefined()
    expect(readTurnEndProbability({ answers: {} })).toBeUndefined()
    expect(readTurnEndProbability(undefined)).toBeUndefined()
  })

  it('fails when Jev gives no probability, so the message is not told', async () => {
    await expect(jevTurnEndJudge(async () => ({ answers: {} }))('Done.')).rejects.toThrow('no probability')
  })
})
