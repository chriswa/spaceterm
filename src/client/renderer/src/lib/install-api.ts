import type { PlatformApi } from '../../../../shared/api'
import type { ClientDevice } from '../../../../shared/protocol'
import { createApi } from '../../../../shared/client-api'
import { ServerClient, type ServerTransport } from '../../../../shared/server-client'
import { reloadGuard as REAL_RELOAD_GUARD, type ReloadGuard } from './reload-guard'

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
 *
 * `reload` and `guard` are seams for tests: the page's reload, and what may
 * hold it off (reload-guard.ts).
 */
export async function installApi(
  transport: ServerTransport,
  platform: PlatformApi,
  clientName: string,
  device: ClientDevice,
  { reload = () => window.location.reload(), guard = REAL_RELOAD_GUARD }: { reload?: () => void; guard?: ReloadGuard } = {}
): Promise<ServerClient> {
  const client = new ServerClient(transport, { clientName, device, log: (m) => platform.log(m) })
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
  let reloadDeferred = false
  client.onLifecycle('connect', () => {
    flushFocus()
    if (!needsResync) return
    if (!guard.held) {
      platform.log('Server reconnected; reloading for an authoritative resync')
      reload()
      return
    }
    // A dictation still being spoken or sent would go with the page: it
    // resumes over this connection, and the reload waits for it to end.
    if (reloadDeferred) return
    reloadDeferred = true
    platform.log('Server reconnected; the resync reload waits for the dictation under way')
    void guard.free().then(() => {
      platform.log('Dictation over; reloading for an authoritative resync')
      reload()
    })
  })

  return client
}
