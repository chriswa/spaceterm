import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup, screen, act, fireEvent, within } from '@testing-library/react'
import { installFakeBridge } from '@/testing/fake-bridge'
import type { SystemStatsSnapshot } from '../shared/system-stats'
import type { UsageSnapshot } from '../shared/usage-report'
import { MacReadouts } from './MacReadouts'

afterEach(cleanup)

const STATS: SystemStatsSnapshot = {
  spacing: 2.5,
  widgets: [
    { kind: 'bars', module: 'Sensors', width: 5, height: 18, box: true, label: 'HOT', bars: [[{ value: 0.65, color: '#ff192f' }]] },
    { kind: 'bars', module: 'CPU', width: 5, height: 18, box: true, label: 'CPU', bars: [[{ value: 0.41, color: '#007aff' }]] },
    { kind: 'battery', module: 'Battery', width: 26, height: 14, level: 0.57, fill: '#30d158', track: '#13541f', textOnFill: '#000000', textOnTrack: '#ffffff', charger: 'none' }
  ]
}

const USAGE: UsageSnapshot = {
  updatedAt: Date.now(),
  bars: [
    { label: 'Claude 5-Hour', palette: 'claude', usage: 0.02, time: 0.081, resetsAt: Date.now() + (4 * 60 + 35) * 60_000 - 1_000, startsGroup: true },
    { label: 'Codex unavailable', palette: 'codex', error: true, usage: 0, time: 0, startsGroup: true }
  ]
}

describe('MacReadouts', () => {
  it('draws nothing until mini-stats is heard from, then each module, and goes when it stops', () => {
    const bridge = installFakeBridge()
    const { container } = render(<MacReadouts />)
    expect(container.innerHTML).toBe('')

    act(() => bridge.emit.systemStats(STATS))
    const readout = screen.getByRole('img')
    expect(readout.getAttribute('aria-label')).toBe('Sensors 65%, CPU 41%, Battery 57%')
    // The battery's percentage sits inside it, once over the track and once over the fill.
    expect([...readout.querySelectorAll('text')].filter((t) => t.textContent === '57')).toHaveLength(2)

    act(() => bridge.emit.systemStats(null))
    expect(container.innerHTML).toBe('')
  })

  it('a tap on the system monitor opens both sets of figures, and another closes them', () => {
    const bridge = installFakeBridge()
    render(<MacReadouts />)
    act(() => {
      bridge.emit.usageReport(USAGE)
      bridge.emit.systemStats(STATS)
    })

    fireEvent.click(screen.getByRole('img'))
    const panel = screen.getByRole('dialog')
    const rows = within(panel).getAllByRole('row').map((r) => [...r.querySelectorAll('td')].map((c) => c.textContent))
    expect(rows).toEqual([
      ['Heat', '65%'],
      ['CPU', '41%'],
      ['Battery', '57%'],
      ['Charging', 'no'],
      [], // the usage table's header
      ['Claude 5-Hour', '2%', '8%', '4h'],
      ['Codex unavailable', '']
    ])

    fireEvent.click(panel)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('a touch anywhere else on the page closes the figures', () => {
    const bridge = installFakeBridge()
    render(<><MacReadouts /><button>rocket</button></>)
    act(() => bridge.emit.systemStats(STATS))

    fireEvent.click(screen.getByRole('img'))
    fireEvent.pointerDown(screen.getByRole('img'))
    expect(screen.getByRole('dialog')).toBeTruthy()

    fireEvent.pointerDown(screen.getByText('rocket'))
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
