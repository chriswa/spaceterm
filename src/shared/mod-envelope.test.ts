import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import type { ClientMessage, ModMessage, ServerMessage } from './protocol'

/**
 * The contract behind `ModMessage`: the base relays a mod's traffic without
 * understanding it.
 *
 * The type system can only say so much here — `payload` is `unknown`, which
 * stops it being *read* but not being narrowed with a cast. What actually
 * keeps the promise is that no code in this repo tries, so the second half of
 * this file checks the source rather than the types.
 */

const REPO = join(import.meta.dirname, '..', '..')

describe('the envelope shape', () => {
  it('is one variant on each direction of the client socket', () => {
    // Assignable to both unions from one literal: the same envelope travels
    // renderer→server and server→renderer, and neither direction needs its own
    // type. If a future edit splits them, this stops compiling.
    const envelope: ModMessage = {
      type: 'mod',
      modId: 'summary-chat',
      event: 'status',
      payload: { nodeId: 'node-1', state: 'thinking' },
    }
    const asClient: ClientMessage = envelope
    const asServer: ServerMessage = envelope
    expect(asClient.type).toBe('mod')
    expect(asServer.type).toBe('mod')
  })

  it('carries a payload the base cannot read without asserting', () => {
    const envelope: ModMessage = { type: 'mod', modId: 'm', event: 'e', payload: { a: 1 } }
    // @ts-expect-error — payload is `unknown`; reading a field is the mistake
    // this type exists to prevent.
    const _bad = envelope.payload.a
    expect(envelope.payload).toEqual({ a: 1 })
  })
})

/**
 * Files that route envelopes. Each is allowed to read `modId` — that is the
 * routing key — and must not touch `payload` beyond passing it along.
 */
const ROUTING_FILES = [
  'src/client/main/index.ts',
  'src/client/main/server-client.ts',
  'src/client/preload/index.ts',
  'src/server/index.ts',
  'src/server/script-api.ts',
]

/**
 * Every way of looking inside a value rather than forwarding it. Bare
 * `payload` — as an argument or a shorthand property — is the pass-through and
 * is what these files are supposed to do.
 */
const INSPECTIONS = [
  /payload\s*\./,
  /payload\s*\[/,
  /payload\s+as\s+/,
  /\{\s*[^}]*\}\s*=\s*[a-zA-Z.]*payload/,
]

describe('no part of the base inspects a payload', () => {
  it.each(ROUTING_FILES)('%s only passes it through', (relative) => {
    const source = readFileSync(join(REPO, relative), 'utf-8')

    // Scoped to lines that also mention `modId`, because that is the routing
    // key and every envelope site has it. Scanning for `payload` alone would
    // catch `HookMessage.payload` in the server, which is a different thing
    // the server is entirely entitled to read.
    const envelopeLines = source
      .split('\n')
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line }) => line.includes('modId') && line.includes('payload'))

    expect(envelopeLines.length, `${relative} routes no envelopes`).toBeGreaterThan(0)

    for (const { line, n } of envelopeLines) {
      for (const pattern of INSPECTIONS) {
        expect(pattern.test(line), `${relative}:${n} inspects payload — ${line.trim()}`).toBe(false)
      }
    }
  })

  it('keeps the routing surface small enough to check by hand', () => {
    // If this list grows, the envelope has stopped being a relay and the base
    // has started participating — which is the failure mode worth catching.
    expect(ROUTING_FILES.length).toBeLessThanOrEqual(6)
  })
})
