import * as net from 'net'
import * as path from 'path'
import * as os from 'os'
import { z } from 'zod'
import { defineTool } from './stdio-mcp.js'

const SOCKET_PATH = path.join(os.homedir(), '.spaceterm', 'spaceterm.sock')
const TIMEOUT_MS = 3000

export const emitMarkdownTool = defineTool({
  name: 'emit_markdown',
  description:
    'Create a markdown card on the spaceterm canvas, parented on the terminal that spawned this Claude Code session. ' +
    'Use this to display rich formatted output like summaries, tables, or structured data outside the terminal.',
  inputSchema: z.object({
    content: z.string().describe('Markdown content to display on the card'),
  }),
  async handler({ content }) {
    const surfaceId = process.env.SPACETERM_SURFACE_ID
    if (!surfaceId) {
      return {
        content: [{ type: 'text' as const, text: 'Error: SPACETERM_SURFACE_ID environment variable is not set. This tool only works inside a spaceterm terminal.' }],
        isError: true,
      }
    }

    const message = JSON.stringify({ type: 'emit-markdown', surfaceId, content }) + '\n'

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
      content: [{ type: 'text' as const, text: 'Markdown card created successfully.' }],
    }
  },
})
