import { describe, expect, it } from 'vitest'
import { asNodeId } from '../shared/ids'
import { MAX_NOTIFICATIONS, NotificationLog, type IncomingNotification, type NotificationLogDeps } from './notification-log'

function fakeFile(initial = '') {
  const file = { text: initial, replaced: 0 }
  const deps: NotificationLogDeps = {
    read: () => file.text,
    append: (text) => { file.text += text },
    replace: (text) => { file.text = text; file.replaced++ },
  }
  return { file, deps }
}

const sent = (overrides: Partial<IncomingNotification> = {}): IncomingNotification => ({
  nodeId: asNodeId('a'), kind: 'question', title: 'Fix the build', body: 'It asks a question', reached: true, ...overrides,
})

describe('NotificationLog', () => {
  it('keeps what was sent, and survives a restart', () => {
    const { file, deps } = fakeFile()
    new NotificationLog(deps).record(sent({ kind: 'permission' }), 1_000)
    const reopened = new NotificationLog(deps)
    reopened.record(sent({ kind: 'manual', title: 'Other' }), 2_000)
    expect(reopened.list().map(r => [r.seq, r.kind, r.title, r.at])).toEqual([[1, 'permission', 'Fix the build', 1_000], [2, 'manual', 'Other', 2_000]])
    expect(file.text.split('\n').filter(Boolean)).toHaveLength(2)
  })

  it('keeps only the newest, and rewrites the file once it has doubled', () => {
    const { file, deps } = fakeFile()
    const log = new NotificationLog(deps)
    for (let i = 0; i < 2 * MAX_NOTIFICATIONS + 1; i++) log.record(sent(), i)
    expect(log.list()).toHaveLength(MAX_NOTIFICATIONS)
    expect(log.list()[0].seq).toBe(MAX_NOTIFICATIONS + 2)
    expect(file.replaced).toBe(1)
    expect(new NotificationLog(deps).list()).toHaveLength(MAX_NOTIFICATIONS)
  })

  it('shortens a long body', () => {
    const { deps } = fakeFile()
    expect(new NotificationLog(deps).record(sent({ body: 'x'.repeat(5_000) }), 0).body.length).toBeLessThanOrEqual(300)
  })

  it('skips lines it cannot read', () => {
    const { deps } = fakeFile('not json\n{"seq":1,"at":1,"nodeId":"a","kind":"bogus","title":"t"}\n')
    const log = new NotificationLog(deps)
    expect(log.list()).toEqual([])
    expect(log.record(sent(), 5).seq).toBe(1)
  })
})
