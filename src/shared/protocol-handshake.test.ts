import { describe, it, expect } from 'vitest'
import { checkProtocolVersion, describeRange, type ProtocolRange } from './protocol-handshake'
import {
  SCRIPT_PROTOCOL_VERSION,
  MIN_SCRIPT_PROTOCOL_VERSION,
  CLIENT_PROTOCOL_VERSION,
  MIN_CLIENT_PROTOCOL_VERSION
} from './protocol'

const range = (min: number, current: number): ProtocolRange => ({ min, current })

describe('describeRange', () => {
  it('collapses a single-version range', () => {
    expect(describeRange(range(1, 1))).toBe('v1')
  })

  it('spells out a real range', () => {
    expect(describeRange(range(1, 3))).toBe('v1-v3')
  })
})

describe('checkProtocolVersion', () => {
  it('accepts the current version', () => {
    expect(checkProtocolVersion(3, range(1, 3))).toEqual({ compatible: true })
  })

  it('accepts the oldest still served', () => {
    expect(checkProtocolVersion(1, range(1, 3))).toEqual({ compatible: true })
  })

  it('accepts anything in between', () => {
    expect(checkProtocolVersion(2, range(1, 3)).compatible).toBe(true)
  })

  it('says nothing extra when compatible', () => {
    // A caller spreads the verdict into a reply; an `error: undefined` key
    // would show up as a field in the JSON.
    expect(checkProtocolVersion(2, range(1, 3)).error).toBeUndefined()
  })

  describe('distinguishes the two directions, because the fix differs', () => {
    it('calls a too-old peer old', () => {
      const { compatible, error } = checkProtocolVersion(1, range(2, 3))
      expect(compatible).toBe(false)
      expect(error).toMatch(/older/)
      expect(error).toMatch(/v2-v3/)
    })

    it('calls a too-new peer new', () => {
      // "Update your script" vs "update Spaceterm" — collapsing these into one
      // message makes the user guess which side to change.
      const { compatible, error } = checkProtocolVersion(4, range(1, 3))
      expect(compatible).toBe(false)
      expect(error).toMatch(/newer/)
    })

    it('names the offending version in both messages', () => {
      expect(checkProtocolVersion(9, range(1, 3)).error).toMatch(/v9/)
      expect(checkProtocolVersion(1, range(5, 7)).error).toMatch(/v1/)
    })
  })

  describe('rejects a version that is not a version', () => {
    // The number arrives over a socket from code we did not write.
    it('rejects zero and negatives', () => {
      expect(checkProtocolVersion(0, range(1, 3)).compatible).toBe(false)
      expect(checkProtocolVersion(-1, range(1, 3)).compatible).toBe(false)
    })

    it('rejects a fraction', () => {
      expect(checkProtocolVersion(1.5, range(1, 3)).compatible).toBe(false)
    })

    it('rejects NaN and Infinity rather than comparing them', () => {
      // NaN fails every comparison, so a naive range check would call it
      // compatible by falling through both bounds.
      expect(checkProtocolVersion(NaN, range(1, 3)).compatible).toBe(false)
      expect(checkProtocolVersion(Infinity, range(1, 3)).compatible).toBe(false)
    })

    it('explains itself rather than just saying no', () => {
      expect(checkProtocolVersion(NaN, range(1, 3)).error).toMatch(/Invalid protocol version/)
    })
  })
})

describe('the versions this build actually declares', () => {
  it('serves its own scripts protocol version', () => {
    const r = range(MIN_SCRIPT_PROTOCOL_VERSION, SCRIPT_PROTOCOL_VERSION)
    expect(checkProtocolVersion(SCRIPT_PROTOCOL_VERSION, r).compatible).toBe(true)
  })

  it('serves its own client protocol version', () => {
    const r = range(MIN_CLIENT_PROTOCOL_VERSION, CLIENT_PROTOCOL_VERSION)
    expect(checkProtocolVersion(CLIENT_PROTOCOL_VERSION, r).compatible).toBe(true)
  })

  it('does not declare a minimum newer than its current, on either socket', () => {
    // An inverted range serves nothing at all, and every peer would be told it
    // is simultaneously too old and too new.
    expect(MIN_SCRIPT_PROTOCOL_VERSION).toBeLessThanOrEqual(SCRIPT_PROTOCOL_VERSION)
    expect(MIN_CLIENT_PROTOCOL_VERSION).toBeLessThanOrEqual(CLIENT_PROTOCOL_VERSION)
  })
})
