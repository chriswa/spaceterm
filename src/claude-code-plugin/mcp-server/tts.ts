import * as net from 'net'
import * as path from 'path'
import * as os from 'os'
import { z } from 'zod'
import { defineTool } from './stdio-mcp.js'
import { requireSurfaceId } from './surface-env.js'
import { REAL_VOICE_OPERATOR_DEPS } from '../../server/voice-operator.js'

const SOCKET_PATH = process.env.SPACETERM_HOME
  ? path.join(process.env.SPACETERM_HOME, 'hooks.sock')
  : path.join(os.homedir(), '.spaceterm', 'hooks.sock')
const TIMEOUT_MS = 3000

export const ttsTool = defineTool({
  name: 'TTS',
  description:
    'IMPORTANT: Only use this tool when the user explicitly asks for text-to-speech, speech, or to speak aloud. ' +
    'Speaks text through the spaceterm client\'s text-to-speech engine.',
  inputSchema: z.object({
    text: z.string().max(2000).describe('The text to speak aloud (max 2000 characters)'),
  }),
  async handler({ text }) {
    const surfaceId = requireSurfaceId()

    // Checked here, before the write, because this socket is one-way: the
    // server never answers, so nothing downstream can tell the caller that the
    // speech engine was missing. Reporting success regardless is what let a
    // dead engine look like a working one for weeks — an agent said "done",
    // and no sound was ever made.
    if (!REAL_VOICE_OPERATOR_DEPS.readDiscovery()) {
      return {
        isError: true,
        content: [{
          type: 'text' as const,
          text: 'Voice Operator is not running, so nothing can be spoken. '
            + 'Tell the user rather than assuming they heard this.',
        }],
      }
    }

    const message = JSON.stringify({ type: 'speak', surfaceId, text }) + '\n'

    await new Promise<void>((resolve, reject) => {
      const socket = net.createConnection(SOCKET_PATH, () => {
        socket.write(message, () => {
          socket.end()
          resolve()
        })
      })
      socket.setTimeout(TIMEOUT_MS)
      socket.on('timeout', () => {
        socket.destroy()
        reject(new Error(`Connection to spaceterm server timed out after ${TIMEOUT_MS}ms`))
      })
      socket.on('error', (err) => {
        reject(new Error(`Failed to connect to spaceterm server at ${SOCKET_PATH}: ${err.message}`))
      })
    })

    // "Handed to", not "spoke": this call ends when the socket write does, and
    // playback outlives it. Voice Operator may still mute or drop the job.
    return {
      content: [{ type: 'text' as const, text: `Handed to Voice Operator to speak: "${text}"` }],
    }
  },
})
