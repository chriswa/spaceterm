import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, fireEvent, act } from '@testing-library/react'
import { installFakeBridge, type FakeBridge } from '../testing/fake-bridge'
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

let bridge: FakeBridge

beforeEach(() => {
  bridge = installFakeBridge(globalThis as never)
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
    expect(tips).toEqual(['on wip, not the default branch main', 'untracked files — click to open in GitHub Desktop'])
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

function click(el: Element): void {
  fireEvent.mouseDown(el, { clientX: 0, clientY: 0 })
  fireEvent(window, new MouseEvent('mouseup'))
}

function badgeOf(container: HTMLElement, label: string): Element {
  return container.querySelector(`.directory-card__badge[aria-label="${label}"]`)!
}

describe('clicking a badge', () => {
  it('pulls when the badge is the one for commits to pull', () => {
    const { container } = render(<DirectoryCard {...props(status({ behind: true }))} />)
    click(badgeOf(container, 'commits to pull'))
    expect(bridge.lastCall('node.directoryGitRun')).toEqual([asNodeId('dir1'), 'pull'])
  })

  it('pushes when the badge is the one for commits to push', () => {
    const { container } = render(<DirectoryCard {...props(status({ ahead: true }))} />)
    click(badgeOf(container, 'commits to push'))
    expect(bridge.lastCall('node.directoryGitRun')).toEqual([asNodeId('dir1'), 'push'])
  })

  it.each(['uncommitted changes', 'untracked files'])('opens GitHub Desktop from %s', (label) => {
    const { container } = render(<DirectoryCard {...props(status({ dirty: true, untracked: true }))} />)
    click(badgeOf(container, label))
    expect(bridge.callsTo('node.directoryOpenGitHubDesktop')).toHaveLength(1)
  })

  it('does nothing for a badge without an action, not even focus the node', () => {
    const onFocus = vi.fn()
    const { container } = render(
      <DirectoryCard {...props(status({ branch: 'wip', upstream: 'origin/wip' }))} onFocus={onFocus} />
    )
    for (const badge of container.querySelectorAll('.directory-card__badge')) click(badge)
    expect(onFocus).not.toHaveBeenCalled()
    expect(bridge.calls.filter(c => c.method.startsWith('node.directory'))).toHaveLength(0)
  })

  it('sparks while the pull runs and ignores clicks until it finishes', async () => {
    let finish!: (r: { ok: boolean }) => void
    vi.spyOn(bridge.node, 'directoryGitRun').mockReturnValue(new Promise(r => { finish = r }))
    const { container } = render(<DirectoryCard {...props(status({ behind: true }))} />)
    const badge = badgeOf(container, 'commits to pull')
    click(badge)
    expect(badge.classList).toContain('directory-card__badge--running')
    expect(badge.querySelector('.directory-card__badge-spark')).not.toBeNull()
    click(badge)
    expect(bridge.node.directoryGitRun).toHaveBeenCalledTimes(1)
    await act(async () => finish({ ok: true }))
    expect(badge.classList).not.toContain('directory-card__badge--running')
  })

  it('flashes red for a second when the pull fails, and says so in the tooltip', async () => {
    vi.useFakeTimers()
    try {
      bridge.responses.command = { ok: false, error: 'see its terminal' }
      const { container } = render(<DirectoryCard {...props(status({ behind: true }))} />)
      const badge = badgeOf(container, 'commits to pull')
      await act(async () => click(badge))
      expect(badge.classList).toContain('directory-card__badge--failed')
      expect(badge.getAttribute('data-tooltip')).toContain('pull failed: see its terminal')
      act(() => { vi.advanceTimersByTime(1000) })
      expect(badge.classList).not.toContain('directory-card__badge--failed')
      expect(badge.getAttribute('data-tooltip')).toContain('pull failed: see its terminal')
    } finally {
      vi.useRealTimers()
    }
  })
})
