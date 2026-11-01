import { describe, expect, it } from 'vitest'
import { NOTHING_PENDING, parseStatus, pendingStatus, STATUS_HEADING, statusToTell } from './spaceterm-status'

describe('statusToTell', () => {
  it('says nothing while the session already knows', () => {
    expect(statusToTell({ ...NOTHING_PENDING, device: 'Mac' })).toBeUndefined()
    const pending = { restartPending: true, phoneInstallPending: true, reloadPending: false }
    expect(statusToTell({ ...pending, device: 'Phone' }, pending)).toBeUndefined()
  })

  it('frames itself as the system speaking, not the user', () => {
    const told = statusToTell({ restartPending: true, phoneInstallPending: false, reloadPending: false, device: 'Mac' })!
    expect(told.startsWith(`${STATUS_HEADING}, from the Spaceterm system itself, not from the user`)).toBe(true)
    expect(told).toContain('the user did not say this')
    expect(told).toContain('Server restart: pending')
    expect(told).toContain('iPhone app install: not needed.')
    expect(told).toContain('The user is on the Mac.')
  })

  it('asks for news to be told once, and an iPhone install only on the phone', () => {
    const told = statusToTell({ restartPending: false, phoneInstallPending: true, reloadPending: false, device: 'Phone' })!
    expect(told).toContain('iPhone app install: pending')
    expect(told).toContain('Tell the user what has just become pending, once')
    expect(told).toContain('on the Mac, mention it only if they ask')
  })

  it('says what was pending is done, with nothing to tell', () => {
    const told = statusToTell(NOTHING_PENDING, { restartPending: true, phoneInstallPending: true, reloadPending: false })!
    expect(told).toContain('Server restart: not needed any more')
    expect(told).toContain('iPhone app install: not needed any more')
    expect(told).toContain('nothing to tell the user about this unless they ask')
    expect(told).not.toContain('The user is on')
  })

  it('repeats what is still pending to a session that has forgotten, as a reminder', () => {
    const pending = { restartPending: true, phoneInstallPending: false, reloadPending: false }
    expect(statusToTell(pending, pending, true)).toContain('a reminder, not news')
    expect(statusToTell(NOTHING_PENDING, NOTHING_PENDING, true)).toBeUndefined()
  })

  it('tells a page refresh as the smallest, mattering only on the phone, and done when it is', () => {
    const told = statusToTell({ ...NOTHING_PENDING, reloadPending: true, device: 'Phone' })!
    expect(told).toContain('Page refresh: pending')
    expect(told).toContain('An iPhone install or a page refresh matters only while they are using the phone')
    expect(told).toContain('refresh_clients')
    expect(statusToTell(NOTHING_PENDING, { ...NOTHING_PENDING, reloadPending: true })).toContain('Page refresh: not needed any more')
  })

  it('never has Control act on its own, only when the user explicitly asks', () => {
    const told = statusToTell({ restartPending: true, phoneInstallPending: true, reloadPending: false })!
    expect(told).toContain('never restart, install or refresh anything unless the user explicitly asks you to')
    expect(told).toContain('install_phone_app')
  })
})

describe('pendingStatus', () => {
  it('is what each device\'s rocket menu shows, pending if it is for any device', () => {
    expect(pendingStatus(false, [])).toEqual(NOTHING_PENDING)
    expect(pendingStatus(false, [{ native: false, web: true }])).toEqual({ ...NOTHING_PENDING, reloadPending: true })
    // The new app loads the new page, and the restarted server reloads every page.
    expect(pendingStatus(false, [{ native: true, web: true }])).toEqual({ ...NOTHING_PENDING, phoneInstallPending: true })
    expect(pendingStatus(true, [{ native: false, web: true }])).toEqual({ ...NOTHING_PENDING, restartPending: true })
    // One phone's app behind does not stand in for another's page.
    expect(pendingStatus(false, [{ native: true, web: false }, { native: false, web: true }]))
      .toEqual({ restartPending: false, phoneInstallPending: true, reloadPending: true })
  })
})

describe('parseStatus', () => {
  it('reads a status saved before refreshes were told as none told', () => {
    expect(parseStatus({ restartPending: true, phoneInstallPending: false })).toEqual({ restartPending: true, phoneInstallPending: false, reloadPending: false })
    expect(parseStatus({ restartPending: true, phoneInstallPending: false, reloadPending: true })).toEqual({ restartPending: true, phoneInstallPending: false, reloadPending: true })
    expect(parseStatus({ restartPending: true })).toBeUndefined()
    expect(parseStatus({ restartPending: true, phoneInstallPending: false, reloadPending: 'yes' })).toBeUndefined()
  })
})
