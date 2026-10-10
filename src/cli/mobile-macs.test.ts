import { describe, it, expect } from 'vitest'
import { parseMacs, pairingHost, macsProblems, macsListFor, LOCAL_MACS_LIST } from './mobile-macs'

const HOME = 'home.tail1.ts.net'
const WORK = 'work.tail2.ts.net'
const homeUrl = `https://${HOME}/#token=aaa`
const workUrl = `https://${WORK}/#token=bbb`

describe('parseMacs', () => {
  it('reads one host per line, skipping blanks and comments', () => {
    expect(parseMacs(`# every Mac\n  ${HOME}  \n\n${WORK}\n`)).toEqual([HOME, WORK])
  })
})

describe('pairingHost', () => {
  it('takes the host from a pairing URL and nothing else', () => {
    expect(pairingHost(homeUrl)).toBe(HOME)
    expect(pairingHost(`http://${HOME}/#token=aaa`)).toBeNull()
    expect(pairingHost(`https://${HOME}/`)).toBeNull()
    expect(pairingHost('not a url')).toBeNull()
  })
})

describe('macsProblems', () => {
  it('is quiet when this Mac is listed and every other one has a pairing URL', () => {
    expect(macsProblems({ required: [HOME, WORK], own: WORK, others: [homeUrl] })).toEqual([])
  })

  it('says this Mac is missing from the list', () => {
    const problems = macsProblems({ required: [WORK], own: HOME, others: [workUrl] })
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatch(/src\/mobile\/ios\/macs does not list this Mac \(home\.tail1\.ts\.net\)/)
  })

  it('offers someone else\'s copy a private list instead of committing to this one', () => {
    const [problem] = macsProblems({ required: [WORK], own: HOME, others: [] })
    expect(problem).toContain(`put your Macs in ${LOCAL_MACS_LIST}`)
    expect(problem).toContain(`starting with this line: ${HOME}`)
  })

  it('names the private list, and only asks for this Mac, once that list is in use', () => {
    const problems = macsProblems({ required: [], list: LOCAL_MACS_LIST, own: HOME, others: [] })
    expect(problems).toEqual([`${LOCAL_MACS_LIST} does not list this Mac (${HOME}): add that line`])
  })

  it('reads the private list when there is one', () => {
    expect(macsListFor(true)).toBe(LOCAL_MACS_LIST)
    expect(macsListFor(false)).toBe('src/mobile/ios/macs')
  })

  it('says which Mac is missing from other-macs and how to get its line', () => {
    const problems = macsProblems({ required: [HOME, WORK], own: HOME, others: [] })
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatch(/other-macs is missing work\.tail2\.ts\.net/)
    expect(problems[0]).toMatch(/npm run mobile:link -- --url/)
  })

  it('rejects a line that is not a pairing URL', () => {
    const problems = macsProblems({ required: [HOME, WORK], own: HOME, others: [`https://${WORK}/`] })
    expect(problems).toHaveLength(2)
    expect(problems[0]).toMatch(/not a pairing URL/)
    expect(problems[1]).toMatch(/missing work\.tail2\.ts\.net/)
  })
})
