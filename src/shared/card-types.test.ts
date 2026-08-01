import { describe, it, expect } from 'vitest'
import {
  CARD_TYPES,
  CARD_TYPE_SPECS,
  isCardType,
  measureCard,
  type CardType
} from './card-types'
import {
  DIRECTORY_HEIGHT,
  FILE_WIDTH,
  FILE_HEIGHT,
  TITLE_HEIGHT,
  TITLE_LINE_HEIGHT,
  TITLE_MIN_WIDTH,
  terminalPixelSize,
  directoryFolderWidth
} from './node-size'

describe('the registry covers every card type', () => {
  it('has a spec for each, keyed consistently', () => {
    for (const type of CARD_TYPES) {
      expect(CARD_TYPE_SPECS[type]).toBeDefined()
      expect(CARD_TYPE_SPECS[type].type).toBe(type)
    }
  })

  it('lists exactly the specs it has', () => {
    expect([...CARD_TYPES].sort()).toEqual(Object.keys(CARD_TYPE_SPECS).sort())
  })

  it('gives every type a label and a usable default size', () => {
    for (const type of CARD_TYPES) {
      const spec = CARD_TYPE_SPECS[type]
      expect(spec.label).toBeTruthy()
      expect(spec.defaultSize.width).toBeGreaterThan(0)
      expect(spec.defaultSize.height).toBeGreaterThan(0)
    }
  })
})

describe('isCardType', () => {
  it('accepts every registered type', () => {
    for (const type of CARD_TYPES) expect(isCardType(type)).toBe(true)
  })

  it('rejects anything else', () => {
    expect(isCardType('canvas-embed')).toBe(false)
    expect(isCardType('')).toBe(false)
    expect(isCardType(null)).toBe(false)
    expect(isCardType(42)).toBe(false)
  })
})

describe('measureCard', () => {
  it('measures a terminal from its grid', () => {
    expect(measureCard({ type: 'terminal', cols: 80, rows: 24 }))
      .toEqual(terminalPixelSize(80, 24))
  })

  it('grows a terminal with its grid', () => {
    const small = measureCard({ type: 'terminal', cols: 80, rows: 24 })
    const large = measureCard({ type: 'terminal', cols: 160, rows: 45 })
    expect(large.width).toBeGreaterThan(small.width)
    expect(large.height).toBeGreaterThan(small.height)
  })

  it('measures a directory from its path, at a fixed height', () => {
    const size = measureCard({ type: 'directory', cwd: '/some/long/path/to/a/project' })
    expect(size.height).toBe(DIRECTORY_HEIGHT)
    expect(size.width).toBe(directoryFolderWidth('/some/long/path/to/a/project'))
  })

  it('widens a directory for a long git status', () => {
    const plain = measureCard({ type: 'directory', cwd: '/p' })
    const busy = measureCard({
      type: 'directory',
      cwd: '/p',
      gitStatus: {
        branch: 'a-rather-long-feature-branch-name',
        ahead: 12, behind: 3, staged: 4, unstaged: 5, untracked: 6, conflicts: 7
      }
    })
    expect(busy.width).toBeGreaterThan(plain.width)
  })

  it('gives a file a fixed size', () => {
    expect(measureCard({ type: 'file' })).toEqual({ width: FILE_WIDTH, height: FILE_HEIGHT })
  })

  it('measures a markdown from its stored dimensions', () => {
    expect(measureCard({ type: 'markdown', width: 640, height: 480 }))
      .toEqual({ width: 640, height: 480 })
  })

  describe('title', () => {
    it('is one line tall for single-line text', () => {
      expect(measureCard({ type: 'title', text: 'Hello' }).height).toBe(TITLE_HEIGHT)
    })

    it('grows a line at a time', () => {
      const two = measureCard({ type: 'title', text: 'a\nb' })
      const three = measureCard({ type: 'title', text: 'a\nb\nc' })
      expect(two.height).toBe(TITLE_HEIGHT + TITLE_LINE_HEIGHT)
      expect(three.height).toBe(two.height + TITLE_LINE_HEIGHT)
    })

    it('sizes width to the longest line, not the total length', () => {
      const oneLong = measureCard({ type: 'title', text: 'aaaaaaaaaaaaaaaaaaaa' })
      const manyShort = measureCard({ type: 'title', text: 'aa\naa\naa\naa\naa\naa\naa\naa\naa\naa' })
      expect(oneLong.width).toBeGreaterThan(manyShort.width)
    })

    it('never goes below the minimum width', () => {
      expect(measureCard({ type: 'title', text: '' }).width).toBe(TITLE_MIN_WIDTH)
      expect(measureCard({ type: 'title', text: 'x' }).width).toBe(TITLE_MIN_WIDTH)
    })
  })

  it('returns a positive size for every type at its defaults', () => {
    // Placement reserves space before a node exists, so a zero or NaN here
    // would silently overlap cards rather than fail.
    const samples: Record<CardType, Parameters<typeof measureCard>[0]> = {
      terminal: { type: 'terminal', cols: 80, rows: 24 },
      markdown: { type: 'markdown', width: 400, height: 300 },
      directory: { type: 'directory', cwd: '~' },
      file: { type: 'file' },
      title: { type: 'title', text: '' }
    }
    for (const type of CARD_TYPES) {
      const size = measureCard(samples[type])
      expect(Number.isFinite(size.width) && size.width > 0).toBe(true)
      expect(Number.isFinite(size.height) && size.height > 0).toBe(true)
    }
  })
})

describe('defaultSize agrees with measureCard for the fixed-size types', () => {
  it('file', () => {
    expect(CARD_TYPE_SPECS.file.defaultSize).toEqual(measureCard({ type: 'file' }))
  })

  it('markdown', () => {
    const { width, height } = CARD_TYPE_SPECS.markdown.defaultSize
    expect(measureCard({ type: 'markdown', width, height })).toEqual({ width, height })
  })

  it('marks the content-sized types as such', () => {
    // These three cannot be placed from defaultSize alone — their footprint
    // depends on the grid, the path, or the text.
    expect(CARD_TYPE_SPECS.terminal.contentSized).toBe(true)
    expect(CARD_TYPE_SPECS.directory.contentSized).toBe(true)
    expect(CARD_TYPE_SPECS.title.contentSized).toBe(true)
    expect(CARD_TYPE_SPECS.file.contentSized).toBe(false)
    expect(CARD_TYPE_SPECS.markdown.contentSized).toBe(false)
  })
})
