import { describe, it, expect, beforeEach } from 'vitest'
import { beginRecordingSession, initAudioSession, setListenOnEarpiece } from './audio-session'

/** jsdom has no Audio Session API; the module reads and writes only `type`. */
const session = { type: 'auto' }
Object.defineProperty(navigator, 'audioSession', { value: session, configurable: true })

describe('audio session', () => {
  beforeEach(() => {
    setListenOnEarpiece(false)
    session.type = 'auto'
    initAudioSession()
  })

  it('plays on the speaker, and returns there when the microphone closes', () => {
    expect(session.type).toBe('playback')
    const release = beginRecordingSession()
    expect(session.type).toBe('play-and-record')
    release()
    expect(session.type).toBe('playback')
  })

  it('stays recording until the last of two overlapping recordings closes, and a second release does nothing', () => {
    const first = beginRecordingSession()
    const second = beginRecordingSession()
    first()
    first()
    expect(session.type).toBe('play-and-record')
    second()
    expect(session.type).toBe('playback')
  })

  it('the earpiece preference holds play-and-record between recordings too', () => {
    setListenOnEarpiece(true)
    expect(session.type).toBe('play-and-record')
    beginRecordingSession()()
    expect(session.type).toBe('play-and-record')
    setListenOnEarpiece(false)
    expect(session.type).toBe('playback')
  })
})
