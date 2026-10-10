import { describe, it, expect } from 'vitest'
import { VoiceOperatorSubscription, SUBSCRIBER_NAME } from './voice-operator-subscription'
import type { SpeechResponse, SubscriberRegistration } from './voice-operator'

const REGISTRATION: SubscriberRegistration = { socket: '/tmp/hooks.sock', commands: true, events: ['dictation'] }

function harness(answers: SpeechResponse[] = []) {
  let pid: number | undefined = 100
  const calls: { name: string; registration: SubscriberRegistration }[] = []
  const logs: string[] = []
  const subscription = new VoiceOperatorSubscription(REGISTRATION, {
    readDiscovery: () => (pid === undefined ? undefined : { pid }),
    subscribe: async (name, registration) => {
      calls.push({ name, registration })
      return answers.length ? answers.shift() : { status: 200, body: {} }
    },
    log: (message) => logs.push(message),
  })
  return { subscription, calls, logs, setPid: (next: number | undefined) => { pid = next } }
}

describe('VoiceOperatorSubscription', () => {
  it('registers once per Voice Operator process', async () => {
    const { subscription, calls, setPid } = harness()
    await subscription.check()
    await subscription.check()
    expect(calls).toEqual([{ name: SUBSCRIBER_NAME, registration: REGISTRATION }])
    setPid(200)   // Voice Operator restarted
    await subscription.check()
    expect(calls).toHaveLength(2)
  })

  it('waits for Voice Operator to appear', async () => {
    const { subscription, calls, setPid } = harness()
    setPid(undefined)
    await subscription.check()
    expect(calls).toHaveLength(0)
    setPid(100)
    await subscription.check()
    expect(calls).toHaveLength(1)
  })

  it('retries after a failure, logging it once', async () => {
    const { subscription, calls, logs } = harness([undefined, { status: 500, body: {} }])
    await subscription.check()
    await subscription.check()
    await subscription.check()
    expect(calls).toHaveLength(3)
    expect(logs.filter((line) => line.includes('failed'))).toHaveLength(1)
    expect(logs.at(-1)).toContain('registered')
  })

  it('says plainly when Voice Operator is too old', async () => {
    const { subscription, logs } = harness([{ status: 404, body: {} }])
    await subscription.check()
    expect(logs[0]).toContain('predates /v1/subscribers')
  })
})
