import { describe, it, expect, afterEach, vi } from 'vitest'
import { useReceptionistStore } from '@/stores/receptionistStore'
import { DUCK_RELEASE_MS, followHandsFree, installDuckOthers } from './duck-others'
import { useHandsFree } from './hands-free'

const holder = { mine: true, muted: false } as NonNullable<ReturnType<typeof useReceptionistStore.getState>['holder']>
const set = (phase: 'thinking' | 'speaking' | 'ready', muted = false) =>
  useReceptionistStore.setState({ phase, holder: { ...holder, muted } })

afterEach(() => {
  vi.useRealTimers()
  useReceptionistStore.setState({ phase: 'ready', holder: null })
})

describe('installDuckOthers', () => {
  it('turns other audio down at once while Control is busy aloud here, and back up once it has been quiet a while', () => {
    vi.useFakeTimers()
    set('ready')
    const posted: boolean[] = []
    const stop = installDuckOthers((on) => posted.push(on))
    expect(posted).toEqual([])
    set('thinking')
    expect(posted).toEqual([true])
    // Between the sonar and the answer: no swell.
    set('ready')
    vi.advanceTimersByTime(DUCK_RELEASE_MS - 1)
    set('speaking')
    vi.advanceTimersByTime(DUCK_RELEASE_MS)
    expect(posted).toEqual([true])
    set('ready')
    vi.advanceTimersByTime(DUCK_RELEASE_MS)
    expect(posted).toEqual([true, false])
    stop()
  })

  it('never ducks while Control is muted here', () => {
    const posted: boolean[] = []
    const stop = installDuckOthers((on) => posted.push(on))
    set('speaking', true)
    expect(posted).toEqual([])
    stop()
  })
})

describe('followHandsFree', () => {
  it('says when hands-free starts and stops taking a dictation down, once each', () => {
    useHandsFree.setState({ phase: 'listening' })
    const posted: boolean[] = []
    const stop = followHandsFree((on) => posted.push(on))
    useHandsFree.setState({ phase: 'hearing' })
    useHandsFree.setState({ phase: 'sending' })
    useHandsFree.setState({ phase: 'listening' })
    expect(posted).toEqual([true, false])
    stop()
    useHandsFree.setState({ phase: 'off' })
  })
})
