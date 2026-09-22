import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, fireEvent } from '@testing-library/react'
import { installFakeBridge } from '../testing/fake-bridge'
import { DirectoryCard } from './DirectoryCard'
import { useNodeStore } from '../stores/nodeStore'
import { asNodeId } from '../../../../shared/ids'
import { COLOR_PRESET_MAP } from '../lib/color-presets'
import type { GitStatus } from '../../../../shared/state'
import type { Camera } from '../lib/camera'

/**
 * The marks under a directory node's folder. They restate what the git status
 * line above them already says, for reading at a distance the text is too small
 * for — so what is asserted here is which marks appear, not how they are drawn.
 */

function status(overrides: Partial<GitStatus> = {}): GitStatus {
  return {
    branch: 'main',
    defaultBranch: 'main',
    upstream: 'origin/main',
    hasRemote: true,
    ahead: false,
    behind: false,
    conflicts: false,
    dirty: false,
    untracked: false,
    lastFetchTimestamp: Date.now(),
    ...overrides
  }
}

function props(gitStatus: GitStatus | null | undefined) {
  return {
    id: asNodeId('dir1'),
    x: 0,
    y: 0,
    zIndex: 5,
    zoom: 1,
    cwd: '~/proj',
    gitStatus,
    focused: false,
    selected: false,
    resolvedPreset: COLOR_PRESET_MAP.blue,
    archivedChildren: [],
    onFocus: vi.fn(),
    onClose: vi.fn(),
    onMove: vi.fn(),
    onCwdChange: vi.fn(),
    onColorChange: vi.fn(),
    onOpenArchiveSearch: vi.fn(),
    cameraRef: { current: { x: 0, y: 0, z: 1 } as Camera },
  }
}

function badgeRow(gitStatus: GitStatus | null | undefined): HTMLElement | null {
  const { container } = render(<DirectoryCard {...props(gitStatus)} />)
  return container.querySelector('.directory-card__badges')
}

function badgeCount(gitStatus: GitStatus): number {
  return badgeRow(gitStatus)?.querySelectorAll('.directory-card__badge').length ?? 0
}

beforeEach(() => {
  installFakeBridge(globalThis as never)
  useNodeStore.setState({ nodes: {} })
})
afterEach(cleanup)

describe('when the row appears at all', () => {
  it('stays away from a clean checkout of the default branch', () => {
    expect(badgeRow(status())).toBeNull()
  })

  it('stays away from a directory that is not a repo', () => {
    expect(badgeRow(null)).toBeNull()
  })

  it('stays away from a directory that has not been polled yet', () => {
    expect(badgeRow(undefined)).toBeNull()
  })
})

describe('what it shows', () => {
  it('draws one badge per thing worth noticing', () => {
    expect(badgeCount(status({ branch: 'wip', upstream: 'origin/wip', behind: true, dirty: true }))).toBe(3)
  })

  it('draws a badge for an off-default branch on its own', () => {
    expect(badgeCount(status({ branch: 'wip', upstream: 'origin/wip' }))).toBe(1)
  })

  it('leaves a local-only repo without a push badge', () => {
    // No remote to push to, so an arrow would never stop being true.
    expect(badgeCount(status({ upstream: null, hasRemote: false, defaultBranch: null }))).toBe(0)
  })
})

describe('how it is drawn', () => {
  it('takes both its colours from the node preset', () => {
    const row = badgeRow(status({ untracked: true }))!
    const style = row.getAttribute('style') ?? ''
    // The folder's own two tones: its face, and the tone its label is drawn in.
    expect(style).toContain('--badge-face')
    expect(style).toContain(`--badge-mark: ${COLOR_PRESET_MAP.blue.terminalBg}`)
  })

  it('gives every badge an instant tooltip', () => {
    // data-tooltip is the app's own tooltip, shown on mouseover with no dwell;
    // the native `title` one waits about a second before it appears.
    const row = badgeRow(status({ branch: 'wip', upstream: 'origin/wip', untracked: true }))!
    const tips = [...row.querySelectorAll('.directory-card__badge')]
      .map(b => b.getAttribute('data-tooltip'))
    expect(tips).toEqual(['on wip, not the default branch main', 'untracked files'])
  })

  it('places those tooltips below, clear of the folder', () => {
    const badge = badgeRow(status({ untracked: true }))!.querySelector('.directory-card__badge')!
    expect(badge.getAttribute('data-tooltip-placement')).toBe('bottom')
  })

  it('drags the node rather than punching a hole in it', () => {
    // The row hangs over open canvas; grabbing a badge has to move the node the
    // way grabbing its folder does.
    const onDragStart = vi.fn()
    const onMove = vi.fn()
    const { container } = render(
      <DirectoryCard {...props(status({ untracked: true }))} onDragStart={onDragStart} onMove={onMove} />
    )
    const badge = container.querySelector('.directory-card__badge')!
    fireEvent.mouseDown(badge, { clientX: 0, clientY: 0 })
    fireEvent(window, new MouseEvent('mousemove', { clientX: 60, clientY: 40 }))
    fireEvent(window, new MouseEvent('mouseup'))
    expect(onDragStart).toHaveBeenCalled()
    expect(onMove).toHaveBeenCalledWith(asNodeId('dir1'), 60, 40, false, false)
  })
})

describe('the status tooltip', () => {
  it('spells out every badge, so the marks have a legend', () => {
    const { container } = render(
      <DirectoryCard {...props(status({ branch: 'wip', upstream: null, behind: true, untracked: true }))} />
    )
    const tooltip = container.querySelector('.directory-card__git-status')?.getAttribute('title') ?? ''
    expect(tooltip).toContain('on wip, not the default branch main')
    expect(tooltip).toContain('commits to pull')
    expect(tooltip).toContain('branch has never been pushed')
    expect(tooltip).toContain('untracked files')
  })
})
