import * as net from 'net'
import * as path from 'path'
import * as os from 'os'
import { z } from 'zod'
import { defineTool } from './stdio-mcp.js'
import { requireSurfaceId } from './surface-env.js'
import type { ScriptNotifyResult } from '../../shared/protocol.js'

// A request/response on the scripts socket, so the tool can say whether a phone was reached.
const SCRIPTS_SOCKET_PATH = process.env.SPACETERM_HOME
  ? path.join(process.env.SPACETERM_HOME, 'scripts.sock')
  : path.join(os.homedir(), '.spaceterm', 'scripts.sock')
/** Past Apple's own request timeout (10 s in src/server/apns.ts), so the server's answer arrives first. */
const TIMEOUT_MS = 15_000

export const notifyUserTool = defineTool({
  name: 'notify_user',
  description:
    "Sends a notification to the user's phone through the Spaceterm iPhone app, titled with this agent's name; tapping it opens this terminal. " +
    'Use it when the user asks to be notified or pinged, or asked to be told when something finishes. ' +
    'Use it instead of PushNotification, which sends nothing while this terminal has focus; this always goes to the phone. ' +
    'Not for a question you need answered: asking it (AskUserQuestion) already notifies the phone. ' +
    'Says whether a phone was reached, and if not, why.',
  inputSchema: z.object({
    body: z.string().min(1).max(800).describe('What the notification says, short enough to read at a glance'),
  }),
  async handler({ body }) {
    const surfaceId = requireSurfaceId()
    const request = JSON.stringify({ type: 'script-notify', seq: 1, surfaceId, body }) + '\n'

    const result = await new Promise<ScriptNotifyResult>((resolve, reject) => {
      const socket = net.createConnection(SCRIPTS_SOCKET_PATH, () => {
        socket.write(request)
      })
      let buffer = ''
      socket.setEncoding('utf8')
      socket.setTimeout(TIMEOUT_MS)
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
        reject(new Error(`Connection to spaceterm server timed out after ${TIMEOUT_MS}ms`))
      })
      socket.on('error', (err) => {
        reject(new Error(`Failed to connect to spaceterm server at ${SCRIPTS_SOCKET_PATH}: ${err.message}`))
      })
    })

    if (result.type !== 'script-notify-result') {
      return { content: [{ type: 'text' as const, text: `Spaceterm refused it: ${JSON.stringify(result)}` }], isError: true }
    }
    return {
      content: [{ type: 'text' as const, text: `Notification ${result.outcome}.` }],
      ...(result.reached ? {} : { isError: true }),
    }
  },
})
