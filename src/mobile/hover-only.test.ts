import { describe, it, expect } from 'vitest'
import postcss from 'postcss'
import { hoverOnly } from './hover-only'

const run = async (css: string) => (await postcss([hoverOnly()]).process(css, { from: undefined })).css.replace(/\s+/g, ' ').replace(/}\s*@/g, '} @').replace(/{(\S)/g, '{ $1').trim()

describe('hoverOnly', () => {
  it('puts a hover rule where only a pointer can reach it', async () => {
    expect(await run('.btn:hover { color: red }')).toBe('@media (hover: hover) { .btn:hover { color: red } }')
  })

  it('leaves rules without hover alone', async () => {
    expect(await run('.btn { color: red }')).toBe('.btn { color: red }')
  })

  it('splits a selector list, keeping the plain selectors unconditional', async () => {
    expect(await run('.btn:hover, .btn.active { color: red }'))
      .toBe('.btn.active { color: red } @media (hover: hover) { .btn:hover { color: red } }')
  })

  it('wraps once, including a rule already inside another media query', async () => {
    const out = await run('@media (max-width: 500px) { .a:hover { color: red } }')
    expect(out).toBe('@media (max-width: 500px) { @media (hover: hover) { .a:hover { color: red } } }')
    expect(out.match(/hover: hover/g)).toHaveLength(1)
  })
})
