import * as net from 'net'
import * as path from 'path'
import * as os from 'os'
import type { ScriptNotifyResult } from '../../shared/protocol.js'

// A request/response on the scripts socket, so the caller can say whether a phone was reached.
const SCRIPTS_SOCKET_PATH = process.env.SPACETERM_HOME
  ? path.join(process.env.SPACETERM_HOME, 'scripts.sock')
  : path.join(os.homedir(), '.spaceterm', 'scripts.sock')
/** Past Apple's own request timeout (10 s in src/server/apns.ts), so the server's answer arrives first. */
export const NOTIFY_TIMEOUT_MS = 15_000

/**
 * Asks the Spaceterm server to put `body` on the user's phone, titled with
 * this surface's agent name. Always sent, whatever has focus on the Mac:
 * shared by the `notify_user` tool and the hook that stands in for Claude
 * Code's own PushNotification.
 */
export function notifyPhone(surfaceId: string, body: string): Promise<ScriptNotifyResult> {
  const request = JSON.stringify({ type: 'script-notify', seq: 1, surfaceId, body }) + '\n'
  return new Promise<ScriptNotifyResult>((resolve, reject) => {
    const socket = net.createConnection(SCRIPTS_SOCKET_PATH, () => {
      socket.write(request)
    })
    let buffer = ''
    socket.setEncoding('utf8')
    socket.setTimeout(NOTIFY_TIMEOUT_MS)
    socket.on('data', (chunk: string) => {
      buffer += chunk
      const nl = buffer.indexOf('\n')
      if (nl === -1) return
      socket.end()
      try {
        resolve(JSON.parse(buffer.slice(0, nl)) as ScriptNotifyResult)
      } catch (e) {
        reject(new Error(`Malformed response from spaceterm server: ${(e as Error).message}`))
      }
    })
    socket.on('timeout', () => {
      socket.destroy()
      reject(new Error(`Connection to spaceterm server timed out after ${NOTIFY_TIMEOUT_MS}ms`))
    })
    socket.on('error', (err) => {
      reject(new Error(`Failed to connect to spaceterm server at ${SCRIPTS_SOCKET_PATH}: ${err.message}`))
    })
  })
}
