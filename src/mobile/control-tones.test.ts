import { afterEach, describe, expect, it } from 'vitest'
import { useReceptionistStore } from '@/stores/receptionistStore'
import { installControlTones, noteUserInterrupted, toneFor } from './control-tones'
import type { Cue } from './cues'

describe('which tone a turn of Control earns', () => {
  it('"nothing to say" when it stopped thinking without a word, and was not cut short', () => {
    expect(toneFor({ phase: 'thinking', error: null }, { phase: 'ready', error: null }, false)).toBe('nothingToSay')
    expect(toneFor({ phase: 'thinking', error: null }, { phase: 'ready', error: null }, true)).toBeNull()
    // It spoke: its voice was the answer.
    expect(toneFor({ phase: 'thinking', error: null }, { phase: 'synthesizing', error: null }, false)).toBeNull()
    expect(toneFor({ phase: 'speaking', error: null }, { phase: 'ready', error: null }, false)).toBeNull()
  })

  it('the error tone for a new failure, cut short or not, and only once for it', () => {
    expect(toneFor({ phase: 'thinking', error: null }, { phase: 'ready', error: 'model failed' }, true)).toBe('error')
    expect(toneFor({ phase: 'ready', error: 'model failed' }, { phase: 'ready', error: 'model failed' }, false)).toBeNull()
  })
})

describe('installControlTones', () => {
  let off: (() => void) | undefined
  afterEach(() => { off?.(); useReceptionistStore.setState({ phase: 'ready', error: null }) })

  function install(talking = false, now = 1_000_000) {
    const played: Cue[] = []
    off = installControlTones({ play: (cue) => played.push(cue), userTalking: () => talking, now: () => now })
    return played
  }

  it('plays "nothing to say" as the store goes from thinking to ready', () => {
    useReceptionistStore.setState({ phase: 'thinking', error: null })
    const played = install()
    useReceptionistStore.setState({ phase: 'ready' })
    expect(played).toEqual(['nothingToSay'])
  })

  it('stays quiet when the user stopped it to talk', () => {
    useReceptionistStore.setState({ phase: 'thinking', error: null })
    const played = install(true)
    useReceptionistStore.setState({ phase: 'ready' })
    expect(played).toEqual([])
  })

  it('stays quiet just after the user interrupted it', () => {
    useReceptionistStore.setState({ phase: 'thinking', error: null })
    noteUserInterrupted(1_000_000 - 2000)
    const played = install(false, 1_000_000)
    useReceptionistStore.setState({ phase: 'ready' })
    expect(played).toEqual([])
  })
})
