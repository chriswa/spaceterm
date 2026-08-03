import { describe, it, expect } from 'vitest'
import {
  CARD_TYPES,
  CARD_TYPE_SPECS,
  cardChromeScale,
  isCardType,
  measureCard,
  tieredZIndex,
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

describe('tieredZIndex', () => {
  // Two of App.tsx's five card blocks called the old tiering helper and two did
  // not, which read as a real difference between card kinds. It was not — the
  // helper is the identity for their types — and that is what makes one shared
  // prop bundle safe.

  it('leaves ordinary cards where they are', () => {
    for (const type of ['terminal', 'markdown', 'file'] as const) {
      expect(tieredZIndex(type, 42), type).toBe(42)
    }
  })

  it('floats directories above ordinary cards', () => {
    expect(tieredZIndex('directory', 0)).toBeGreaterThan(tieredZIndex('terminal', 999_999))
  })

  it('floats titles above directories', () => {
    // A title must never end up buried under the terminal it labels, whatever
    // order the user last touched them in.
    expect(tieredZIndex('title', 0)).toBeGreaterThan(tieredZIndex('directory', 999_999))
  })

  it('keeps a card’s own z-index meaningful inside its tier', () => {
    expect(tieredZIndex('title', 5)).toBeGreaterThan(tieredZIndex('title', 4))
    expect(tieredZIndex('directory', 5)).toBeGreaterThan(tieredZIndex('directory', 4))
  })

  it('gives every card type a tier, so a new one cannot default to nothing', () => {
    for (const type of CARD_TYPES) {
      expect(typeof CARD_TYPE_SPECS[type].zIndexTier, type).toBe('number')
    }
  })

  it('spaces the tiers far enough apart that a real z-index cannot cross one', () => {
    // z-index comes from a monotonically increasing counter that only advances
    // on bring-to-front, so a million is generous — but the gap is the
    // invariant, not the specific number.
    const tiers = [...new Set(CARD_TYPES.map((t) => CARD_TYPE_SPECS[t].zIndexTier))].sort((a, b) => a - b)
    for (let i = 1; i < tiers.length; i++) {
      expect(tiers[i] - tiers[i - 1]).toBeGreaterThanOrEqual(1_000_000)
    }
  })
})

describe('cardChromeScale', () => {
  it('cancels a focus ceiling exactly, and leaves uncapped cards alone', () => {
    // This is the whole point of deriving the scale instead of tuning a second
    // number: focus zoom × chrome scale = 1 means the buttons land at the size
    // they were drawn at, whatever the ceiling is later retuned to.
    for (const type of CARD_TYPES) {
      const ceiling = CARD_TYPE_SPECS[type].focusMaxZoom
      if (ceiling === null) {
        expect(cardChromeScale(type), type).toBe(1)
      } else {
        expect(cardChromeScale(type) * ceiling, type).toBeCloseTo(1)
      }
    }
  })

  it('enlarges the capped types enough to matter', () => {
    // A ceiling that barely scales the chrome would mean the cap is doing
    // nothing either — the two move together by construction.
    expect(cardChromeScale('title')).toBeGreaterThan(2)
    expect(cardChromeScale('directory')).toBeGreaterThan(2)
  })

  it('leaves chrome unscaled when there is no card type', () => {
    // The root node, and any card rendered before its node reaches the store.
    expect(cardChromeScale(null)).toBe(1)
    expect(cardChromeScale(undefined)).toBe(1)
  })
})
