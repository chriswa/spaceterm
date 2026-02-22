import * as net from 'net'
import * as path from 'path'
import * as os from 'os'
import { z } from 'zod'
import { defineTool } from './stdio-mcp.js'

const SOCKET_PATH = process.env.SPACETERM_HOME
  ? path.join(process.env.SPACETERM_HOME, 'hooks.sock')
  : path.join(os.homedir(), '.spaceterm', 'hooks.sock')
const TIMEOUT_MS = 3000

export const spawnClaudeSurfaceTool = defineTool({
  name: 'spawn_claude_surface',
  description:
    'IMPORTANT: Only use this tool when the user explicitly uses the phrase "spawn claude surface" in their message. ' +
    'The new surface will start a Claude Code session with the given prompt and title. ' +
    'This is fire-and-forget — you will not receive the new session\'s ID or be able to interact with it.',
  inputSchema: z.object({
    prompt: z.string().describe('The prompt to send to the new Claude Code session'),
    title: z.string().describe('The title for the new terminal node on the canvas'),
  }),
  async handler({ prompt, title }) {
    const surfaceId = process.env.SPACETERM_SURFACE_ID
    if (!surfaceId) {
      return {
        content: [{ type: 'text' as const, text: 'Error: SPACETERM_SURFACE_ID environment variable is not set. This tool only works inside a spaceterm terminal.' }],
        isError: true,
      }
    }

    const message = JSON.stringify({ type: 'spawn-claude-surface', surfaceId, prompt, title }) + '\n'

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
      content: [{ type: 'text' as const, text: `Claude surface "${title}" spawned successfully.` }],
    }
  },
})
