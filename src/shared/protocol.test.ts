import { describe, it, expect } from 'vitest'
import {
  SCRIPT_EVENTS,
  SCRIPT_PROTOCOL_VERSION,
  MIN_SCRIPT_PROTOCOL_VERSION,
  type ScriptEvent,
  type ScriptHelloResult,
  type ScriptMessage,
  type ScriptResponse
} from './protocol'

describe('script protocol version', () => {
  it('is a positive integer', () => {
    expect(Number.isInteger(SCRIPT_PROTOCOL_VERSION)).toBe(true)
    expect(SCRIPT_PROTOCOL_VERSION).toBeGreaterThan(0)
  })

  it('serves a non-empty range', () => {
    expect(MIN_SCRIPT_PROTOCOL_VERSION).toBeGreaterThan(0)
    expect(MIN_SCRIPT_PROTOCOL_VERSION).toBeLessThanOrEqual(SCRIPT_PROTOCOL_VERSION)
  })
})

describe('the subscribable event set', () => {
  it('covers everything a script can subscribe to today', () => {
    // Pinned deliberately: this list is the public contract, so adding to it
    // should be a visible decision rather than a side effect of a new broadcast
    // call. Removing or renaming one needs a SCRIPT_PROTOCOL_VERSION bump.
    expect([...SCRIPT_EVENTS]).toEqual([
      'node-updated',
      'node-added',
      'node-removed',
      'exit',
      'broadcast'
    ])
  })

  it('has no duplicates', () => {
    expect(new Set(SCRIPT_EVENTS).size).toBe(SCRIPT_EVENTS.length)
  })
})

describe('the hello handshake', () => {
  // Mirrors the server's check, so the compatibility rule is pinned somewhere
  // a script author can read it.
  function compatible(claimed: number): boolean {
    return claimed >= MIN_SCRIPT_PROTOCOL_VERSION && claimed <= SCRIPT_PROTOCOL_VERSION
  }

  it('accepts this build own version', () => {
    expect(compatible(SCRIPT_PROTOCOL_VERSION)).toBe(true)
  })

  it('accepts the oldest still-served version', () => {
    expect(compatible(MIN_SCRIPT_PROTOCOL_VERSION)).toBe(true)
  })

  it('rejects a version older than we serve', () => {
    expect(compatible(MIN_SCRIPT_PROTOCOL_VERSION - 1)).toBe(false)
  })

  it('rejects a script written against a newer build', () => {
    // The important direction: a newer script would otherwise half-understand
    // our replies rather than failing loudly.
    expect(compatible(SCRIPT_PROTOCOL_VERSION + 1)).toBe(false)
  })
})

describe('type-level contract', () => {
  it('hello is part of the ScriptMessage union', () => {
    const msg: ScriptMessage = { type: 'script-hello', seq: 1, protocolVersion: 1 }
    expect(msg.type).toBe('script-hello')
  })

  it('hello-result is part of the ScriptResponse union', () => {
    const result: ScriptResponse = {
      type: 'script-hello-result',
      seq: 1,
      compatible: true,
      protocolVersion: SCRIPT_PROTOCOL_VERSION,
      minProtocolVersion: MIN_SCRIPT_PROTOCOL_VERSION,
      events: [...SCRIPT_EVENTS]
    }
    expect(result.type).toBe('script-hello-result')
  })

  it('a hello-result advertises every event, so a script can discover them', () => {
    const result: ScriptHelloResult = {
      type: 'script-hello-result',
      seq: 1,
      compatible: true,
      protocolVersion: SCRIPT_PROTOCOL_VERSION,
      minProtocolVersion: MIN_SCRIPT_PROTOCOL_VERSION,
      events: [...SCRIPT_EVENTS]
    }
    expect(result.events).toHaveLength(SCRIPT_EVENTS.length)
  })

  it('only documented events are assignable', () => {
    const event: ScriptEvent = 'node-added'
    expect(SCRIPT_EVENTS).toContain(event)
    // @ts-expect-error 'made-up' is not a documented event
    const bogus: ScriptEvent = 'made-up'
    expect(bogus).toBe('made-up')
  })
})
