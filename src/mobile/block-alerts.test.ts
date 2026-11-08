// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { asNodeId } from '../shared/ids'
import { useSurfacePresenterStore } from '@/stores/surfacePresenterStore'
import { installBlockAlerts } from './block-alerts'

type Listener = (message: never) => void

function setup() {
  const posted: unknown[] = []
  window.webkit = { messageHandlers: { nativeNotifications: { postMessage: (m: unknown) => posted.push(m) } } }
  const listeners = new Map<string, Listener>()
  installBlockAlerts({ on: ((type: string, listener: Listener) => { listeners.set(type, listener); return () => undefined }) as never })
  const emit = (type: string, message: object) => listeners.get(type)!({ type, ...message } as never)
  return { posted, emit }
}

const a = asNodeId('a')

describe('block alerts', () => {
  beforeEach(() => useSurfacePresenterStore.getState().publishFocusedTerminal(null))

  it('tells the app it is ready, last', () => {
    expect(setup().posted).toEqual([{ kind: 'ready' }])
  })

  it('shows a blocked agent', () => {
    const { posted, emit } = setup()
    emit('block-alert', { nodeId: a, title: 'T', body: 'B' })
    expect(posted.at(-1)).toEqual({ kind: 'show', id: a, title: 'T', body: 'B' })
  })

  it('stays quiet about the terminal on screen', () => {
    const { posted, emit } = setup()
    useSurfacePresenterStore.getState().publishFocusedTerminal(a)
    emit('block-alert', { nodeId: a, title: 'T', body: 'B' })
    expect(posted).toEqual([{ kind: 'ready' }])
  })

  it('still shows another terminal than the one on screen', () => {
    const { posted, emit } = setup()
    useSurfacePresenterStore.getState().publishFocusedTerminal(asNodeId('b'))
    emit('block-alert', { nodeId: a, title: 'T', body: 'B' })
    expect(posted.at(-1)).toMatchObject({ kind: 'show' })
  })

  it('withdraws a notification when the block ends', () => {
    const { posted, emit } = setup()
    emit('block-alert-cleared', { nodeId: a })
    expect(posted.at(-1)).toEqual({ kind: 'clear', id: a })
  })

  it('does nothing without the app', () => {
    window.webkit = { messageHandlers: {} }
    expect(() => installBlockAlerts({ on: () => { throw new Error('subscribed') } })).not.toThrow()
  })
})
