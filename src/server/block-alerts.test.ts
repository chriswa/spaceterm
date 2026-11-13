import { describe, expect, it } from 'vitest'
import { asNodeId } from '../shared/ids'
import type { BlockAlertClearedMessage, BlockAlertMessage } from '../shared/protocol'
import { BlockAlerts } from './block-alerts'

const node = asNodeId('a')

function make() {
  const sent: Array<BlockAlertMessage | BlockAlertClearedMessage> = []
  return { sent, alerts: new BlockAlerts({ send: (m) => sent.push(m), title: () => 'Fix the build' }) }
}

describe('BlockAlerts', () => {
  it.each(['waiting_permission', 'waiting_question', 'waiting_plan'] as const)('alerts on entering %s', (state) => {
    const { alerts, sent } = make()
    alerts.observe(node, 'working', state, undefined)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ type: 'block-alert', nodeId: node, title: 'Fix the build' })
  })

  it.each([['waiting_permission', 'permission'], ['waiting_question', 'question'], ['waiting_plan', 'plan']] as const)('names %s as a %s notification', (state, kind) => {
    const { alerts, sent } = make()
    alerts.observe(node, 'working', state, undefined)
    expect(sent[0]).toMatchObject({ kind })
  })

  it('says what the agent wants', () => {
    const { alerts, sent } = make()
    alerts.observe(node, 'working', 'waiting_permission', { tool: 'Bash', input: { command: 'rm -rf build' } })
    expect((sent[0] as BlockAlertMessage).body).toContain('rm -rf build')
    expect((sent[0] as BlockAlertMessage).body[0]).toBe('I')
  })

  it('does not alert for working or stopped agents', () => {
    const { alerts, sent } = make()
    alerts.observe(node, 'stopped', 'working', undefined)
    alerts.observe(node, 'working', 'stopped', undefined)
    expect(sent).toEqual([])
  })

  it('ignores the state machine re-asserting a block', () => {
    const { alerts, sent } = make()
    const prompt = { tool: 'Bash', input: {} }
    alerts.observe(node, 'working', 'waiting_permission', prompt)
    alerts.observe(node, 'waiting_permission', 'waiting_permission', prompt)
    expect(sent).toHaveLength(1)
  })

  it('alerts again when asked again in the same state', () => {
    const { alerts, sent } = make()
    alerts.observe(node, 'working', 'waiting_permission', { tool: 'Bash', input: {} })
    alerts.observe(node, 'waiting_permission', 'waiting_permission', { tool: 'Write', input: {} })
    expect(sent.filter(m => m.type === 'block-alert')).toHaveLength(2)
  })

  it('alerts when one kind of block becomes another', () => {
    const { alerts, sent } = make()
    alerts.observe(node, 'working', 'waiting_permission', undefined)
    alerts.observe(node, 'waiting_permission', 'waiting_plan', undefined)
    expect(sent.filter(m => m.type === 'block-alert')).toHaveLength(2)
  })

  it('stays quiet about a block from before a server restart', () => {
    const { alerts, sent } = make()
    alerts.observe(node, 'waiting_question', 'waiting_question', undefined)
    expect(sent).toEqual([])
  })

  it('withdraws the alert when the block ends, once', () => {
    const { alerts, sent } = make()
    alerts.observe(node, 'working', 'waiting_question', undefined)
    alerts.observe(node, 'waiting_question', 'working', undefined)
    alerts.observe(node, 'working', 'stopped', undefined)
    expect(sent.map(m => m.type)).toEqual(['block-alert', 'block-alert-cleared'])
  })

  it('alerts for the next block after one ended', () => {
    const { alerts, sent } = make()
    alerts.observe(node, 'working', 'waiting_question', undefined)
    alerts.observe(node, 'waiting_question', 'working', undefined)
    alerts.observe(node, 'working', 'waiting_question', undefined)
    expect(sent.filter(m => m.type === 'block-alert')).toHaveLength(2)
  })
})
