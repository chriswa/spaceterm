import * as net from 'net'
import * as path from 'path'
import * as os from 'os'
import { z } from 'zod'
import { defineTool } from './stdio-mcp.js'
import { requireSurfaceId } from './surface-env.js'

const SOCKET_PATH = process.env.SPACETERM_HOME
  ? path.join(process.env.SPACETERM_HOME, 'hooks.sock')
  : path.join(os.homedir(), '.spaceterm', 'hooks.sock')
const TIMEOUT_MS = 3000

export const emitMarkdownOnParentTool = defineTool({
  name: 'emit_markdown_on_parent',
  description:
    'Creates a markdown card on this surface\'s PARENT surface (the nearest ancestor terminal, ' +
    'skipping intermediate nodes such as title cards) instead of on this surface. ' +
    'Used by the fork-handoff skill to place a summary card on the surface a fork branched from, ' +
    'where the user can review it and click "Ship it" to inject it into that parent conversation. ' +
    'Fails if this surface has no ancestor terminal to attach to.',
  inputSchema: z.object({
    content: z.string().describe('Markdown content to display on the parent surface\'s card'),
  }),
  async handler({ content }) {
    const surfaceId = requireSurfaceId()

    const message = JSON.stringify({ type: 'emit-markdown-on-parent', surfaceId, content }) + '\n'

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
      content: [{ type: 'text' as const, text: 'Markdown card created on parent surface.' }],
    }
  },
})
