import { describe, it, expect } from 'vitest'
import { announceInstallStage, speakAndWait, INSTALL_WORDS, SPEECH_LIMIT_MS, type InstallingPhone } from './install-announcer'
import type { SpeechBackend } from './voice-operator'
import { NO_LISTENER } from './receptionist/receptionist'

/** A speaker whose job is in progress for `polls` status answers, then completed; the clock moves a second a poll. */
function speaker(polls: number, clock: { t: number }) {
  const spoken: string[] = []
  let version = 0
  const backend: SpeechBackend = {
    speak: async (content) => {
      spoken.push(String(content))
      return { status: 200, body: { id: 'job-1', state: 'in_progress', version } }
    },
    status: async () => {
      clock.t += 1000
      version++
      return { status: 200, body: { id: 'job-1', state: version > polls ? 'completed' : 'in_progress', version } }
    },
    drop: async () => undefined,
  }
  return { backend, spoken }
}

function phone(speech: SpeechBackend, events: string[], canQuit = true): InstallingPhone {
  return { label: 'Phone', speech, quit: () => { events.push('quit'); return canQuit } }
}

describe('announceInstallStage', () => {
  it('asks for Install aloud while the dialog is up, and leaves the app running', async () => {
    const clock = { t: 0 }
    const { backend, spoken } = speaker(1, clock)
    const events: string[] = []
    await announceInstallStage('asking', [phone(backend, events)], { log: () => undefined, now: () => clock.t })
    expect(spoken).toEqual([INSTALL_WORDS.asking])
    expect(events).toEqual([])
  })

  it('once Install is pressed, says the app is closing, then ends it only after the words are done', async () => {
    const clock = { t: 0 }
    const events: string[] = []
    const { backend, spoken } = speaker(3, clock)
    const watched: SpeechBackend = {
      ...backend,
      status: async (...args) => {
        const r = await backend.status(...args)
        events.push((r?.body as { state: string }).state)
        return r
      },
    }
    await announceInstallStage('installing', [phone(watched, events)], { log: () => undefined, now: () => clock.t })
    expect(spoken).toEqual([INSTALL_WORDS.installing])
    expect(events).toEqual(['in_progress', 'in_progress', 'in_progress', 'completed', 'quit'])
  })

  it('ends the app even with nobody to hear it', async () => {
    const events: string[] = []
    await announceInstallStage('installing', [phone(NO_LISTENER, events)], { log: () => undefined })
    expect(events).toEqual(['quit'])
  })

  it('says in the log when the page cannot end its app', async () => {
    const logs: string[] = []
    await announceInstallStage('installing', [phone(NO_LISTENER, [], false)], { log: (m) => logs.push(m) })
    expect(logs.at(-1)).toMatch(/cannot quit/)
  })
})

describe('speakAndWait', () => {
  it('stops waiting at the time limit, so an install never waits on speech', async () => {
    const clock = { t: 0 }
    const { backend } = speaker(Number.POSITIVE_INFINITY, clock)
    expect(await speakAndWait(backend, 'words', () => clock.t)).toMatch(/time limit/)
    expect(clock.t).toBeGreaterThanOrEqual(SPEECH_LIMIT_MS)
    expect(clock.t).toBeLessThan(SPEECH_LIMIT_MS + 2000)
  })
})
