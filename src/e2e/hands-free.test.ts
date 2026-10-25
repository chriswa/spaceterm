import { describe, it, expect, afterEach } from 'vitest'
import { execFileSync } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { e2eBlocker, launchApp, type LaunchedApp } from './electron-app'

/**
 * Hands-free on the Mac, end to end in the real app: the toolbar button asks
 * the server to turn Voice Operator's hands-free on, and the button follows
 * what comes back. An e2e run's home is isolated, so its server never claims
 * "control" from the operator's Spaceterm: Voice Operator is never asked, and
 * the answer is that this home may not — which is what proves the round trip
 * here. Voice Operator's own side is tested there (`--hands-free-test`).
 * Below macOS 26, where Voice Operator cannot check the trigger word, the
 * button is disabled instead.
 */

const macOSMajor = process.platform === 'darwin'
  ? Number.parseInt(execFileSync('sw_vers', ['-productVersion'], { encoding: 'utf8' }), 10)
  : 0

const blocker = e2eBlocker()
const describeE2E = blocker ? describe.skip : describe
if (blocker) console.warn(`[e2e] skipping hands-free: ${blocker}`)

let launched: LaunchedApp | null = null
afterEach(async () => {
  await launched?.close()
  launched = null
})

/** The audio and lifecycle record the server kept for this run. */
function events(home: string): Array<{ kind: string; detail?: Record<string, unknown> }> {
  const path = join(home, 'mobile-events.jsonl')
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
}

describeE2E('hands-free on the Mac', () => {
  it.skipIf(macOSMajor >= 26)('is disabled below macOS 26, saying why', async () => {
    launched = await launchApp()
    const { window } = launched
    await window.waitForSelector('.toolbar__hands-free', { timeout: 60_000 })
    await window.evaluate(() => (document.querySelector('.toolbar__hands-free') as HTMLButtonElement).click())
    const button = await window.$('.toolbar__hands-free')
    expect(await button!.getAttribute('aria-disabled')).toBe('true')
    expect(await button!.getAttribute('data-tooltip')).toMatch(/needs macOS 26/)
    expect(await button!.getAttribute('aria-pressed')).toBe('false')
  })

  it.skipIf(macOSMajor < 26)('asks the server to turn hands-free on, and goes back off when it may not', async () => {
    launched = await launchApp()
    const { window, home } = launched
    await window.waitForSelector('.toolbar__hands-free', { timeout: 60_000 })
    // Off-viewport at the canvas's zoom, so clicked from the page rather than by coordinates.
    await window.evaluate(() => (document.querySelector('.toolbar__hands-free') as HTMLButtonElement).click())
    // The record reaches the server in batches.
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline && !events(home).some((e) => e.kind === 'hands-free-session')) {
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    const ended = events(home).find((e) => e.kind === 'hands-free-session')
    expect(ended?.detail).toMatchObject({ on: false, why: 'not-operator-home' })
    const button = await window.$('.toolbar__hands-free')
    expect(await button!.getAttribute('aria-pressed')).toBe('false')
  })
})
