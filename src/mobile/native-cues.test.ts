import { describe, it, expect, vi, afterEach } from 'vitest'

async function app() {
  vi.resetModules()
  const posted: Array<{ action: string; name?: string }> = []
  ;(window as unknown as { webkit: unknown }).webkit = { messageHandlers: { nativeMicrophone: { postMessage: (m: { action: string }) => { posted.push(m) } } } }
  delete (window as unknown as { spacetermNativeMicrophone?: unknown }).spacetermNativeMicrophone
  const native = await import('./native-microphone')
  const cues = await import('./cues')
  const opening = native.openNativeMicrophone()
  window.spacetermNativeMicrophone?.state({ running: true, cues: true })
  const mic = await opening
  return { native, cues, mic, posted, report: (s: Parameters<NonNullable<typeof window.spacetermNativeMicrophone>['state']>[0]) => window.spacetermNativeMicrophone?.state(s) }
}

afterEach(() => vi.useRealTimers())

describe('a cue asked for as the app\'s microphone stops', () => {
  it('waits for the stop to finish, rather than being sent to an engine the app is taking down', async () => {
    const { native, cues, mic, posted, report } = await app()
    mic.close()
    expect(native.nativeCues.available()).toBe(false)
    cues.playHeardUnattachedCue()
    expect(posted.filter((m) => m.action === 'cue')).toEqual([])
    // The app stays awake for Control: its engine is up without the microphone, and plays it.
    report({ running: false, awake: true, cues: true })
    expect(posted.filter((m) => m.action === 'cue').map((m) => m.name)).toEqual(['heardUnattached'])
  })

  it('goes to the page when the app is left with no engine at all', async () => {
    const { cues, mic, posted, report } = await app()
    mic.close()
    cues.playHeardUnattachedCue()
    report({ running: false, cues: true })
    expect(posted.filter((m) => m.action === 'cue')).toEqual([])
  })

  it('waits only so long for an app that never says it stopped', async () => {
    vi.useFakeTimers()
    const { native, mic } = await app()
    mic.close()
    const played = vi.fn()
    native.nativeCues.whenSettled(played)
    expect(played).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1500)
    expect(played).toHaveBeenCalledTimes(1)
  })

  it('plays at once on a microphone that is not stopping', async () => {
    const { cues, posted } = await app()
    cues.playHandsFreeCue('dictationEnd')
    expect(posted.filter((m) => m.action === 'cue').map((m) => m.name)).toEqual(['dictationEnd'])
  })
})
