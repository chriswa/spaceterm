import { describe, it, expect } from 'vitest'
import { parsePsOutput, sumDescendantRss } from './ps-tree'

const PS_OUTPUT = [
  '    1     0  22368',
  ' 1409     1  37632',   // the daemon
  ' 1416  1409 225888',   // an agent
  ' 1431  1409 231568',   // another agent
  ' 9001  1416  10240',   // something an agent spawned
  ' 5000     1 999999',   // unrelated
].join('\n')

describe('parsePsOutput', () => {
  it('reads pid, ppid and rss, converting kibibytes to bytes', () => {
    const rows = parsePsOutput(PS_OUTPUT)
    expect(rows).toHaveLength(6)
    expect(rows[1]).toEqual({ pid: 1409, ppid: 1, rssBytes: 37632 * 1024 })
  })

  it('drops lines that are not three integers', () => {
    const rows = parsePsOutput('\n  garbage here\n 7 1 100\n')
    expect(rows).toEqual([{ pid: 7, ppid: 1, rssBytes: 100 * 1024 }])
  })
})

describe('sumDescendantRss', () => {
  it('sums children and grandchildren but not the root itself', () => {
    const rows = parsePsOutput(PS_OUTPUT)
    expect(sumDescendantRss(rows, 1409)).toBe((225888 + 231568 + 10240) * 1024)
  })

  it('is zero for a process with no children', () => {
    expect(sumDescendantRss(parsePsOutput(PS_OUTPUT), 5000)).toBe(0)
  })

  it('is zero when the root is not in the listing at all', () => {
    expect(sumDescendantRss(parsePsOutput(PS_OUTPUT), 424242)).toBe(0)
  })

  it('terminates on a parent cycle from a reused pid', () => {
    const rows = parsePsOutput([' 10 20 100', ' 20 10 100'].join('\n'))
    expect(sumDescendantRss(rows, 10)).toBe(100 * 1024)
  })
})
