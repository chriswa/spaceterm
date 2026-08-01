import { describe, it, expect } from 'vitest'
import { assertNever, unhandledVariant } from './exhaustive'

type Msg = { type: 'a'; n: number } | { type: 'b' } | { type: 'c' }

describe('assertNever', () => {
  it('throws naming the context and the offending variant', () => {
    // Cast because the whole point is that this is unreachable when the switch
    // is exhaustive — we are exercising the runtime-drift path.
    const rogue = { type: 'unknown-variant' } as unknown as never
    expect(() => assertNever(rogue, 'testDispatch')).toThrow(
      'testDispatch: unhandled variant unknown-variant'
    )
  })

  it('is not reached when a switch covers the union', () => {
    function describe_(msg: Msg): string {
      switch (msg.type) {
        case 'a':
          return `a${msg.n}`
        case 'b':
          return 'b'
        case 'c':
          return 'c'
        default:
          return assertNever(msg, 'describe_')
      }
    }

    expect(describe_({ type: 'a', n: 1 })).toBe('a1')
    expect(describe_({ type: 'b' })).toBe('b')
    expect(describe_({ type: 'c' })).toBe('c')
  })
})

describe('unhandledVariant', () => {
  it('returns the type discriminant for logging', () => {
    expect(unhandledVariant({ type: 'script-frobnicate' } as unknown as never)).toBe(
      'script-frobnicate'
    )
  })

  it('does not throw — a socket peer sending garbage must not kill the handler', () => {
    expect(() => unhandledVariant({ type: 'nope' } as unknown as never)).not.toThrow()
  })

  it('describes values that are not shaped like a message', () => {
    expect(unhandledVariant(null as unknown as never)).toBe('null')
    expect(unhandledVariant(undefined as unknown as never)).toBe('undefined')
    expect(unhandledVariant('bare string' as unknown as never)).toBe('bare string')
    expect(unhandledVariant(42 as unknown as never)).toBe('42')
  })

  it('handles a non-string type field', () => {
    expect(unhandledVariant({ type: 7 } as unknown as never)).toBe('7')
  })

  it('handles an object with no type field', () => {
    expect(unhandledVariant({ foo: 1 } as unknown as never)).toBe('{"foo":1}')
  })
})
