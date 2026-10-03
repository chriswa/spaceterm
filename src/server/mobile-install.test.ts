import { describe, it, expect } from 'vitest'
import { MobileAppInstaller, failureMessage } from './mobile-install'

describe('MobileAppInstaller', () => {
  it('runs one install for requests that arrive while it is going', async () => {
    let runs = 0
    let finish: (r: { code: number; output: string }) => void = () => undefined
    const installer = new MobileAppInstaller({
      run: () => { runs++; return new Promise((resolve) => { finish = resolve }) },
    })
    const first = installer.install()
    const second = installer.install()
    finish({ code: 0, output: 'Spaceterm is running on the iPhone.\n' })
    expect(await first).toEqual({ ok: true })
    expect(await second).toEqual({ ok: true })
    expect(runs).toBe(1)
    // Finished: the next request is a new install.
    void installer.install()
    expect(runs).toBe(2)
  })

  it('a failure carries what the script said last', async () => {
    const installer = new MobileAppInstaller({
      run: async () => ({ code: 1, output: 'Building for iPhone…\nerror: signing failed\nBuild or signing failed; see the errors above.\n' }),
    })
    const outcome = await installer.install()
    expect(outcome.ok).toBe(false)
    expect(!outcome.ok && outcome.message).toContain('signing failed')
  })
})

describe('failureMessage', () => {
  it('skips the rules devicectl draws around its errors', () => {
    const output = [
      'Installing…',
      'ERROR: A connection to this device could not be established. (com.apple.dt.CoreDeviceError error 4000 (0xFA0))',
      '       DeviceIdentifier = D31EE0AE',
      '       ----------------------------------------',
      '           Internal logic error: Connection was invalidated',
      '       ----------------------------------------',
      '',
    ].join('\n')
    expect(failureMessage(output).split('\n')).toEqual([
      'ERROR: A connection to this device could not be established. (com.apple.dt.CoreDeviceError error 4000 (0xFA0))',
      'DeviceIdentifier = D31EE0AE',
      'Internal logic error: Connection was invalidated',
    ])
  })

  it('says something even when the script said nothing', () => {
    expect(failureMessage('\n\n')).toMatch(/without saying why/)
  })
})
