import { describe, it, expect } from 'vitest'
import {
  asNodeId,
  asPtySessionId,
  asClaudeSessionId,
  nodeIdFromFirstPtySession,
  nodeIdsOf,
  ROOT_NODE_ID
} from './ids'

// The compile-time behaviour is the point of this module, and a runtime test
// cannot observe it — see the type-level assertions at the bottom. What is
// worth pinning at runtime is that branding is genuinely free: a branded id has
// to behave exactly like the string it wraps, because it is written to sockets,
// used as a Record key, and sliced for log lines all over the codebase.

describe('branded ids are ordinary strings at runtime', () => {
  it('preserve the value', () => {
    expect(asNodeId('abc')).toBe('abc')
    expect(asPtySessionId('abc')).toBe('abc')
    expect(asClaudeSessionId('abc')).toBe('abc')
  })

  it('survive JSON round-trips, which is how they cross every socket', () => {
    const msg = { nodeId: asNodeId('n1'), sessionId: asPtySessionId('s1') }
    expect(JSON.parse(JSON.stringify(msg))).toEqual({ nodeId: 'n1', sessionId: 's1' })
  })

  it('work as Record keys and Map keys', () => {
    const id = asNodeId('n1')
    const rec: Record<string, number> = { [id]: 1 }
    const map = new Map([[id, 1]])

    expect(rec[id]).toBe(1)
    expect(rec['n1']).toBe(1)
    expect(map.get(id)).toBe(1)
  })

  it('support the string methods the logging code uses', () => {
    const id = asNodeId('0123456789abcdef')
    expect(id.slice(0, 8)).toBe('01234567')
    expect(`${id}`).toBe('0123456789abcdef')
  })

  it('compare by value, so two brandings of the same string are equal', () => {
    expect(asNodeId('x') === asNodeId('x')).toBe(true)
  })
})

describe('nodeIdFromFirstPtySession', () => {
  it('is the identity at runtime — the two ids are the same value at first launch', () => {
    expect(nodeIdFromFirstPtySession(asPtySessionId('pty-1'))).toBe('pty-1')
  })
})

describe('nodeIdsOf', () => {
  it('returns the map keys', () => {
    expect(nodeIdsOf({ a: 1, b: 2 })).toEqual(['a', 'b'])
  })

  it('returns an empty array for an empty map', () => {
    expect(nodeIdsOf({})).toEqual([])
  })
})

describe('ROOT_NODE_ID', () => {
  it("is the literal 'root' every parentId chain terminates at", () => {
    expect(ROOT_NODE_ID).toBe('root')
  })
})

// --- Type-level assertions ---
// These do nothing at runtime; they fail the build if branding stops working.
// That is the actual guarantee this module exists to provide.

/** True only when A and B are the same type. */
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
function expectType<T extends true>(_: T): void {}

// A branded id is assignable to string...
expectType<ReturnType<typeof asNodeId> extends string ? true : false>(true)
// ...but a plain string is not assignable to a branded id.
expectType<Equals<string extends ReturnType<typeof asNodeId> ? true : false, false>>(true)
// ...and the three brands are mutually incompatible, which is the whole point.
expectType<
  Equals<ReturnType<typeof asNodeId> extends ReturnType<typeof asPtySessionId> ? true : false, false>
>(true)
expectType<
  Equals<ReturnType<typeof asPtySessionId> extends ReturnType<typeof asClaudeSessionId> ? true : false, false>
>(true)
