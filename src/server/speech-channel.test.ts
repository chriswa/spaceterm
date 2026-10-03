import { describe, it, expect, vi } from 'vitest'
import { SpeechChannel, speechFailureMessage, type SpeechFailure, type SpeechPhase } from './speech-channel'
import type { SpeechBackend, SpeechContent, SpeechResponse, SpeechStatus } from './voice-operator'

type StatusCall = { id: string; opts?: { wait?: number; since?: number } }

/**
 * A scripted speech backend. `speak` answers with `accepted` (or a deferred
 * reply a test releases by hand); each `status` call takes the next scripted
 * status, and repeats the last one once the script runs out.
 */
function fakeBackend(script: {
  accepted?: SpeechResponse
  statuses?: Array<Partial<SpeechStatus>>
  dropped?: Partial<SpeechStatus>
} = {}) {
  const spoken: Array<{ content: SpeechContent; voice?: string }> = []
  const statusCalls: StatusCall[] = []
  const drops: string[] = []
  const statuses = [...(script.statuses ?? [{ state: 'completed' }])]
  let pendingSpeak: ((response: SpeechResponse) => void) | undefined
  let holdSpeak = false
  const backend: SpeechBackend = {
    speak: async (content, voice) => {
      spoken.push({ content, voice })
      if (holdSpeak) return new Promise<SpeechResponse>((resolve) => { pendingSpeak = resolve })
      return script.accepted ?? { status: 202, body: { id: 'job-1', state: 'in_progress', playback_state: 'queued', version: 1 } }
    },
    status: async (id, opts) => {
      statusCalls.push({ id, opts })
      const next = statuses.length > 1 ? statuses.shift()! : statuses[0]
      return { status: 200, body: { id, ...next } }
    },
    drop: async (id) => {
      drops.push(id)
      return { status: 410, body: { id, state: 'cancelled_by_client', ...script.dropped } }
    },
  }
  return {
    backend, spoken, statusCalls, drops,
    holdSpeak: () => { holdSpeak = true },
    releaseSpeak: (response: SpeechResponse) => pendingSpeak?.(response),
  }
}

function harness(backend: SpeechBackend, opts: { discovered?: boolean; stallBetweenPolls?: boolean } = {}) {
  const phases: Array<[SpeechPhase, SpeechPhase]> = []
  const failures: SpeechFailure[] = []
  const sleeps: number[] = []
  const channel = new SpeechChannel({
    speech: backend,
    label: '[test]',
    onPhase: (phase, previous) => phases.push([phase, previous]),
    onFailure: (failure) => failures.push(failure),
    deps: {
      sleep: (ms) => {
        sleeps.push(ms)
        return opts.stallBetweenPolls ? new Promise<void>(() => {}) : Promise.resolve()
      },
      voiceOperatorDiscovered: () => opts.discovered ?? true,
    },
  })
  return { channel, phases, failures, sleeps, sequence: () => phases.map(([phase]) => phase) }
}

async function flush(turns = 20): Promise<void> {
  for (let i = 0; i < turns; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('SpeechChannel', () => {
  it('walks thinking → synthesizing → speaking → ready, reporting each change once with its predecessor', async () => {
    const vo = fakeBackend({
      statuses: [
        { state: 'in_progress', playback_state: 'queued', version: 2 },
        { state: 'in_progress', playback_state: 'speaking', version: 3 },
        // A sentence handoff mid-answer must not flicker back to synthesizing.
        { state: 'in_progress', playback_state: 'queued', version: 4 },
        { state: 'completed', version: 5 },
      ],
    })
    const h = harness(vo.backend)
    const attempt = h.channel.begin('thinking')
    expect(h.channel.isProducing()).toBe(true)
    expect(await h.channel.deliver(attempt, 'Hello there.', 'voice-a')).toBe(true)
    await flush()
    expect(h.phases).toEqual([
      ['thinking', 'ready'], ['synthesizing', 'thinking'], ['speaking', 'synthesizing'], ['ready', 'speaking'],
    ])
    expect(h.channel.isProducing()).toBe(false)
    expect(vo.spoken).toEqual([{ content: 'Hello there.', voice: 'voice-a' }])
  })

  it('speaks an interim line ahead of the answer, handing the wait to the backend', async () => {
    const vo = fakeBackend()
    const h = harness(vo.backend)
    const attempt = h.channel.begin('thinking')
    await h.channel.deliverInterim(attempt, 'Let me check.')
    expect(h.channel.phase).toBe('synthesizing')
    await h.channel.deliver(attempt, 'Kevin finished.')
    await flush()
    expect(vo.spoken.map(entry => entry.content)).toEqual(['Let me check.', 'Kevin finished.'])
  })

  it('a cancel drops the interim line too, so a stop stops everything', async () => {
    const vo = fakeBackend({ statuses: [{ state: 'in_progress', playback_state: 'speaking', version: 2 }] })
    const h = harness(vo.backend, { stallBetweenPolls: true })
    const attempt = h.channel.begin('thinking')
    await h.channel.deliverInterim(attempt, 'Let me check.')
    expect(await h.channel.cancel()).toBe(true)
    expect(vo.drops).toEqual(['job-1'])
    expect(h.channel.phase).toBe('ready')
  })

  it('a new begin supersedes the running attempt and aborts what it was waiting on', () => {
    const h = harness(fakeBackend().backend)
    const first = h.channel.begin('thinking')
    const second = h.channel.begin('synthesizing')
    expect(first.isCurrent).toBe(false)
    expect(first.signal.aborted).toBe(true)
    expect(second.isCurrent).toBe(true)
    // A superseded attempt settling must not touch the phase its successor owns.
    h.channel.settle(first)
    expect(h.channel.phase).toBe('synthesizing')
    h.channel.settle(second)
    expect(h.channel.phase).toBe('ready')
  })

  it('a cancel that lands during the POST drops the job the POST then creates', async () => {
    const vo = fakeBackend()
    vo.holdSpeak()
    const h = harness(vo.backend)
    const attempt = h.channel.begin('synthesizing')
    const delivering = h.channel.deliver(attempt, 'Stop me.')
    await flush(2)
    expect(await h.channel.cancel()).toBe(true)
    expect(h.channel.phase).toBe('ready')
    vo.releaseSpeak({ status: 202, body: { id: 'late-job', state: 'in_progress', version: 1 } })
    expect(await delivering).toBe(false)
    await flush()
    expect(vo.drops).toEqual(['late-job'])
    expect(vo.statusCalls).toEqual([])
    expect(h.sequence()).toEqual(['synthesizing', 'ready'])
  })

  it('records where the listener interrupted, once', async () => {
    const vo = fakeBackend({ statuses: [{ state: 'interrupted_by_user', character_offset: 17, version: 2 }] })
    const h = harness(vo.backend)
    await h.channel.deliver(h.channel.begin('thinking'), 'One sentence. Another one.')
    await flush()
    expect(await h.channel.heardPrefix()).toBe(17)
    expect(await h.channel.heardPrefix()).toBeUndefined()
  })

  it('records a reported zero offset when cancelled, as distinct from no offset', async () => {
    const vo = fakeBackend({
      statuses: [{ state: 'in_progress', playback_state: 'queued', version: 1 }],
      dropped: { character_offset: 0 },
    })
    const h = harness(vo.backend, { stallBetweenPolls: true })
    await h.channel.deliver(h.channel.begin('thinking'), 'Never heard.')
    await flush()
    expect(await h.channel.cancel()).toBe(true)
    expect(vo.drops).toEqual(['job-1'])
    expect(await h.channel.heardPrefix()).toBe(0)
  })

  it('cancel reports nothing to stop on an idle channel', async () => {
    const h = harness(fakeBackend().backend)
    expect(await h.channel.cancel()).toBe(false)
    expect(h.phases).toEqual([])
  })

  it('short-polls at the floor, without a cursor, on a service that reports no version', async () => {
    const vo = fakeBackend({
      accepted: { status: 202, body: { id: 'job-1', state: 'in_progress' } },
      statuses: [
        { state: 'in_progress', playback_state: 'queued' },
        { state: 'in_progress', playback_state: 'speaking' },
        { state: 'in_progress', playback_state: 'speaking' },
        { state: 'completed' },
      ],
    })
    const h = harness(vo.backend)
    await h.channel.deliver(h.channel.begin('thinking'), 'Old service.')
    await flush()
    expect(vo.statusCalls.map((c) => c.opts)).toEqual([{ wait: 0 }, { wait: 0 }, { wait: 0 }, { wait: 0 }])
    expect(h.sleeps.length).toBe(3)
    expect(h.sleeps.every((ms) => ms > 0)).toBe(true)
    expect(h.sequence()).toEqual(['thinking', 'synthesizing', 'speaking', 'ready'])
  })

  it('long-polls with the cursor when the service offers one', async () => {
    const vo = fakeBackend({
      statuses: [{ state: 'in_progress', playback_state: 'speaking', version: 2 }, { state: 'completed', version: 3 }],
    })
    const h = harness(vo.backend)
    await h.channel.deliver(h.channel.begin('thinking'), 'New service.')
    await flush()
    expect(vo.statusCalls.map((c) => c.opts)).toEqual([{ wait: 30, since: 1 }, { wait: 30, since: 2 }])
    expect(h.sleeps).toEqual([])
  })

  it('names a refusal, an unreachable service and a failed synthesis; stays quiet when there is no service', async () => {
    const muted = harness(fakeBackend({ accepted: { status: 503, body: { error: 'speech_muted' } } }).backend)
    const attempt = muted.channel.begin('thinking')
    expect(await muted.channel.deliver(attempt, 'x')).toBe(false)
    muted.channel.settle(attempt)
    expect(muted.failures).toEqual([{ kind: 'refused', error: 'speech_muted' }])

    // No reply at all: the service could not be reached.
    const silent: SpeechBackend = { ...fakeBackend().backend, speak: async () => undefined }
    const unreachable = harness(silent)
    await unreachable.channel.deliver(unreachable.channel.begin('thinking'), 'x')
    expect(unreachable.failures).toEqual([{ kind: 'refused', error: 'unreachable' }])

    const absent = harness(silent, { discovered: false })
    await absent.channel.deliver(absent.channel.begin('thinking'), 'x')
    expect(absent.failures).toEqual([])

    const failed = harness(fakeBackend({ statuses: [{ state: 'synthesis_failed', version: 2 }] }).backend)
    await failed.channel.deliver(failed.channel.begin('thinking'), 'x')
    await flush()
    expect(failed.failures).toEqual([{ kind: 'synthesis_failed' }])
    expect(failed.channel.phase).toBe('ready')

    expect(speechFailureMessage({ kind: 'synthesis_failed' }, 'the summary'))
      .toBe('Voice Operator could not turn the summary into speech.')
  })

  it('follows a job on the backend that took it, even after the channel is pointed elsewhere', async () => {
    const phone = fakeBackend({ statuses: [{ state: 'in_progress', playback_state: 'speaking', version: 1 }] })
    const mac = fakeBackend()
    const h = harness(phone.backend, { stallBetweenPolls: true })
    await h.channel.deliver(h.channel.begin('thinking'), 'On the phone.')
    await flush()
    h.channel.speech = mac.backend
    await h.channel.cancel()
    expect(phone.drops).toEqual(['job-1'])
    expect(mac.drops).toEqual([])
  })

  it('hands parts to the backend as given', async () => {
    const vo = fakeBackend()
    const h = harness(vo.backend)
    const parts = [{ text: 'Hello.', voice: 'af_bella' }, { text: 'Hi.' }]
    await h.channel.deliver(h.channel.begin('synthesizing'), parts, 'am_adam')
    expect(vo.spoken).toEqual([{ content: parts, voice: 'am_adam' }])
  })
})
