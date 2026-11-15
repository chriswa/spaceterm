import { existsSync } from 'fs'
import { describe, expect, it } from 'vitest'
import { currentTime, describeDateFields, zoneName, type ClockProbes } from './current-time'

function probes(printed: string, link: string | Error): ClockProbes {
  return {
    date: async () => printed,
    zoneLink: () => {
      if (link instanceof Error) throw link
      return link
    },
  }
}

describe('currentTime', () => {
  it('says the Mac\'s local time in words, and which zone it is in', async () => {
    expect(await currentTime(probes('Sunday|November|15|2026|12|27|PM|MST|-0700\n', '/var/db/timezone/zoneinfo/America/Vancouver')))
      .toBe('Sunday, November 15, 2026, 12:27 PM, in the Mac\'s time zone, America/Vancouver (MST, UTC-07:00)')
  })

  it('follows the Mac to another zone', async () => {
    expect(await currentTime(probes('Monday|March|02|2027|09|05|AM|HST|-1000\n', '/usr/share/zoneinfo/Pacific/Honolulu')))
      .toBe('Monday, March 2, 2027, 9:05 AM, in the Mac\'s time zone, Pacific/Honolulu (HST, UTC-10:00)')
  })

  it('still tells the time when the zone has no name', async () => {
    expect(await currentTime(probes('Monday|March|02|2027|09|05|AM|UTC|+0000', new Error('EINVAL'))))
      .toBe('Monday, March 2, 2027, 9:05 AM, in the Mac\'s time zone (UTC, UTC+00:00)')
  })

  it('rejects when date prints something unexpected', async () => {
    await expect(currentTime(probes('usage: date', '/etc/zoneinfo/UTC'))).rejects.toThrow('not the fields asked for')
  })

  it.runIf(existsSync('/bin/date'))('reads the real clock', async () => {
    expect(await currentTime()).toMatch(/^\w+day, \w+ \d{1,2}, \d{4}, \d{1,2}:\d\d [AP]M, in the Mac's time zone/)
  })
})

describe('zoneName', () => {
  it('takes the tz name from where /etc/localtime points', () => {
    expect(zoneName('/var/db/timezone/zoneinfo/America/Vancouver')).toBe('America/Vancouver')
    expect(zoneName('/usr/share/zoneinfo/UTC')).toBe('UTC')
    expect(zoneName('/somewhere/else')).toBeUndefined()
  })
})

describe('describeDateFields', () => {
  it('drops the padding date puts on the day and hour', () => {
    expect(describeDateFields('Friday|January|01|2027|01|00|AM|MST|-0700').when).toBe('Friday, January 1, 2027, 1:00 AM')
  })
})
