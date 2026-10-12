import { describe, expect, it } from 'vitest'
import { NOTHING_PENDING, STATUS_HEADING, statusToTell } from './spaceterm-status'

describe('statusToTell', () => {
  it('says nothing while the session already knows', () => {
    expect(statusToTell({ ...NOTHING_PENDING, device: 'Mac' })).toBeUndefined()
    const pending = { restartPending: true, phoneInstallPending: true }
    expect(statusToTell({ ...pending, device: 'Phone' }, pending)).toBeUndefined()
  })

  it('frames itself as the system speaking, not the user', () => {
    const told = statusToTell({ restartPending: true, phoneInstallPending: false, device: 'Mac' })!
    expect(told.startsWith(`${STATUS_HEADING}, from the Spaceterm system itself, not from the user`)).toBe(true)
    expect(told).toContain('the user did not say this')
    expect(told).toContain('Server restart: pending')
    expect(told).toContain('iPhone app install: not needed.')
    expect(told).toContain('The user is on the Mac.')
  })

  it('asks for news to be told once, and an iPhone install only on the phone', () => {
    const told = statusToTell({ restartPending: false, phoneInstallPending: true, device: 'Phone' })!
    expect(told).toContain('iPhone app install: pending')
    expect(told).toContain('Tell the user what has just become pending, once')
    expect(told).toContain('on the Mac, mention it only if they ask')
  })

  it('says what was pending is done, with nothing to tell', () => {
    const told = statusToTell(NOTHING_PENDING, { restartPending: true, phoneInstallPending: true })!
    expect(told).toContain('Server restart: not needed any more')
    expect(told).toContain('iPhone app install: not needed any more')
    expect(told).toContain('nothing to tell the user about this unless they ask')
    expect(told).not.toContain('The user is on')
  })

  it('repeats what is still pending to a session that has forgotten, as a reminder', () => {
    const pending = { restartPending: true, phoneInstallPending: false }
    expect(statusToTell(pending, pending, true)).toContain('a reminder, not news')
    expect(statusToTell(NOTHING_PENDING, NOTHING_PENDING, true)).toBeUndefined()
  })
})
