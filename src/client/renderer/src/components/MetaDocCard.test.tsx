import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent } from '@testing-library/react'
import { installFakeBridge } from '../testing/fake-bridge'
import { MetaDocCard } from './MetaDocCard'
import { useNodeStore } from '../stores/nodeStore'
import { asNodeId, type NodeId } from '../../../../shared/ids'
import type { Camera } from '../lib/camera'

/**
 * The collapsed face is the whole point of this card: a column of skills is
 * only readable if each one says what it is without being opened. These check
 * that the face is derived from the file rather than from anything the server
 * had to send, including for the two shapes that actually exist on disk — a
 * skill with a `name:` and a skill without one.
 */

const nid = asNodeId

function props(overrides: Partial<Parameters<typeof MetaDocCard>[0]> = {}) {
  return {
    id: nid('meta:host:doc:alpha'),
    x: 100,
    y: 200,
    width: 600,
    height: 96,
    zIndex: 3,
    zoom: 1,
    content: '',
    docKind: 'skill' as const,
    docKey: 'alpha',
    docPath: '/w/proj/.claude/skills/alpha/SKILL.md',
    expanded: false,
    focused: false,
    selected: false,
    archivedChildren: [],
    onFocus: vi.fn(),
    onMove: vi.fn(),
    onToggleExpanded: vi.fn(),
    onContentChange: vi.fn(),
    onResize: vi.fn(),
    cameraRef: { current: { x: 0, y: 0, z: 1 } as Camera },
    ...overrides
  }
}

beforeEach(() => {
  installFakeBridge(globalThis as never)
  useNodeStore.setState({ nodes: {} })
})
afterEach(cleanup)

describe('the collapsed face', () => {
  it('shows the skill’s name and description from its frontmatter', () => {
    render(
      <MetaDocCard
        {...props({
          content: '---\nname: cartesia-fixup\ndescription: Use when TTS mispronounced something.\n---\n# Body'
        })}
      />
    )
    expect(screen.getByText('cartesia-fixup')).toBeTruthy()
    expect(screen.getByText(/Use when TTS mispronounced something/)).toBeTruthy()
  })

  it('falls back to the directory name when the header omits `name`', () => {
    // Three of the six skills on this machine do exactly this — Claude Code
    // takes the name from the directory — so this is the common case, not an
    // edge case.
    render(
      <MetaDocCard {...props({ docKey: 'recall', content: '---\ndescription: Search back.\n---\nbody' })} />
    )
    expect(screen.getByText('recall')).toBeTruthy()
    expect(screen.getByText('Search back.')).toBeTruthy()
  })

  it('captions a CLAUDE.md from its heading and lead paragraph', () => {
    render(
      <MetaDocCard
        {...props({
          docKind: 'doc',
          docKey: 'CLAUDE.md',
          docPath: '/w/proj/CLAUDE.md',
          content: '# Spaceterm\n\nA canvas for terminals.\n\n## More\n\nDetail.'
        })}
      />
    )
    expect(screen.getByText('Spaceterm')).toBeTruthy()
    expect(screen.getByText('A canvas for terminals.')).toBeTruthy()
  })

  it('marks a plain document apart from a skill, since they share a column', () => {
    const { container } = render(render0('doc'))
    expect(container.querySelector('.meta-doc-card__badge')?.textContent).toBe('doc')
    cleanup()
    const { container: skill } = render(render0('skill'))
    expect(skill.querySelector('.meta-doc-card__badge')).toBeNull()
  })

  it('renders before any content has arrived', () => {
    // Content streams in after the node does, so the first paint always has
    // an empty string. It must show the key rather than nothing.
    render(<MetaDocCard {...props({ content: '' })} />)
    expect(screen.getByText('alpha')).toBeTruthy()
  })

  it('reports the height it measured, at the fixed card width', () => {
    const onResize = vi.fn()
    render(<MetaDocCard {...props({ height: 1, onResize, content: '---\nname: a\ndescription: d\n---\n' })} />)
    expect(onResize).toHaveBeenCalled()
    const [, width] = onResize.mock.calls[0]
    expect(width).toBe(600)
  })
})

function render0(docKind: 'skill' | 'doc') {
  return (
    <MetaDocCard
      {...props({
        docKind,
        docKey: docKind === 'doc' ? 'CLAUDE.md' : 'alpha',
        content: '---\nname: thing\ndescription: d\n---\n'
      })}
    />
  )
}

describe('opening and closing', () => {
  it('asks to expand when clicked', () => {
    const onToggleExpanded = vi.fn()
    const { container } = render(<MetaDocCard {...props({ focused: true, onToggleExpanded })} />)
    const card = container.querySelector('.meta-doc-card')!
    fireEvent.mouseDown(card)
    fireEvent.mouseUp(window)
    expect(onToggleExpanded).toHaveBeenCalledWith(nid('meta:host:doc:alpha'))
  })

  it('focuses first when it was not focused, so one click does both', () => {
    const onFocus = vi.fn()
    const onToggleExpanded = vi.fn()
    const { container } = render(<MetaDocCard {...props({ focused: false, onFocus, onToggleExpanded })} />)
    fireEvent.mouseDown(container.querySelector('.meta-doc-card')!)
    fireEvent.mouseUp(window)
    expect(onFocus).toHaveBeenCalled()
    expect(onToggleExpanded).toHaveBeenCalled()
  })

  it('swaps the caption for an editor when expanded', () => {
    const { container } = render(<MetaDocCard {...props({ expanded: true, content: '# Hello' })} />)
    expect(container.querySelector('.meta-doc-card__editor')).not.toBeNull()
    expect(container.querySelector('.meta-doc-card__summary')).toBeNull()
  })
})

describe('what it refuses to be', () => {
  it('offers no close button — it is a view of a file, not a card you own', () => {
    const { container } = render(<MetaDocCard {...props({ focused: true })} />)
    expect(container.querySelector('.node-titlebar__close')).toBeNull()
  })

  it('offers no add-child button, so nothing real can be orphaned by a reap', () => {
    const { container } = render(<MetaDocCard {...props({ focused: true })} />)
    expect(container.querySelector('.node-titlebar__add-btn')).toBeNull()
  })

  it('offers no colour picker, since there is nowhere to keep a colour', () => {
    const { container } = render(<MetaDocCard {...props({ focused: true })} />)
    expect(container.querySelector('.node-titlebar__color-btn')).toBeNull()
  })
})

describe('the canvas conventions every card shares', () => {
  it('treats x and y as its centre', () => {
    const { container } = render(<MetaDocCard {...props({ x: 1000, y: 2000, width: 600, height: 96 })} />)
    const shell = container.firstElementChild as HTMLElement
    expect(Number.parseFloat(shell.style.left)).toBeCloseTo(1000 - 600 / 2, 1)
    expect(Number.parseFloat(shell.style.top)).toBeCloseTo(2000 - 96 / 2, 1)
  })

  it('applies its z-index and tags the shell with its node id', () => {
    const { container } = render(<MetaDocCard {...props({ zIndex: 42 })} />)
    const shell = container.firstElementChild as HTMLElement
    expect(shell.style.zIndex).toBe('42')
    expect(shell.getAttribute('data-node-id')).toBe('meta:host:doc:alpha')
  })

  it('renders for a node the store has never heard of', () => {
    // The ordinary case on first sync: the card paints before its node lands.
    expect(() => render(<MetaDocCard {...props({ id: nid('unknown') })} />)).not.toThrow()
  })

  it('does not touch the bridge just by rendering', () => {
    const bridge = installFakeBridge(globalThis as never)
    render(<MetaDocCard {...props()} />)
    expect(bridge.calls.filter((c) => c.method.startsWith('node.'))).toEqual([])
  })
})
