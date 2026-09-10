import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { parseFrontmatter, documentSummary } from './frontmatter'

describe('parseFrontmatter', () => {
  it('reads the two keys a skill header actually carries', () => {
    const { name, description, body } = parseFrontmatter(
      '---\nname: cartesia-fixup\ndescription: Use when TTS mispronounced something.\n---\n\n# Heading\n\nBody.'
    )
    expect(name).toBe('cartesia-fixup')
    expect(description).toBe('Use when TTS mispronounced something.')
    expect(body.trim()).toBe('# Heading\n\nBody.')
  })

  it('folds an indented continuation into the value it continues', () => {
    // Real skill descriptions wrap. A card showing only the first line would
    // cut off mid-sentence, which is exactly what this guards.
    const { description } = parseFrontmatter(
      '---\nname: x\ndescription: first part\n  second part\n  third part\n---\nbody'
    )
    expect(description).toBe('first part second part third part')
  })

  it('strips matching quotes, so name: "x" and name: x read the same', () => {
    expect(parseFrontmatter('---\nname: "quoted"\n---\n').name).toBe('quoted')
    expect(parseFrontmatter("---\nname: 'quoted'\n---\n").name).toBe('quoted')
    // A lone quote is content, not a delimiter.
    expect(parseFrontmatter('---\nname: it\'s\n---\n').name).toBe("it's")
  })

  it('ignores keys nothing reads rather than choking on them', () => {
    const fm = parseFrontmatter('---\nname: x\nallowed-tools: Bash, Read\nmodel: opus\n---\nbody')
    expect(fm.name).toBe('x')
    expect(fm.body).toBe('body')
  })

  it('treats a document with no header as all body — the CLAUDE.md case', () => {
    const text = '# Project\n\nSome instructions.'
    const fm = parseFrontmatter(text)
    expect(fm.name).toBeUndefined()
    expect(fm.body).toBe(text)
  })

  it('treats an unterminated header as all body, not as a header of prose', () => {
    // A file mid-edit. Reading the rest of it as header values would put a
    // paragraph of prose in the card's title.
    const text = '---\nname: x\n\nthis file is being edited'
    expect(parseFrontmatter(text).name).toBeUndefined()
    expect(parseFrontmatter(text).body).toBe(text)
  })

  it('survives an empty document and a bare fence', () => {
    expect(parseFrontmatter('').body).toBe('')
    expect(parseFrontmatter('---\n---\n').name).toBeUndefined()
  })
})

describe('documentSummary', () => {
  it('prefers the header when there is one', () => {
    const s = documentSummary('---\nname: n\ndescription: d\n---\n# Other\n\nProse.', 'file.md')
    expect(s).toEqual({ name: 'n', description: 'd' })
  })

  it('falls back to the first heading and first paragraph — the CLAUDE.md shape', () => {
    const s = documentSummary('# Spaceterm\n\nA canvas for terminals.\n\n## More\n\nDetail.', 'CLAUDE.md')
    expect(s.name).toBe('Spaceterm')
    expect(s.description).toBe('A canvas for terminals.')
  })

  it('joins a wrapped paragraph into one line', () => {
    const s = documentSummary('# T\n\nline one\nline two\n\nnext para', 'f.md')
    expect(s.description).toBe('line one line two')
  })

  it('does not open a summary with a code fence', () => {
    const s = documentSummary('# T\n\n```bash\nnpm run dev\n```\n\nReal prose.', 'f.md')
    expect(s.description).toBe('Real prose.')
  })

  it('uses the filename when the document offers no title', () => {
    expect(documentSummary('just prose, no heading', 'NOTES.md').name).toBe('NOTES.md')
    expect(documentSummary('', 'EMPTY.md')).toEqual({ name: 'EMPTY.md', description: null })
  })
})

/**
 * Fixtures, not mocks: the parser's job is to read the files that are actually
 * on this machine, so the test reads them. Skipped rather than failed when a
 * path is absent, since a checkout elsewhere will not have the devkit plugin.
 */
describe('against real SKILL.md files on disk', () => {
  const candidates = [
    join(process.cwd(), '.claude/skills/cartesia-fixup/SKILL.md'),
    join(process.cwd(), '.claude/skills/copy-cleanup-fix/SKILL.md'),
    join(homedir(), 'chriswa-devkit/default-plugin/skills/recall/SKILL.md')
  ].filter(existsSync)

  it('finds a description in every one, and consumes the header it read', () => {
    if (candidates.length === 0) return
    for (const path of candidates) {
      const fm = parseFrontmatter(readFileSync(path, 'utf-8'))
      expect(fm.description, path).toBeTruthy()
      // The body must not still contain the header it just consumed.
      expect(fm.body.trimStart().startsWith('---'), path).toBe(false)
    }
  })

  it('titles a skill from its directory when the header omits name', () => {
    // Three of the six skills on this machine have no `name:` key — Claude Code
    // takes the name from the directory, so a card that insisted on the header
    // would show half of them untitled. This is the whole reason
    // `documentSummary` takes a fallback rather than returning name | undefined.
    const nameless = candidates.find(
      (p) => parseFrontmatter(readFileSync(p, 'utf-8')).name === undefined
    )
    if (!nameless) return
    const dirName = nameless.split('/').slice(-2)[0]
    const summary = documentSummary(readFileSync(nameless, 'utf-8'), dirName)
    expect(summary.name).toBe(dirName)
    expect(summary.description).toBeTruthy()
  })
})
