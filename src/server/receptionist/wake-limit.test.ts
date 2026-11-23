import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_WAKE_LIMIT, NEARLY_COLD_MS, NO_WAKE_LIMIT, parseWakeLimit, readWakeLimit, tokenWords, WAKE_LIMIT_KEY, wakeWords } from './wake-limit'

const NOW = 1_800_000_000_000
const min = 60_000

describe('parseWakeLimit', () => {
  it('reads the limit the menu bar wrote', () => {
    expect(parseWakeLimit(JSON.stringify({ [WAKE_LIMIT_KEY]: 250_000 }))).toBe(250_000)
    expect(parseWakeLimit(JSON.stringify({ other: true, [WAKE_LIMIT_KEY]: 0 }))).toBe(0)
  })

  it('reads null as no limit', () => {
    expect(parseWakeLimit(JSON.stringify({ [WAKE_LIMIT_KEY]: null }))).toBe(NO_WAKE_LIMIT)
  })

  it('falls back to no limit when there is no usable setting', () => {
    expect(DEFAULT_WAKE_LIMIT).toBe(NO_WAKE_LIMIT)
    for (const text of [undefined, '', 'not json', 'null', '{}', JSON.stringify({ [WAKE_LIMIT_KEY]: -5 }), JSON.stringify({ [WAKE_LIMIT_KEY]: '250000' })]) {
      expect(parseWakeLimit(text)).toBe(DEFAULT_WAKE_LIMIT)
    }
  })
})

describe('readWakeLimit', () => {
  let dir: string | undefined
  afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }) })

  it('reads the file each time, so a change in the menu applies at once', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wake-limit-'))
    const file = path.join(dir, 'control.json')
    expect(readWakeLimit(file)).toBe(NO_WAKE_LIMIT)
    fs.writeFileSync(file, JSON.stringify({ [WAKE_LIMIT_KEY]: 0 }))
    expect(readWakeLimit(file)).toBe(0)
    fs.writeFileSync(file, JSON.stringify({ [WAKE_LIMIT_KEY]: null }))
    expect(readWakeLimit(file)).toBe(NO_WAKE_LIMIT)
    fs.writeFileSync(file, JSON.stringify({ [WAKE_LIMIT_KEY]: 100_000 }))
    expect(readWakeLimit(file)).toBe(100_000)
  })
})

describe('wakeWords', () => {
  const big = { cacheWarmTokens: 667_000 }
  const small = { cacheWarmTokens: 40_000 }

  it('says nothing while the cache is comfortably warm, whatever its size', () => {
    expect(wakeWords({ ...big, cacheWarmUntil: NOW + 58 * min }, NOW, 0)).toBeUndefined()
    expect(wakeWords({ ...big, cacheWarmUntil: NOW + NEARLY_COLD_MS }, NOW, 0)).toBeUndefined()
  })

  it('says nothing when nothing is known of the cache', () => {
    expect(wakeWords(big, NOW, 250_000)).toBeUndefined()
  })

  it('says to check with the user for a cold agent above the limit, however briefly it has been cold', () => {
    for (const coldFor of [10_000, 3 * 60 * min]) {
      const words = wakeWords({ ...big, cacheWarmUntil: NOW - coldFor }, NOW, 250_000)
      expect(words).toContain('check with the user before asking it')
      expect(words).toContain('above the 250k tokens')
    }
  })

  it('lets a cold agent within the limit be asked without checking', () => {
    const words = wakeWords({ ...small, cacheWarmUntil: NOW - 3 * 60 * min }, NOW, 250_000)
    expect(words).toContain('may ask it without checking with the user')
    expect(words).not.toContain('check with the user before')
    expect(wakeWords({ cacheWarmTokens: 250_000, cacheWarmUntil: NOW - min }, NOW, 250_000)).toContain('without checking')
  })

  it('treats a cache about to go cold as cold already', () => {
    const words = wakeWords({ ...big, cacheWarmUntil: NOW + 30_000 }, NOW, 250_000)
    expect(words).toContain('about to go cold')
    expect(words).toContain('check with the user before asking it')
  })

  it('asks about every cold agent at a limit of 0', () => {
    expect(wakeWords({ ...small, cacheWarmUntil: NOW - min }, NOW, 0)).toContain('wakes no cold agent without asking')
  })

  it('asks about none with no limit, whatever their size, even unknown', () => {
    for (const agent of [{ cacheWarmTokens: 5_000_000 }, {}, small]) {
      for (const cacheWarmUntil of [NOW - 3 * 60 * min, NOW + 30_000]) {
        const words = wakeWords({ ...agent, cacheWarmUntil }, NOW, NO_WAKE_LIMIT)
        expect(words).toContain('wakes any cold agent without asking, whatever its size, so you may ask it without checking with the user')
        expect(words).not.toContain('check with the user before')
      }
    }
  })

  it('asks when the size is unknown', () => {
    expect(wakeWords({ cacheWarmUntil: NOW - min }, NOW, 500_000)).toContain('size is unknown, so check with the user')
  })
})

describe('tokenWords', () => {
  it('says thousands and millions as they would be spoken', () => {
    expect(tokenWords(100_000)).toBe('100k tokens')
    expect(tokenWords(1_000_000)).toBe('1 million tokens')
    expect(tokenWords(1_500_000)).toBe('1.5 million tokens')
  })
})
