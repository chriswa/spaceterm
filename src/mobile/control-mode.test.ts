import { describe, it, expect, beforeEach } from 'vitest'
import { createGate } from './gate'
import { canvasOnScreen } from './browser-platform'
import { controlModeGate, installControlMode, type ControlModeDeps } from './control-mode'

function deps(): ControlModeDeps & { paused: boolean[] } {
  const paused: boolean[] = []
  return { paused, pauseCanvas: (p) => paused.push(p), log: () => undefined, record: () => undefined }
}

describe('Control mode', () => {
  const transcript = createGate(false)
  const hidden = createGate(false)
  let uninstall = () => {}
  beforeEach(() => {
    uninstall()
    transcript.set(false)
    hidden.set(false)
  })

  it('is on while the transcript is up or the page is hidden', () => {
    const mode = controlModeGate(transcript, hidden)
    expect(mode.on).toBe(false)
    transcript.set(true)
    expect(mode.on).toBe(true)
    hidden.set(true)
    transcript.set(false)
    expect(mode.on).toBe(true)
    hidden.set(false)
    expect(mode.on).toBe(false)
  })

  it('pauses the canvas on the server and covers it, and undoes both', () => {
    const d = deps()
    uninstall = installControlMode(controlModeGate(transcript, hidden), d)
    expect(d.paused).toEqual([])
    expect(canvasOnScreen.on).toBe(true)

    transcript.set(true)
    expect(d.paused).toEqual([true])
    expect(canvasOnScreen.on).toBe(false)

    // Locking the phone with the transcript up changes nothing more.
    hidden.set(true)
    expect(d.paused).toEqual([true])

    hidden.set(false)
    transcript.set(false)
    expect(d.paused).toEqual([true, false])
    expect(canvasOnScreen.on).toBe(true)
  })
})
