import * as net from 'net'
import * as path from 'path'
import * as os from 'os'
import { z } from 'zod'
import { defineTool } from './stdio-mcp.js'
import { requireSurfaceId } from './surface-env.js'

// Queries go to the request/response scripts socket, not the fire-and-forget hooks socket.
const SCRIPTS_SOCKET_PATH = process.env.SPACETERM_HOME
  ? path.join(process.env.SPACETERM_HOME, 'scripts.sock')
  : path.join(os.homedir(), '.spaceterm', 'scripts.sock')
const TIMEOUT_MS = 3000

interface ResolveHandoffResult {
  type: 'script-resolve-handoff-result'
  seq: number
  transcriptPath?: string
  isFork?: boolean
  targetSurface?: { nodeId: string; title: string | null; alive: boolean } | null
  error?: string
}

export const resolveHandoffContextTool = defineTool({
  name: 'resolve_handoff_context',
  description:
    'Returns the context needed to build a fork handoff, resolved server-side from spaceterm\'s live node tree: ' +
    '`transcriptPath` (this surface\'s current Claude transcript on disk), ' +
    '`isFork` (whether that transcript carries fork markers), and ' +
    '`targetSurface` (the nearest ancestor terminal — the parent surface a handoff would ship to — or null if none). ' +
    'Call this first from the fork-handoff distiller; abort if isFork is false or targetSurface is null.',
  inputSchema: z.object({}),
  async handler() {
    const surfaceId = requireSurfaceId()

    // Pass our pty-level surface id; the server resolves it to a node id (it is
    // NOT itself a node id after a terminal restart).
    const request = JSON.stringify({ type: 'script-resolve-handoff', seq: 1, surfaceId }) + '\n'

    const result = await new Promise<ResolveHandoffResult>((resolve, reject) => {
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
          resolve(JSON.parse(buffer.slice(0, nl)) as ResolveHandoffResult)
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

    if (result.error) {
      return {
        content: [{ type: 'text' as const, text: `Error resolving handoff context: ${result.error}` }],
        isError: true,
      }
    }

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          transcriptPath: result.transcriptPath ?? null,
          isFork: result.isFork ?? false,
          targetSurface: result.targetSurface ?? null,
        }, null, 2),
      }],
    }
  },
})
