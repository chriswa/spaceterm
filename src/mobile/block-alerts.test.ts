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
  const registered: Array<[string, string]> = []
  const connects: Array<() => void> = []
  installBlockAlerts({
    on: ((type: string, listener: Listener) => { listeners.set(type, listener); return () => undefined }) as never,
    onLifecycle: ((_: string, listener: () => void) => { connects.push(listener); return () => undefined }) as never,
    registerPushToken: (deviceId, token) => registered.push([deviceId, token]),
  }, 'phone-1')
  const emit = (type: string, message: object) => listeners.get(type)!({ type, ...message } as never)
  return { posted, emit, registered, connect: () => connects.forEach(fn => fn()) }
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
    const refuse = () => { throw new Error('subscribed') }
    expect(() => installBlockAlerts({ on: refuse, onLifecycle: refuse, registerPushToken: refuse }, 'phone-1')).not.toThrow()
  })

  it('answers whether a terminal is on screen', () => {
    setup()
    useSurfacePresenterStore.getState().publishFocusedTerminal(a)
    expect(window.spacetermNativeNotifications!.lookingAt(a)).toBe(true)
    expect(window.spacetermNativeNotifications!.lookingAt(asNodeId('b'))).toBe(false)
  })

  it('gives the server the push token, and again on every connect', () => {
    const { registered, connect } = setup()
    connect()
    expect(registered).toEqual([])
    window.spacetermNativeNotifications!.pushToken('abc')
    connect()
    expect(registered).toEqual([['phone-1', 'abc'], ['phone-1', 'abc']])
  })
})
