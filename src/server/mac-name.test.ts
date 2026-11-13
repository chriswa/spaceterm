import { describe, expect, it } from 'vitest'
import { fromMac, macName, type MacNameSources } from './mac-name'

function sources(overrides: Partial<MacNameSources> = {}): MacNameSources {
  return { chosen: () => null, computerName: () => 'Chris’s MacBook Pro\n', hostname: () => 'chriss-mbp.local', ...overrides }
}

describe('macName', () => {
  it('is the name the user chose, when there is one', () => {
    expect(macName(sources({ chosen: () => 'Work\n' }))).toBe('Work')
  })

  it('is the Mac’s own name otherwise, or a blank file', () => {
    expect(macName(sources())).toBe('Chris’s MacBook Pro')
    expect(macName(sources({ chosen: () => '  \n' }))).toBe('Chris’s MacBook Pro')
  })

  it('falls back to the host name', () => {
    expect(macName(sources({ computerName: () => null }))).toBe('chriss-mbp')
  })
})

describe('fromMac', () => {
  it('leads the title with the Mac, in brackets', () => {
    expect(fromMac('Work', 'Fix the build')).toBe('[Work] Fix the build')
  })
})
