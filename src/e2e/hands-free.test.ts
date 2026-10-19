import { describe, it, expect, afterEach } from 'vitest'
import { execFileSync } from 'child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { e2eBlocker, launchApp, type LaunchedApp } from './electron-app'

/**
 * Hands-free on the Mac, end to end in the real app: the toolbar button holds
 * a microphone — Chromium's fake one, playing speech macOS `say` made — and
 * hands-free hears it as speech and asks the server whether it was for
 * Control. Whether the answer is yes is Voice Operator's (on macOS 26), and
 * not asserted: that the question is asked is what this layer can prove.
 */

/** "Control, …" after a quiet spell, as a 48 kHz mono WAV Chromium can use as its microphone. Null without `say`. */
function speechWav(dir: string): string | null {
  if (process.platform !== 'darwin') return null
  const aiff = join(dir, 'speech.aiff')
  const wav = join(dir, 'speech.wav')
  execFileSync('say', ['-o', aiff, '[[slnc 2000]] Control, what is Kevin doing right now? [[slnc 4000]]'])
  execFileSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16@48000', '-c', '1', aiff, wav])
  return wav
}

const blocker = e2eBlocker() ?? (process.platform === 'darwin' ? null : 'needs macOS `say` for its speech')
const describeE2E = blocker ? describe.skip : describe
if (blocker) console.warn(`[e2e] skipping hands-free: ${blocker}`)

let launched: LaunchedApp | null = null
let scratch: string | null = null
afterEach(async () => {
  await launched?.close()
  launched = null
  if (scratch) rmSync(scratch, { recursive: true, force: true })
  scratch = null
})

/** The audio and lifecycle record the server kept for this run. */
function events(home: string): Array<{ kind: string; detail?: Record<string, unknown> }> {
  const path = join(home, 'mobile-events.jsonl')
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
}

describeE2E('hands-free on the Mac', () => {
  it('hears speech on the held microphone and asks the server whether it was for Control', async () => {
    scratch = mkdtempSync(join(tmpdir(), 'spaceterm-e2e-speech-'))
    const wav = speechWav(scratch)!
    launched = await launchApp({
      args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${wav}`],
    })
    const { window, home } = launched
    await window.waitForSelector('.toolbar__hands-free', { timeout: 60_000 })
    // Off-viewport at the canvas's zoom, so clicked from the page rather than by coordinates.
    await window.evaluate(() => (document.querySelector('.toolbar__hands-free') as HTMLButtonElement).click())
    await window.waitForSelector('.toolbar__hands-free.m-hands-free--held', { timeout: 10_000 })

    // The record reaches the server in batches; the file's first loop has speech two seconds in.
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline && !events(home).some((e) => e.kind === 'wake-word')) {
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    const kinds = events(home).map((e) => e.kind)
    expect(kinds).toContain('hands-free-speech')
    expect(kinds).toContain('wake-word')
    expect(kinds).not.toContain('hands-free-deaf')
  })
})
