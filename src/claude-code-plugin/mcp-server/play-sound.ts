import * as net from 'net'
import * as path from 'path'
import * as os from 'os'
import { z } from 'zod'
import { defineTool } from './stdio-mcp.js'
import { SOUND_NAMES } from '../../shared/protocol.js'

const SOCKET_PATH = process.env.SPACETERM_HOME
  ? path.join(process.env.SPACETERM_HOME, 'hooks.sock')
  : path.join(os.homedir(), '.spaceterm', 'hooks.sock')
const TIMEOUT_MS = 3000

export const playSoundTool = defineTool({
  name: 'play_sound',
  description:
    'IMPORTANT: Only use this tool when the user explicitly asks you to play a sound. ' +
    'Plays a sound effect in the spaceterm client. Available sounds: ' + SOUND_NAMES.join(', ') + '.',
  inputSchema: z.object({
    sound: z.enum(SOUND_NAMES).describe('Which sound effect to play'),
  }),
  async handler({ sound }) {
    const surfaceId = process.env.SPACETERM_SURFACE_ID
    if (!surfaceId) {
      return {
        content: [{ type: 'text' as const, text: 'Error: SPACETERM_SURFACE_ID environment variable is not set. This tool only works inside a spaceterm terminal.' }],
        isError: true,
      }
    }

    const message = JSON.stringify({ type: 'play-sound', surfaceId, sound }) + '\n'

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

    return {
      content: [{ type: 'text' as const, text: `Sound "${sound}" played successfully.` }],
    }
  },
})
