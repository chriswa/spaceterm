import { describe, it, expect } from 'vitest'
import { existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import {
  scanAgentMeta,
  hasAgentMeta,
  REAL_META_SCAN_IO,
  type MetaScanIO
} from './agent-meta-scan'

/**
 * A literal filesystem. Keys are absolute paths; a value of `null` marks a
 * directory, a string marks a file with those contents.
 *
 * A fake rather than a temp directory on disk: the thing under test is a set of
 * *layout rules*, and a literal tree states the layout being tested right next
 * to the expectation about it.
 */
function fakeIO(tree: Record<string, string | null>): MetaScanIO {
  return {
    isDirectory: (p) => tree[p] === null,
    isFile: (p) => typeof tree[p] === 'string',
    readFile: (p) => (typeof tree[p] === 'string' ? (tree[p] as string) : undefined),
    readdir: (p) => {
      const prefix = p.endsWith('/') ? p : `${p}/`
      const names = new Set<string>()
      for (const key of Object.keys(tree)) {
        if (!key.startsWith(prefix)) continue
        const rest = key.slice(prefix.length)
        if (rest === '') continue
        names.add(rest.split('/')[0])
      }
      return [...names]
    }
  }
}

const skill = (description: string) => `---\ndescription: ${description}\n---\nbody`

describe('the user layout — ~/.claude', () => {
  const io = fakeIO({
    '/home/u/.claude': null,
    '/home/u/.claude/CLAUDE.md': '# global',
    '/home/u/.claude/skills': null,
    '/home/u/.claude/skills/finish': null,
    '/home/u/.claude/skills/finish/SKILL.md': skill('close out'),
    '/home/u/.claude/skills/recall': null,
    '/home/u/.claude/skills/recall/SKILL.md': skill('search back')
  })

  it('finds CLAUDE.md and skills directly inside, with no nested .claude', () => {
    const scan = scanAgentMeta('/home/u/.claude', 'user', io)
    expect(scan.docs.map((d) => d.key)).toEqual(['CLAUDE.md'])
    expect(scan.skills.map((s) => s.key)).toEqual(['finish', 'recall'])
    expect(scan.skillsRoot).toBe('/home/u/.claude/skills')
  })
})

describe('the project layout', () => {
  const io = fakeIO({
    '/w/proj': null,
    '/w/proj/CLAUDE.md': '# project',
    '/w/proj/.claude': null,
    '/w/proj/.claude/CLAUDE.md': '# rules',
    '/w/proj/.claude/skills': null,
    '/w/proj/.claude/skills/alpha': null,
    '/w/proj/.claude/skills/alpha/SKILL.md': skill('a'),
    '/w/proj/.claude/skills/alpha/references': null,
    '/w/proj/.claude/skills/notaskill': null,
    '/w/proj/.claude/skills/notaskill/README.md': 'no SKILL.md here'
  })

  it('treats the top-level and .claude CLAUDE.md as two different documents', () => {
    expect(scanAgentMeta('/w/proj', 'project', io).docs.map((d) => d.key)).toEqual([
      'CLAUDE.md',
      '.claude/CLAUDE.md'
    ])
  })

  it('takes only subdirectories that actually hold a SKILL.md', () => {
    // `references/` sits beside SKILL.md inside a skill, and a directory
    // without one is not a skill — showing it would be an empty card.
    expect(scanAgentMeta('/w/proj', 'project', io).skills.map((s) => s.key)).toEqual(['alpha'])
  })
})

describe('the plugin layout', () => {
  const io = fakeIO({
    '/w/plug': null,
    '/w/plug/.claude-plugin': null,
    '/w/plug/.claude-plugin/plugin.json': '{"name":"p"}',
    '/w/plug/skills': null,
    '/w/plug/skills/one': null,
    '/w/plug/skills/one/SKILL.md': skill('one'),
    // A plugin must NOT also be scanned as a project: this would be picked up
    // by the `.claude/skills` rule if the plugin check did not come first.
    '/w/plug/.claude': null,
    '/w/plug/.claude/skills': null,
    '/w/plug/.claude/skills/decoy': null,
    '/w/plug/.claude/skills/decoy/SKILL.md': skill('decoy')
  })

  it('reads skills/ and never .claude/skills', () => {
    const scan = scanAgentMeta('/w/plug', 'project', io)
    expect(scan.skills.map((s) => s.key)).toEqual(['one'])
    expect(scan.skillsRoot).toBe('/w/plug/skills')
  })
})

describe('the marketplace layout — what ~/chriswa-devkit actually is', () => {
  const io = fakeIO({
    '/w/kit': null,
    '/w/kit/.claude-plugin': null,
    '/w/kit/.claude-plugin/marketplace.json': JSON.stringify({
      name: 'kit',
      plugins: [{ name: 'devkit', source: './default-plugin' }]
    }),
    '/w/kit/default-plugin': null,
    '/w/kit/default-plugin/skills': null,
    '/w/kit/default-plugin/skills/recall': null,
    '/w/kit/default-plugin/skills/recall/SKILL.md': skill('recall'),
    '/w/kit/default-plugin/skills/session-id': null,
    '/w/kit/default-plugin/skills/session-id/SKILL.md': skill('session id')
  })

  it('follows the manifest one level down instead of reporting nothing', () => {
    const scan = scanAgentMeta('/w/kit', 'project', io)
    expect(scan.skills.map((s) => s.key)).toEqual(['devkit/recall', 'devkit/session-id'])
  })

  it('prefixes keys by plugin, so two plugins may ship the same skill name', () => {
    const two = fakeIO({
      '/w/kit': null,
      '/w/kit/.claude-plugin': null,
      '/w/kit/.claude-plugin/marketplace.json': JSON.stringify({
        plugins: [
          { name: 'a', source: './a' },
          { name: 'b', source: './b' }
        ]
      }),
      '/w/kit/a': null,
      '/w/kit/a/skills': null,
      '/w/kit/a/skills/recall': null,
      '/w/kit/a/skills/recall/SKILL.md': skill('a recall'),
      '/w/kit/b': null,
      '/w/kit/b/skills': null,
      '/w/kit/b/skills/recall': null,
      '/w/kit/b/skills/recall/SKILL.md': skill('b recall')
    })
    const keys = scanAgentMeta('/w/kit', 'project', two).skills.map((s) => s.key)
    expect(keys).toEqual(['a/recall', 'b/recall'])
    expect(new Set(keys).size).toBe(2)
  })

  it('survives a manifest that is mid-edit rather than throwing', () => {
    const broken = fakeIO({
      '/w/kit': null,
      '/w/kit/.claude-plugin': null,
      '/w/kit/.claude-plugin/marketplace.json': '{ "plugins": [ {'
    })
    expect(() => scanAgentMeta('/w/kit', 'project', broken)).not.toThrow()
    expect(scanAgentMeta('/w/kit', 'project', broken).skills).toEqual([])
  })

  it('ignores plugin sources that are not local directories', () => {
    const remote = fakeIO({
      '/w/kit': null,
      '/w/kit/.claude-plugin': null,
      '/w/kit/.claude-plugin/marketplace.json': JSON.stringify({
        plugins: [{ name: 'r', source: 'github:someone/thing' }]
      })
    })
    expect(scanAgentMeta('/w/kit', 'project', remote).skills).toEqual([])
  })
})

describe('nothing to show', () => {
  it('reports an empty scan for a directory that does not exist', () => {
    const scan = scanAgentMeta('/nope', 'project', fakeIO({}))
    expect(hasAgentMeta(scan)).toBe(false)
  })

  it('reports an empty scan for an ordinary directory', () => {
    const io = fakeIO({ '/w/plain': null, '/w/plain/index.ts': 'x' })
    expect(hasAgentMeta(scanAgentMeta('/w/plain', 'project', io))).toBe(false)
  })

  it('counts a lone CLAUDE.md as worth showing, with no skills at all', () => {
    const io = fakeIO({ '/w/doc': null, '/w/doc/CLAUDE.md': '# hi' })
    const scan = scanAgentMeta('/w/doc', 'project', io)
    expect(hasAgentMeta(scan)).toBe(true)
    expect(scan.skillsRoot).toBeNull()
  })
})

/**
 * Fixtures, not mocks: the layout rules exist to match this machine, so they
 * are checked against it. Skipped where a path is absent, since another
 * checkout will not have the devkit.
 */
describe('against the real directories on this machine', () => {
  it('finds this repo’s own skills under .claude/skills', () => {
    const scan = scanAgentMeta(process.cwd(), 'project', REAL_META_SCAN_IO)
    expect(scan.skills.length).toBeGreaterThan(0)
    expect(scan.docs.map((d) => d.key)).toContain('CLAUDE.md')
  })

  it('finds the user-level skills under ~/.claude', () => {
    const dir = join(homedir(), '.claude')
    if (!existsSync(dir)) return
    expect(scanAgentMeta(dir, 'user', REAL_META_SCAN_IO).skills.length).toBeGreaterThan(0)
  })

  it('reaches the devkit’s plugin skills through its marketplace manifest', () => {
    const dir = join(homedir(), 'chriswa-devkit')
    if (!existsSync(dir)) return
    const scan = scanAgentMeta(dir, 'project', REAL_META_SCAN_IO)
    expect(scan.skills.map((s) => s.key)).toContain('chriswa-devkit/recall')
  })
})
