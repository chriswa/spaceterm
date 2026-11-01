import { describe, it, expect } from 'vitest'
import { MobileAppInstaller, failureMessage } from './mobile-install'

describe('MobileAppInstaller', () => {
  it('runs one install for requests that arrive while it is going', async () => {
    let runs = 0
    let finish: (r: { code: number; output: string }) => void = () => undefined
    const installer = new MobileAppInstaller({
      downloadDir: '/download',
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
      downloadDir: '/download',
      run: async () => ({ code: 1, output: 'Building for iPhone…\nerror: signing failed\nBuild or signing failed; see the errors above.\n' }),
    })
    const outcome = await installer.install()
    expect(outcome.ok).toBe(false)
    expect(!outcome.ok && outcome.message).toContain('signing failed')
  })
})

describe('MobileAppInstaller, for a phone away from the Mac', () => {
  const MANIFEST = 'https://mac.example.ts.net/install/SECRET/manifest.plist'

  /** A script whose phone is out of reach, and whose download builds as `download` says. */
  function awayInstaller(download: { code: number; output: string } | ((secret: string) => { code: number; output: string })) {
    const calls: string[][] = []
    const stages: string[] = []
    const installer = new MobileAppInstaller({
      downloadDir: '/download',
      run: async (args) => {
        calls.push(args)
        if (args[0] !== '--over-the-air') return { code: 2, output: "Chris's iPhone isn't reachable from this Mac.\n" }
        return typeof download === 'function' ? download(args[1]) : download
      },
    }, (stage) => stages.push(stage))
    return { installer, calls, stages }
  }

  it('tells what the phone fetches: the dialog is up, then Install was pressed — once each a download', async () => {
    const secrets: string[] = []
    const { installer, stages } = awayInstaller((s) => {
      secrets.push(s)
      return { code: 0, output: MANIFEST.replace('SECRET', s) }
    })
    await installer.install()
    const fetch = (file: string) => installer.downloadFile(`/install/${secrets.at(-1)}/${file}`)
    fetch('manifest.plist')
    expect(stages).toEqual(['asking'])
    fetch('icon.png')
    fetch('SpacetermMobile.ipa')
    fetch('SpacetermMobile.ipa')
    fetch('manifest.plist')
    expect(stages).toEqual(['asking', 'installing'])
    // A guess at the path is no stage.
    installer.downloadFile('/install/wrong/SpacetermMobile.ipa')
    expect(stages).toEqual(['asking', 'installing'])

    // The next download starts over.
    await installer.install()
    fetch('manifest.plist')
    expect(stages).toEqual(['asking', 'installing', 'asking'])
  })

  it('builds a download and answers with the link that installs it', async () => {
    let secret = ''
    const { installer, calls } = awayInstaller((s) => {
      secret = s
      return { code: 0, output: `Building a download of the app…\n${MANIFEST.replace('SECRET', s)}\n` }
    })
    const outcome = await installer.install()
    expect(calls.map((c) => c[0])).toEqual([undefined, '--over-the-air'])
    expect(outcome.ok).toBe(false)
    expect('installUrl' in outcome && outcome.installUrl).toBe(
      `itms-services://?action=download-manifest&url=${encodeURIComponent(MANIFEST.replace('SECRET', secret))}`,
    )
  })

  it('serves the download only under its own secret', async () => {
    let secret = ''
    const { installer } = awayInstaller((s) => {
      secret = s
      return { code: 0, output: MANIFEST.replace('SECRET', s) }
    })
    expect(installer.downloadFile('/install/anything/manifest.plist')).toBeNull()
    await installer.install()
    expect(installer.downloadFile(`/install/${secret}/manifest.plist`)).toBe('/download/manifest.plist')
    expect(installer.downloadFile(`/install/${secret}/SpacetermMobile.ipa`)).toBe('/download/SpacetermMobile.ipa')
    expect(installer.downloadFile(`/install/${secret}/export.plist`)).toBeNull()
    expect(installer.downloadFile(`/install/${secret}/../web-token`)).toBeNull()
    expect(installer.downloadFile('/install/wrong/manifest.plist')).toBeNull()
  })

  it('a new build retires the old secret', async () => {
    const secrets: string[] = []
    const { installer } = awayInstaller((s) => {
      secrets.push(s)
      return { code: 0, output: MANIFEST.replace('SECRET', s) }
    })
    await installer.install()
    await installer.install()
    expect(secrets[0]).not.toBe(secrets[1])
    expect(installer.downloadFile(`/install/${secrets[0]}/manifest.plist`)).toBeNull()
    expect(installer.downloadFile(`/install/${secrets[1]}/manifest.plist`)).not.toBeNull()
  })

  it('a download that fails to build is a failure, and nothing is served', async () => {
    const { installer } = awayInstaller({ code: 1, output: 'Exporting the app failed; see the errors above.\n' })
    const outcome = await installer.install()
    expect(outcome).toEqual({ ok: false, message: 'Exporting the app failed; see the errors above.' })
    expect(installer.downloadFile('/install/x/manifest.plist')).toBeNull()
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
