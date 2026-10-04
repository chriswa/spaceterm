import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup, screen, act } from '@testing-library/react'
import { installFakeBridge } from '@/testing/fake-bridge'
import type { SystemStatsSnapshot } from '../shared/system-stats'
import { SystemStatsReadout } from './SystemStatsReadout'

afterEach(cleanup)

const SNAPSHOT: SystemStatsSnapshot = {
  spacing: 2.5,
  widgets: [
    { kind: 'bars', module: 'CPU', width: 5, height: 18, box: true, label: 'CPU', bars: [[{ value: 0.41, color: '#007aff' }]] },
    { kind: 'battery', module: 'Battery', width: 26, height: 14, level: 0.57, fill: '#30d158', track: '#13541f', textOnFill: '#000000', textOnTrack: '#ffffff', charger: 'none' }
  ]
}

describe('SystemStatsReadout', () => {
  it('draws nothing until mini-stats is heard from, then each module, and goes when it stops', () => {
    const bridge = installFakeBridge()
    const { container } = render(<SystemStatsReadout />)
    expect(container.innerHTML).toBe('')

    act(() => bridge.emit.systemStats(SNAPSHOT))
    const readout = screen.getByRole('img')
    expect(readout.getAttribute('aria-label')).toBe('CPU 41%, Battery 57%')
    // The battery's percentage sits inside it, once over the track and once over the fill.
    expect([...readout.querySelectorAll('text')].filter((t) => t.textContent === '57')).toHaveLength(2)

    act(() => bridge.emit.systemStats(null))
    expect(container.innerHTML).toBe('')
  })

})
