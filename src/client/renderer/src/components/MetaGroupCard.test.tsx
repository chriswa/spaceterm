import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, fireEvent } from '@testing-library/react'
import { installFakeBridge } from '../testing/fake-bridge'
import { MetaGroupCard } from './MetaGroupCard'
import { useNodeStore } from '../stores/nodeStore'
import { asNodeId } from '../../../../shared/ids'
import type { Camera } from '../lib/camera'

/**
 * The branch header. It looks like a title card and is deliberately not one:
 * everything a title card lets you do to it — rename, recolour, close — would
 * be a lie here, because what it shows comes from the filesystem.
 */

const nid = asNodeId

function props(overrides: Partial<Parameters<typeof MetaGroupCard>[0]> = {}) {
  return {
    id: nid('meta:host'),
    x: 0,
    y: 0,
    zIndex: 5,
    zoom: 1,
    label: 'Agent Meta',
    sourcePath: '/w/proj',
    focused: false,
    selected: false,
    archivedChildren: [],
    onFocus: vi.fn(),
    onMove: vi.fn(),
    onRescan: vi.fn(),
    cameraRef: { current: { x: 0, y: 0, z: 1 } as Camera },
    ...overrides
  }
}

beforeEach(() => {
  installFakeBridge(globalThis as never)
  useNodeStore.setState({ nodes: {} })
})
afterEach(cleanup)

describe('what it shows', () => {
  it('renders the label the server derived', () => {
    // Queried by class rather than by text: the hidden span the card measures
    // itself with holds the same string, so a bare getByText is ambiguous.
    const { container } = render(<MetaGroupCard {...props({ label: 'Skills · 4' })} />)
    expect(container.querySelector('.meta-group-card__label')?.textContent).toBe('Skills · 4')
  })

  it('names the path it summarises, so the card can say where it came from', () => {
    const { container } = render(<MetaGroupCard {...props({ sourcePath: '/w/proj/.claude/skills' })} />)
    expect(container.querySelector('.meta-group-card__body')?.getAttribute('title'))
      .toContain('/w/proj/.claude/skills')
  })
})

describe('clicking it', () => {
  it('rescans when focused — the affordance the watcher cannot cover', () => {
    const onRescan = vi.fn()
    const { container } = render(<MetaGroupCard {...props({ focused: true, onRescan })} />)
    fireEvent.mouseDown(container.querySelector('.meta-group-card')!)
    fireEvent.mouseUp(window)
    expect(onRescan).toHaveBeenCalledWith(nid('meta:host'))
  })

  it('focuses first when it was not focused, rather than rescanning blind', () => {
    const onFocus = vi.fn()
    const onRescan = vi.fn()
    const { container } = render(<MetaGroupCard {...props({ focused: false, onFocus, onRescan })} />)
    fireEvent.mouseDown(container.querySelector('.meta-group-card')!)
    fireEvent.mouseUp(window)
    expect(onFocus).toHaveBeenCalled()
    expect(onRescan).not.toHaveBeenCalled()
  })

  it('moves rather than rescanning once the pointer has travelled', () => {
    const onMove = vi.fn()
    const onRescan = vi.fn()
    const { container } = render(<MetaGroupCard {...props({ focused: true, onMove, onRescan })} />)
    fireEvent.mouseDown(container.querySelector('.meta-group-card')!, { clientX: 0, clientY: 0 })
    fireEvent.mouseMove(window, { clientX: 80, clientY: 40 })
    fireEvent.mouseUp(window)
    expect(onMove).toHaveBeenCalled()
    expect(onRescan).not.toHaveBeenCalled()
  })
})

describe('what it refuses to be', () => {
  it('cannot be closed', () => {
    const { container } = render(<MetaGroupCard {...props({ focused: true })} />)
    expect(container.querySelector('.node-titlebar__close')).toBeNull()
  })

  it('cannot be recoloured', () => {
    const { container } = render(<MetaGroupCard {...props({ focused: true })} />)
    expect(container.querySelector('.node-titlebar__color-btn')).toBeNull()
  })

  it('cannot be given children', () => {
    const { container } = render(<MetaGroupCard {...props({ focused: true })} />)
    expect(container.querySelector('.node-titlebar__add-btn')).toBeNull()
  })

  it('has no editable text — its label comes from the filesystem', () => {
    const { container } = render(<MetaGroupCard {...props({ focused: true })} />)
    expect(container.querySelector('input')).toBeNull()
    expect(container.querySelector('textarea')).toBeNull()
  })
})

describe('the canvas conventions every card shares', () => {
  it('treats x and y as its centre', () => {
    const { container } = render(<MetaGroupCard {...props({ x: 1000, y: 2000 })} />)
    const shell = container.firstElementChild as HTMLElement
    const width = Number.parseFloat(shell.style.width)
    expect(Number.parseFloat(shell.style.left)).toBeCloseTo(1000 - width / 2, 1)
    expect(Number.parseFloat(shell.style.top)).toBeLessThan(2000)
  })

  it('applies its z-index and tags the shell with its node id', () => {
    const { container } = render(<MetaGroupCard {...props({ zIndex: 77 })} />)
    const shell = container.firstElementChild as HTMLElement
    expect(shell.style.zIndex).toBe('77')
    expect(shell.getAttribute('data-node-id')).toBe('meta:host')
  })

  it('does not touch the bridge just by rendering', () => {
    const bridge = installFakeBridge(globalThis as never)
    render(<MetaGroupCard {...props()} />)
    expect(bridge.calls.filter((c) => c.method.startsWith('node.'))).toEqual([])
  })
})
