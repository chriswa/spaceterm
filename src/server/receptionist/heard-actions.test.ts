import { describe, expect, it } from 'vitest'
import { HeardActions } from './heard-actions'

const PARTS = [{ text: 'Sent to Jack.' }, { text: 'Tessa here. Please do the pinch.' }]
/** Where the voice is once "Jack" has begun: Voice Operator counts a word heard from its start, and reports its end. */
const JACK = 'Sent to Jack'.length
const PINCH = 'Sent to Jack. Tessa here. Please do the pinch'.length

function harness(actions: Array<{ action: string; after: number }>) {
  const ran: string[] = []
  const heard = new HeardActions(PARTS, actions, async (batch) => { ran.push(...batch) })
  return { heard, ran }
}

describe('HeardActions', () => {
  it('runs an action once the words before it are heard, and not before', async () => {
    const { heard, ran } = harness([{ action: 'send', after: 1 }, { action: 'spawn', after: 2 }])
    heard.heard(JACK - 1)
    await heard.settled
    expect(ran).toEqual([])
    heard.heard(JACK)
    await heard.settled
    expect(ran).toEqual(['send'])
    heard.heard(PINCH)
    await heard.settled
    expect(ran).toEqual(['send', 'spawn'])
    expect(heard.pending).toBe(false)
  })

  it('runs an action with no words before it at once', async () => {
    const { heard, ran } = harness([{ action: 'monitor', after: 0 }, { action: 'send', after: 1 }])
    await heard.settled
    expect(ran).toEqual(['monitor'])
  })

  it('skips what the listener did not hear, and runs nothing more', async () => {
    const { heard, ran } = harness([{ action: 'send', after: 1 }, { action: 'spawn', after: 2 }])
    heard.heard(JACK)
    expect(heard.skip()).toEqual(['spawn'])
    heard.all()
    await heard.settled
    expect(ran).toEqual(['send'])
  })

  it('runs everything left when there is nothing more to wait for', async () => {
    const { heard, ran } = harness([{ action: 'send', after: 1 }, { action: 'spawn', after: 2 }])
    heard.all()
    await heard.settled
    expect(ran).toEqual(['send', 'spawn'])
  })

  it('runs one batch after another, in order, even when one fails', async () => {
    const ran: string[] = []
    let finishFirst: () => void = () => {}
    const heard = new HeardActions(PARTS, [{ action: 'interrupt', after: 1 }, { action: 'send', after: 2 }], async (batch) => {
      if (batch[0] === 'interrupt') {
        await new Promise<void>((resolve) => { finishFirst = resolve })
        ran.push('interrupt')
        throw new Error('failed')
      }
      ran.push(...batch)
    })
    heard.heard(JACK)
    heard.all()
    await Promise.resolve()
    expect(ran).toEqual([])
    finishFirst()
    await heard.settled
    expect(ran).toEqual(['interrupt', 'send'])
  })
})

describe('HeardActions, released with nothing running', () => {
  it('starts the batch in the same call, so its effects are in place when the caller goes on', () => {
    const ran: string[] = []
    const heard = new HeardActions(PARTS, [{ action: 'go_quiet', after: 2 }], async (batch) => { ran.push(...batch) })
    heard.all()
    expect(ran).toEqual(['go_quiet'])
  })
})

describe('HeardActions.whenDone', () => {
  it('waits for every action to run or be skipped', async () => {
    const { heard, ran } = harness([{ action: 'send', after: 1 }, { action: 'spawn', after: 2 }])
    let done = false
    void heard.whenDone().then(() => { done = true })
    heard.heard(JACK)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(done).toBe(false)
    heard.skip()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(done).toBe(true)
    expect(ran).toEqual(['send'])
  })

  it('runs everything at once for a reply with nothing to say', async () => {
    const ran: string[] = []
    const heard = new HeardActions([], [{ action: 'send', after: 0 }, { action: 'spawn', after: 0 }], async (batch) => { ran.push(...batch) })
    await heard.whenDone()
    expect(ran).toEqual(['send', 'spawn'])
  })
})
