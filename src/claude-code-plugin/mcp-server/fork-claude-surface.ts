import * as net from 'net'
import * as path from 'path'
import * as os from 'os'
import { z } from 'zod'
import { defineTool } from './stdio-mcp.js'

const SOCKET_PATH = process.env.SPACETERM_HOME
  ? path.join(process.env.SPACETERM_HOME, 'hooks.sock')
  : path.join(os.homedir(), '.spaceterm', 'hooks.sock')
const TIMEOUT_MS = 3000

export const forkClaudeSurfaceTool = defineTool({
  name: 'fork_claude_surface',
  description:
    'IMPORTANT: Only use this tool when the user explicitly uses the phrase "fork claude surface" in their message. ' +
    'Forks the current Claude session, creating a new terminal that inherits the full conversation history ' +
    'and receives the given prompt as its first new message. ' +
    'This is fire-and-forget — you will not receive the new session\'s ID or be able to interact with it.',
  inputSchema: z.object({
    prompt: z.string().describe('The prompt to send to the forked Claude Code session'),
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

    const message = JSON.stringify({ type: 'fork-claude-surface', surfaceId, prompt, title }) + '\n'

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
      content: [{ type: 'text' as const, text: `Claude surface "${title}" forked successfully.` }],
    }
  },
})
