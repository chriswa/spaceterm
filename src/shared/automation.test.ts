import { describe, it, expect } from 'vitest'
import { parseTrigger, triggerLine, formatLocalTime, isAutomationRun } from './automation'
import { lookupIn } from './node-ancestry'
import type { NodeData } from './state'

describe('parseTrigger', () => {
  it('reads an empty field as no trigger yet', () => {
    expect(parseTrigger('  ')).toEqual({ kind: 'empty' })
  })

  it('reads a cron expression', () => {
    expect(parseTrigger(' 0 9 * * 1-5 ')).toEqual({ kind: 'cron', expression: '0 9 * * 1-5' })
  })

  it('reads a custom_ event id', () => {
    expect(parseTrigger('custom_linear.new-ticket')).toEqual({ kind: 'event', eventId: 'custom_linear.new-ticket' })
  })

  it('rejects anything else, saying why', () => {
    expect(parseTrigger('every morning').kind).toBe('invalid')
    expect(parseTrigger('custom_').kind).toBe('invalid')
    expect(parseTrigger('custom_has space').kind).toBe('invalid')
    expect(parseTrigger('61 * * * *').kind).toBe('invalid')
  })
})

describe('triggerLine', () => {
  const at = Date.UTC(2026, 9, 24, 16, 0, 0)

  it('names the time for a cron firing', () => {
    expect(triggerLine({ kind: 'cron', at })).toBe(`Triggered by: cron at ${formatLocalTime(at)}`)
  })

  it('says a late cron firing was missed, and when it was due', () => {
    const line = triggerLine({ kind: 'cron', at, missed: { firstDueAt: at - 3_600_000, count: 3 } })
    expect(line).toContain(formatLocalTime(at - 3_600_000))
    expect(line).toContain('missed 3 times')
    expect(line).toContain('Spaceterm was not running')
  })

  it('carries an event payload as JSON', () => {
    expect(triggerLine({ kind: 'event', at, eventId: 'custom_x', payload: { a: [1, 'b'] } }))
      .toBe('Triggered by: custom_x {"a":[1,"b"]}')
  })
})

describe('formatLocalTime', () => {
  it('round-trips through Date', () => {
    const at = Date.UTC(2026, 0, 2, 3, 4, 5)
    expect(new Date(formatLocalTime(at)).getTime()).toBe(at)
  })
})

describe('isAutomationRun', () => {
  const node = (id: string, type: string, parentId = 'root') => ({ id, type, parentId }) as unknown as NodeData
  const nodes: Record<string, NodeData> = {
    auto: node('auto', 'automation'),
    run: node('run', 'terminal', 'auto'),
    sub: node('sub', 'terminal', 'run'),
    note: node('note', 'markdown', 'auto'),
    plain: node('plain', 'terminal')
  }
  const lookup = lookupIn(nodes)

  it('is true for a terminal with an automation anywhere above it', () => {
    expect(isAutomationRun(lookup, nodes.run)).toBe(true)
    expect(isAutomationRun(lookup, nodes.sub)).toBe(true)
  })

  it('is false for other terminals and for cards that are not terminals', () => {
    expect(isAutomationRun(lookup, nodes.plain)).toBe(false)
    expect(isAutomationRun(lookup, nodes.note)).toBe(false)
    expect(isAutomationRun(lookup, nodes.auto)).toBe(false)
  })
})
