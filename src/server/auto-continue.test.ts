import { describe, it } from 'vitest'
import { findApiErrorMatch } from './auto-continue'

/**
 * Tests for Claude Code API-error scrollback matching.
 *
 * Run with: npm test
 */

interface Case { name: string; run: () => void }

function assertMatch(text: string, shouldMatch: boolean): void {
  const match = findApiErrorMatch(text)
  const matched = match !== null
  if (matched !== shouldMatch) {
    throw new Error(
      `expected ${shouldMatch ? 'match' : 'no match'}, got ${matched ? `match=${JSON.stringify(match[0])}` : 'null'} for:\n${text}`
    )
  }
}

const cases: Case[] = [
  {
    name: 'matches documented 500 Internal server error',
    run: () => {
      assertMatch(
        'API Error: 500 Internal server error. This is a server-side issue, usually temporary — try again in a moment.',
        true
      )
    },
  },
  {
    name: 'matches JSON-bodied 500 api_error',
    run: () => {
      assertMatch(
        'API Error: 500 {"type":"error","error":{"type":"api_error","message":"Internal server error"}} · check status.claude.com',
        true
      )
    },
  },
  {
    name: 'matches Repeated 529 Overloaded errors',
    run: () => {
      assertMatch(
        'API Error: Repeated 529 Overloaded errors. The API is at capacity — this is usually temporary.',
        true
      )
    },
  },
  {
    name: 'matches bare 529 with overloaded_error JSON',
    run: () => {
      assertMatch(
        'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
        true
      )
    },
  },
  {
    name: 'matches mid-response server error',
    run: () => {
      assertMatch('API Error: Server error mid-response. The response above may be incomplete.', true)
    },
  },
  {
    name: 'matches connection closed mid-response',
    run: () => {
      assertMatch('API Error: Connection closed mid-response. The response above may be incomplete.', true)
    },
  },
  {
    name: 'matches response stalled mid-stream',
    run: () => {
      assertMatch('API Error: Response stalled mid-stream. The response above may be incomplete.', true)
    },
  },
  {
    name: 'rejects bare 500 in assistant prose (canonical false positive)',
    run: () => {
      assertMatch(
        "One reviewer claim I checked rather than accepted: the redirectUri P2 is non-string yields a 500. It doesn't — assertValidOAuthRedirectUri catches its own new URL() throw and return 400.",
        false
      )
    },
  },
  {
    name: 'rejects bare rate limit / overloaded wording without API Error framing',
    run: () => {
      assertMatch('hit a rate limit while calling checkRateLimit; server returned overloaded', false)
    },
  },
  {
    name: 'rejects API Error 400 request errors',
    run: () => {
      assertMatch('API Error: 400 due to tool use concurrency issues. Run /rewind to recover the conversation.', false)
    },
  },
  {
    name: 'rejects normal completion text',
    run: () => {
      assertMatch('Pushed 906248cea. Mutation-verified, 1,113 tests green.', false)
    },
  },
]

describe('potential-error API error matching', () => {
  for (const c of cases) {
    it(c.name, () => { c.run() })
  }
})
