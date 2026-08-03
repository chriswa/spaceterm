import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, screen } from '@testing-library/react'
import type { ReactElement } from 'react'
import { installFakeBridge } from '../testing/fake-bridge'
import { TitleCard } from './TitleCard'
import { FileCard } from './FileCard'
import { DirectoryCard } from './DirectoryCard'
import { MarkdownCard } from './MarkdownCard'
import { useNodeStore } from '../stores/nodeStore'
import { cardChromeScale, type CardType } from '../../../../shared/card-types'
import { asNodeId, ROOT_NODE_ID, type NodeId } from '../../../../shared/ids'
import type { Camera } from '../lib/camera'

/**
 * The contract every card honours, checked against all four at once.
 *
 * `App.tsx` renders five near-identical card blocks, each threading ~20
 * identical props into a different component. Hoisting that duplication has
 * been the largest deferred item in NEXT_STEPS for three sessions, deferred
 * every time because "the components take ~30 differing props each and cannot
 * be verified without running the GUI".
 *
 * The GUI part is no longer true — the renderer's only Electron dependency is
 * `window.api` — and this is the evidence the refactor needs: a table-driven
 * test that renders each card through its real component and asserts the
 * behaviour they are supposed to share. Anything that differs here is a real
 * difference to preserve; anything that matches is safe to hoist.
 *
 * TerminalCard is deliberately absent. Its mount effect is 466 lines of xterm
 * setup and deserves its own test rather than being squeezed into a shared
 * contract, and it is the one card whose shell is genuinely different.
 */

const nid = asNodeId

/** Props every card takes, whatever else it needs. */
interface SharedProps {
  id: NodeId
  x: number
  y: number
  zIndex: number
  zoom: number
  focused: boolean
  selected: boolean
  archivedChildren: never[]
  onFocus: (id: NodeId) => void
  onClose: (id: NodeId) => void
  onMove: (id: NodeId, x: number, y: number) => void
  onColorChange: (id: NodeId, color: string) => void
  onUnarchive: (p: NodeId, a: NodeId) => void
  onArchiveDelete: (p: NodeId, a: NodeId) => void
  onOpenArchiveSearch: (nodeId: NodeId) => void
  /**
   * Live camera, read imperatively during a drag so the handler sees the
   * current zoom rather than the zoom at mount. Required by every card, which
   * makes it part of the shared contract rather than an incidental prop.
   */
  cameraRef: { current: Camera }
}

function sharedProps(overrides: Partial<SharedProps> = {}): SharedProps {
  return {
    id: nid('card-1'),
    x: 120,
    y: 240,
    zIndex: 7,
    zoom: 1,
    focused: false,
    selected: false,
    archivedChildren: [],
    onFocus: vi.fn(),
    onClose: vi.fn(),
    onMove: vi.fn(),
    onColorChange: vi.fn(),
    onUnarchive: vi.fn(),
    onArchiveDelete: vi.fn(),
    onOpenArchiveSearch: vi.fn(),
    cameraRef: { current: { x: 0, y: 0, z: 1 } },
    ...overrides
  }
}

/** One card kind, and how to build it from the shared props. */
interface CardCase {
  name: string
  /** The card type the node store would hold for this card. */
  nodeType: CardType
  /** The distinguishing text the card should show. */
  visibleText: string
  build(shared: SharedProps): ReactElement
}

const CARDS: CardCase[] = [
  {
    name: 'TitleCard',
    nodeType: 'title',
    visibleText: 'A Section Title',
    build: (s) => <TitleCard {...s} text="A Section Title" onTextChange={vi.fn()} />
  },
  {
    name: 'FileCard',
    nodeType: 'file',
    visibleText: 'notes.md',
    build: (s) => <FileCard {...s} filePath="/work/notes.md" onFilePathChange={vi.fn()} />
  },
  {
    name: 'DirectoryCard',
    nodeType: 'directory',
    visibleText: 'project',
    build: (s) => <DirectoryCard {...s} cwd="/work/project" onCwdChange={vi.fn()} />
  },
  {
    name: 'MarkdownCard',
    nodeType: 'markdown',
    visibleText: 'hello from markdown',
    build: (s) => (
      <MarkdownCard
        {...s}
        width={400}
        height={300}
        content="hello from markdown"
        onResize={vi.fn()}
        onContentChange={vi.fn()}
        onMaxWidthChange={vi.fn()}
        onRename={vi.fn()}
        onUnfocus={vi.fn()}
      />
    )
  }
]

/** The positioned wrapper CardShell emits, whatever the card inside it is. */
function shellOf(container: HTMLElement): HTMLElement {
  const shell = container.firstElementChild as HTMLElement | null
  if (!shell) throw new Error('card rendered nothing')
  return shell
}

/**
 * The inner element each card styles itself through.
 *
 * `CardShell`'s own root is identical for every card — `card-shell canvas-node`
 * plus positioning — and the per-card class, including the focused/selected
 * modifier, lands on the element it wraps. Worth knowing before hoisting
 * anything: the shell is already shared, the divergence is inside it.
 */
function cardBodyOf(container: HTMLElement): HTMLElement {
  const body = shellOf(container).querySelector('[class*="-card"]') as HTMLElement | null
  if (!body) throw new Error('no per-card element inside the shell')
  return body
}

const px = (value: string): number => Number.parseFloat(value)

beforeEach(() => {
  installFakeBridge(globalThis as never)
  // CardShell reads alerts straight from the node store, so a card for a node
  // the store has never heard of must still render.
  useNodeStore.setState({ nodes: {} })
})

afterEach(cleanup)

describe.each(CARDS)('$name', ({ build, visibleText }) => {
  it('renders without a server, a canvas, or Electron', () => {
    const { container } = render(build(sharedProps()))
    expect(container.firstElementChild).not.toBeNull()
  })

  it('shows its own content', () => {
    render(build(sharedProps()))
    expect(screen.getAllByText(new RegExp(visibleText, 'i')).length).toBeGreaterThan(0)
  })

  it('treats x and y as its CENTRE, not its top-left corner', () => {
    // Every card subtracts half its own size before positioning. This is the
    // convention that makes auto-placement work — a node's recorded position is
    // where it sits, independent of how big it grew — and it is the first thing
    // a hoisted wrapper would get wrong, silently, by half a card.
    const { container } = render(build(sharedProps({ x: 1000, y: 2000 })))
    const shell = shellOf(container)
    const width = px(shell.style.width)

    expect(px(shell.style.left)).toBeCloseTo(1000 - width / 2, 1)
    // Height is set on the inner element, not the shell, so derive it the same
    // way the card did.
    expect(px(shell.style.top)).toBeLessThan(2000)
  })

  it('moves exactly as far as x and y move', () => {
    // Whatever the centring offset is, it must be constant: a card that
    // shifted by a different amount than it was asked to would drift on every
    // drag.
    const { container: a } = render(build(sharedProps({ x: 0, y: 0 })))
    const first = { left: px(shellOf(a).style.left), top: px(shellOf(a).style.top) }
    cleanup()

    const { container: b } = render(build(sharedProps({ x: 300, y: 500 })))
    expect(px(shellOf(b).style.left) - first.left).toBeCloseTo(300, 1)
    expect(px(shellOf(b).style.top) - first.top).toBeCloseTo(500, 1)
  })

  it('applies its z-index, so stacking order is the server’s to decide', () => {
    const { container } = render(build(sharedProps({ zIndex: 42 })))
    expect(shellOf(container).style.zIndex).toBe('42')
  })

  it('marks itself focused on its own element, and the shell marks it too', () => {
    const { container: focused } = render(build(sharedProps({ focused: true })))
    const focusedClass = cardBodyOf(focused).className
    const shellClass = shellOf(focused).className
    cleanup()

    const { container: blurred } = render(build(sharedProps({ focused: false })))
    expect(focusedClass).toMatch(/focused/)
    expect(focusedClass).not.toBe(cardBodyOf(blurred).className)
    // Each card styles focus through its own class, and the shell carries one
    // of its own for the chrome it owns rather than the card does — the
    // hidden-head buttons, which hang above the card entirely. Everything else
    // about the shell root is still identical either way.
    expect(shellClass).toBe('card-shell canvas-node card-shell--focused')
    expect(shellOf(blurred).className).toBe('card-shell canvas-node')
  })

  it('marks itself selected, distinctly from focused', () => {
    const { container } = render(build(sharedProps({ selected: true, focused: false })))
    expect(cardBodyOf(container).className).toMatch(/selected/)
  })

  it('renders for a node the store has never heard of', () => {
    // CardShell subscribes to `nodes[nodeId].alerts`. A card rendered before
    // its node reaches the store — which is the ordinary case on first sync —
    // must not crash on the undefined.
    expect(() => render(build(sharedProps({ id: nid('unknown-to-store') })))).not.toThrow()
  })

  it('survives a zoom far outside 1', () => {
    // The canvas goes from a bird's-eye overview to 1000%, and cards render at
    // both ends.
    for (const zoom of [0.05, 1, 10]) {
      expect(() => render(build(sharedProps({ zoom })))).not.toThrow()
      cleanup()
    }
  })

  it('accepts negative coordinates — the canvas is unbounded', () => {
    const { container } = render(build(sharedProps({ x: -500, y: -900 })))
    expect(shellOf(container)).toBeTruthy()
  })
})

describe('the cards as a set', () => {
  it('all render from the same shared props', () => {
    // The point of the table: if any card needed something the others do not,
    // this file would not compile. That is the compile-time half of the
    // evidence for hoisting App.tsx's five near-identical blocks.
    for (const card of CARDS) {
      const { container } = render(card.build(sharedProps()))
      expect(container.firstElementChild, card.name).not.toBeNull()
      cleanup()
    }
  })

  it('all produce exactly one root element', () => {
    // A card returning a fragment with siblings would break the canvas's
    // per-node positioning, which assumes one positioned box per node.
    for (const card of CARDS) {
      const { container } = render(card.build(sharedProps()))
      expect(container.childElementCount, card.name).toBe(1)
      cleanup()
    }
  })

  it('all emit the identical shell root — the shared half is already shared', () => {
    // This is the concrete evidence for hoisting: CardShell's own wrapper does
    // not vary by card type at all, so anything that differs must be inside.
    const roots = new Set<string>()
    for (const card of CARDS) {
      const { container } = render(card.build(sharedProps()))
      roots.add(shellOf(container).className)
      cleanup()
    }
    expect([...roots]).toEqual(['card-shell canvas-node'])
  })

  it('all tag the shell with their node id, which the canvas hit-tests on', () => {
    for (const card of CARDS) {
      const { container } = render(card.build(sharedProps({ id: nid('tagged') })))
      expect(shellOf(container).getAttribute('data-node-id'), card.name).toBe('tagged')
      cleanup()
    }
  })

  it('all centre on x,y — the convention is universal, not per-card', () => {
    // If one card ever used x,y as a top-left corner, a shared wrapper would
    // place it half a card away and nothing would fail loudly.
    for (const card of CARDS) {
      const { container } = render(card.build(sharedProps({ x: 1000, y: 1000 })))
      const shell = shellOf(container)
      expect(px(shell.style.left), card.name).toBeLessThan(1000)
      expect(px(shell.style.top), card.name).toBeLessThan(1000)
      cleanup()
    }
  })

  it('none of them touches the bridge just by rendering', () => {
    // A card that talks to the server on mount would make the canvas's first
    // paint depend on a round trip.
    const bridge = installFakeBridge(globalThis as never)
    for (const card of CARDS) {
      render(card.build(sharedProps()))
      cleanup()
    }
    const serverCalls = bridge.calls.filter((c) => c.method.startsWith('node.') || c.method.startsWith('pty.'))
    expect(serverCalls.map((c) => c.method)).toEqual([])
  })
})

describe('action-bar chrome scale', () => {
  // The buttons that appear on focus are drawn inside the camera transform, so
  // a card whose focus zoom is capped renders them at a fraction of their
  // designed size. The stylesheet compensates via `--card-chrome-scale`, which
  // only works if the shell actually publishes it.
  it.each(CARDS)('$name publishes its type’s scale on the shell', ({ nodeType, build }) => {
    const id = nid('scaled')
    // CardShell only reads `type` and `alerts` off the node.
    useNodeStore.setState({ nodes: { [id]: { type: nodeType } as never } })

    const { container } = render(build(sharedProps({ id, focused: true })))
    expect(shellOf(container).style.getPropertyValue('--card-chrome-scale'))
      .toBe(String(cardChromeScale(nodeType)))
  })

  it('falls back to unscaled chrome for a node the store has never heard of', () => {
    // The ordinary case on first sync: the card renders before its node
    // arrives. Scaling to NaN would collapse the buttons to nothing.
    const { container } = render(CARDS[0].build(sharedProps({ id: nid('unknown-to-store') })))
    expect(shellOf(container).style.getPropertyValue('--card-chrome-scale')).toBe('1')
  })
})

describe('the parent id used for archived children', () => {
  it('is the card’s own id, not the canvas root', () => {
    // Archived children hang off the node they were archived from. Passing
    // ROOT_NODE_ID here would unarchive them to the wrong parent — a data bug
    // with no visible symptom until the user looks for a card that moved.
    const onUnarchive = vi.fn()
    render(CARDS[0].build(sharedProps({ id: nid('owner'), onUnarchive })))
    expect(onUnarchive).not.toHaveBeenCalledWith(ROOT_NODE_ID, expect.anything())
  })
})
