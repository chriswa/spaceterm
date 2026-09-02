import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { RestartButton } from './buttons'
import { useRestartRequiredStore } from '../../stores/restartRequiredStore'

/**
 * The Restart button's only job beyond firing `onRestart` is to surface a
 * pending server restart raised via `npm run flag-restart` — the marching-ants
 * class and the reason in the tooltip. Once a restart is actually in progress
 * the pending cue is redundant and must drop.
 */

afterEach(() => {
  cleanup()
  useRestartRequiredStore.getState().set(false, '')
})

function renderButton(restarting = false) {
  const onRestart = vi.fn()
  const { container } = render(<RestartButton restarting={restarting} onRestart={onRestart} />)
  return container.querySelector('button')!
}

describe('RestartButton', () => {
  it('is plain when no restart is flagged', () => {
    const btn = renderButton()
    expect(btn.className).not.toContain('toolbar__btn--restart-pending')
    expect(btn.getAttribute('data-tooltip')).toBe('Restart Spaceterm server')
  })

  it('marches and shows the reason when a restart is flagged', () => {
    useRestartRequiredStore.getState().set(true, 'CLAUDE.md changed')
    const btn = renderButton()
    expect(btn.className).toContain('toolbar__btn--restart-pending')
    expect(btn.getAttribute('data-tooltip')).toBe('Restart needed — CLAUDE.md changed')
  })

  it('flags a restart with no reason without a dangling dash', () => {
    useRestartRequiredStore.getState().set(true, '')
    const btn = renderButton()
    expect(btn.getAttribute('data-tooltip')).toBe('Restart needed')
  })

  it('drops the pending cue once the restart is in progress', () => {
    useRestartRequiredStore.getState().set(true, 'CLAUDE.md changed')
    const btn = renderButton(true)
    expect(btn.className).not.toContain('toolbar__btn--restart-pending')
    expect(btn.className).toContain('toolbar__btn--active')
    expect(btn.getAttribute('data-tooltip')).toBe('Restarting Spaceterm…')
    expect(btn.disabled).toBe(true)
  })
})
