import { describe, expect, it } from 'vitest'
import { deriveToolbarIndicator } from './crab-nav'

/**
 * deriveToolbarIndicator maps a surface's agent state onto the toolbar crab's
 * icon, colour and unviewed dot. It is the one place the state->colour contract
 * is expressed, and the colour tiers are documented in crab-nav.ts.
 *
 * The `unviewed` flag matters beyond the dot: it gates the completion tone, so
 * the passive states (working, working_background) must never set it.
 */
const derive = deriveToolbarIndicator

describe('deriveToolbarIndicator', () => {
  describe('agent kind', () => {
    it('reports cursor surfaces', () => {
      expect(derive('stopped', false, false, false, 'cursor').kind).toBe('cursor')
    })

    it('reports codex surfaces', () => {
      expect(derive('stopped', false, false, false, 'codex').kind).toBe('codex')
    })

    it('reports claude surfaces', () => {
      expect(derive('stopped', false, false, false, 'claude').kind).toBe('claude')
    })

    it('infers claude from session history when agentType is absent', () => {
      // Surfaces created before agentType was recorded still show a crab.
      expect(derive('stopped', false, false, true).kind).toBe('claude')
    })

    it('reports a plain shell as a terminal', () => {
      expect(derive(undefined, false, false, false).kind).toBe('terminal')
    })
  })

  describe('plain terminals', () => {
    it('is grey when read', () => {
      expect(derive(undefined, false, false, false)).toEqual({
        kind: 'terminal', color: 'gray', unviewed: false, asleep: false,
      })
    })

    it('is white and unviewed when unread', () => {
      expect(derive(undefined, true, false, false)).toEqual({
        kind: 'terminal', color: 'white', unviewed: true, asleep: false,
      })
    })
  })

  describe('attention states', () => {
    it('is red while awaiting permission', () => {
      expect(derive('waiting_permission', true, false, true).color).toBe('red')
    })

    it('is green while asking a question', () => {
      expect(derive('waiting_question', true, false, true).color).toBe('green')
    })

    it('is purple while awaiting plan approval', () => {
      expect(derive('waiting_plan', true, false, true).color).toBe('purple')
    })

    it('is white and unread when the turn ended with something to read', () => {
      expect(derive('stopped', true, false, true)).toMatchObject({
        color: 'white', unviewed: true,
      })
    })
  })

  describe('potential_error', () => {
    it('is red while unread', () => {
      expect(derive('potential_error', true, false, true)).toMatchObject({
        color: 'red', unviewed: true,
      })
    })

    it('stays visible as white once acknowledged', () => {
      // Deliberately not grey: an acknowledged error should still be findable,
      // but must not look like an active prompt.
      expect(derive('potential_error', false, false, true)).toMatchObject({
        color: 'white', unviewed: false,
      })
    })
  })

  describe('passive states never mark unviewed', () => {
    it('is orange while working', () => {
      expect(derive('working', false, false, true)).toMatchObject({
        color: 'orange', unviewed: false,
      })
    })

    it('is yellow while only background work remains', () => {
      expect(derive('working_background', false, false, true)).toMatchObject({
        color: 'yellow', unviewed: false,
      })
    })

    it('does not mark working unviewed even if the unread flag is set', () => {
      // Otherwise a stale unread flag would fire the completion tone mid-turn.
      expect(derive('working', true, false, true).unviewed).toBe(false)
    })

    it('does not mark working_background unviewed even if the unread flag is set', () => {
      expect(derive('working_background', true, false, true).unviewed).toBe(false)
    })
  })

  describe('asleep', () => {
    it('overrides colour and clears unviewed', () => {
      expect(derive('waiting_permission', true, true, true)).toEqual({
        kind: 'claude', color: 'asleep', unviewed: false, asleep: true,
      })
    })

    it('overrides a working surface too', () => {
      expect(derive('working', false, true, true).color).toBe('asleep')
    })

    it('keeps the agent kind while asleep', () => {
      expect(derive('stopped', false, true, false, 'codex').kind).toBe('codex')
    })
  })

  describe('fresh surfaces', () => {
    it('shows a grey agent icon before any session history exists', () => {
      expect(derive(undefined, false, false, false, 'claude')).toMatchObject({
        kind: 'claude', color: 'gray', unviewed: false,
      })
    })

    it('does not mark a read stopped surface without history as unviewed', () => {
      expect(derive('stopped', false, false, true).unviewed).toBe(false)
    })
  })
})
