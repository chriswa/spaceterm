import { describe, it, expect, afterEach } from 'vitest'
import { installHandsFreeRequests } from './native-hands-free-request'

type Host = { webkit?: unknown; spacetermHandsFreeRequest?: { start(): void } }
const host = window as unknown as Host

afterEach(() => {
  delete host.webkit
  delete host.spacetermHandsFreeRequest
})

describe('the app asking the page to start hands-free', () => {
  it('says it is ready, and starts hands-free each time the app asks', () => {
    const posted: unknown[] = []
    host.webkit = { messageHandlers: { nativeHandsFreeRequest: { postMessage: (m: unknown) => posted.push(m) } } }
    let started = 0
    installHandsFreeRequests(() => started++)
    expect(posted).toEqual([{ ready: true }])
    host.spacetermHandsFreeRequest?.start()
    host.spacetermHandsFreeRequest?.start()
    expect(started).toBe(2)
  })

  it('takes nothing once stopped, and leaves a newer taker alone', () => {
    host.webkit = { messageHandlers: { nativeHandsFreeRequest: { postMessage: () => {} } } }
    const stopOld = installHandsFreeRequests(() => {})
    const stopNew = installHandsFreeRequests(() => {})
    stopOld()
    expect(host.spacetermHandsFreeRequest).toBeDefined()
    stopNew()
    expect(host.spacetermHandsFreeRequest).toBeUndefined()
  })

  it('does nothing in a browser, or an app without the intent', () => {
    installHandsFreeRequests(() => {})
    expect(host.spacetermHandsFreeRequest).toBeUndefined()
  })
})
