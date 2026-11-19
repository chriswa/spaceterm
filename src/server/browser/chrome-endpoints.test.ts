import { afterEach, describe, expect, it } from 'vitest'
import { WebSocketServer } from 'ws'
import type { AddressInfo } from 'net'
import { BrowserUnavailableError, connectLiveChrome } from './chrome-endpoints'

let server: WebSocketServer | null = null
afterEach(() => { server?.close(); server = null })

/** A stand-in for Chrome's DevTools socket that records the path it was asked for. */
async function fakeDevTools(): Promise<{ port: number; paths: string[] }> {
  const paths: string[] = []
  server = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  server.on('connection', (_socket, req) => paths.push(req.url ?? ''))
  await new Promise((resolve) => server!.once('listening', resolve))
  return { port: (server.address() as AddressInfo).port, paths }
}

describe('connectLiveChrome', () => {
  it("finds the port Chrome listens on when its profile cannot be read, and addresses the browser without its id", async () => {
    const { port, paths } = await fakeDevTools()
    const conn = await connectLiveChrome('/nonexistent-profile', async () => [port])
    conn.close()
    expect(paths).toEqual(['/devtools/browser'])
  })

  it('says how to turn remote debugging on when Chrome is listening on nothing', async () => {
    await expect(connectLiveChrome('/nonexistent-profile', async () => [])).rejects.toBeInstanceOf(BrowserUnavailableError)
  })
})
