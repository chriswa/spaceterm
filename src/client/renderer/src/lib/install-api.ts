import type { PlatformApi } from '../../../../shared/api'
import { createApi } from '../../../../shared/client-api'
import { ServerClient, type ServerTransport } from '../../../../shared/server-client'

/**
 * How long startup waits for the server before showing the canvas anyway.
 *
 * Long enough that the ordinary case — server already up, or coming up
 * alongside us — never sees a resync reload, short enough that a broken server
 * does not look like a hung app.
 */
const STARTUP_CONNECT_GRACE_MS = 8_000

/**
 * Connect to the server and install `window.api`. Every client starts here —
 * the Electron renderer and the mobile web app — and differs only in the
 * transport and platform it passes.
 *
 * Resolves once connected, or once the grace period runs out, whichever is
 * first. Rendering then proceeds either way: an empty canvas is worse than a
 * working one and far better than nothing.
 */
export async function installApi(
  transport: ServerTransport,
  platform: PlatformApi,
  clientName: string
): Promise<ServerClient> {
  const client = new ServerClient(transport, { clientName, log: (m) => platform.log(m) })
  window.api = createApi(client, platform)

  const pendingFocus: string[] = []
  const flushFocus = () => pendingFocus.splice(0).forEach((id) => client.requestFocusById(id))
  platform.onFocusRequest((id) => {
    if (client.isConnected()) client.requestFocusById(id)
    else pendingFocus.push(id)
  })

  const connected = await Promise.race([
    client.connect().then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), STARTUP_CONNECT_GRACE_MS))
  ])

  // The page is showing state built without a live server — after a drop it
  // missed broadcasts and every terminal attachment is gone; at startup it may
  // never have synced at all. The next connect rebuilds it from scratch.
  let needsResync = !connected
  if (connected) {
    platform.log('Server connection established')
    flushFocus()
  } else {
    platform.log(`Server not up after ${STARTUP_CONNECT_GRACE_MS}ms; showing the canvas anyway and retrying in the background`)
  }

  client.onLifecycle('disconnect', () => {
    needsResync = true
    platform.log('Lost connection to the spaceterm server; reconnecting')
  })
  client.onLifecycle('connect', () => {
    flushFocus()
    if (!needsResync) return
    platform.log('Server reconnected; reloading for an authoritative resync')
    window.location.reload()
  })

  return client
}
