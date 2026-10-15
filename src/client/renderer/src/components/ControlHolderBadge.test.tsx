import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup, screen, act } from '@testing-library/react'
import { ControlHolderBadge, DEBUG_SHOW_BOTH_HOLDER_BADGES, holderBadgeText } from './ControlHolderBadge'
import { useReceptionistStore } from '../stores/receptionistStore'

afterEach(cleanup)

describe('holderBadgeText', () => {
  it('says nothing while this device holds Control, silent or aloud', () => {
    expect(holderBadgeText({ label: 'Mac', mine: true, muted: false })).toBeNull()
    expect(holderBadgeText({ label: 'Mac', mine: true, muted: true })).toBeNull()
  })

  it('names the other device when Control is held there', () => {
    expect(holderBadgeText({ label: 'Phone', mine: false, muted: false })).toContain('Phone')
  })

  it("says Control can't reach the user when no device holds it", () => {
    expect(holderBadgeText(null)).toMatch(/can't reach you/)
  })
})

describe('ControlHolderBadge', () => {
  // DEBUG(holder-badge): remove the skipIf with the flag.
  it.skipIf(DEBUG_SHOW_BOTH_HOLDER_BADGES)('follows the holder as the server moves Control', () => {
    act(() => useReceptionistStore.getState().setHolder({ deviceId: 'desktop', label: 'Mac' }, 'desktop'))
    render(<ControlHolderBadge />)
    expect(screen.queryByRole('status')).toBeNull()
    act(() => useReceptionistStore.getState().setHolder({ deviceId: 'phone-1', label: 'Phone' }, 'desktop'))
    expect(screen.getByRole('status').textContent).toBe('Control is active on Phone')
    act(() => useReceptionistStore.getState().setHolder(null, 'desktop'))
    expect(screen.getByRole('status').textContent).toMatch(/can't reach you/)
  })
})
