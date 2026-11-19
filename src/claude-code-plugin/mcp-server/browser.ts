import * as net from 'net'
import * as path from 'path'
import * as os from 'os'
import { z } from 'zod'
import { defineTool } from './stdio-mcp.js'
import { isSpacetermUuid } from './surface-env.js'
import type { ScriptAddCardResult, ScriptEditCardResult } from '../../shared/protocol.js'

const SCRIPTS_SOCKET_PATH = process.env.SPACETERM_HOME
  ? path.join(process.env.SPACETERM_HOME, 'scripts.sock')
  : path.join(os.homedir(), '.spaceterm', 'scripts.sock')
const TIMEOUT_MS = 5_000

/** This agent's card on the canvas: where its browser cards hang. */
function requireNodeId(): string {
  const nodeId = process.env.SPACETERM_NODE_ID
  if (!isSpacetermUuid(nodeId)) {
    throw new Error('SPACETERM_NODE_ID is not set to a node id. This tool only works inside a Spaceterm terminal.')
  }
  return nodeId
}

/** One request on the scripts socket, and its reply. */
function request<T>(message: Record<string, unknown>): Promise<T> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(SCRIPTS_SOCKET_PATH, () => {
      socket.write(JSON.stringify({ seq: 1, ...message }) + '\n')
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
        resolve(JSON.parse(buffer.slice(0, nl)) as T)
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
}

const text = (value: string, isError = false) => ({ content: [{ type: 'text' as const, text: value }], ...(isError ? { isError } : {}) })

export const openBrowserTool = defineTool({
  name: 'open_browser',
  description:
    "Opens a web page in a browser card on the Spaceterm canvas, beside this agent's terminal, for the user to look at and use on their Mac or phone. " +
    "profile 'chrome' (the default) opens it in the user's own Chrome, signed in to whatever they are signed in to; " +
    "'isolated' opens it in a separate browser that shares nothing with theirs. " +
    'Use it when the user asks to see or open a page. Returns the card\'s node id, for navigate_browser. ' +
    'This shows the page to the user; it does not give you its contents.',
  inputSchema: z.object({
    url: z.string().describe('An http or https address'),
    profile: z.enum(['chrome', 'isolated']).optional().describe("Whose browser: 'chrome' (the user's own, the default) or 'isolated'"),
  }),
  async handler({ url, profile }) {
    const reply = await request<ScriptAddCardResult>({ type: 'script-add-browser', parentId: requireNodeId(), url, profile: profile ?? 'chrome' })
    if (!reply.nodeId) return text(`Spaceterm did not open it: ${reply.error ?? JSON.stringify(reply)}`, true)
    return text(`Opened ${url} in browser card ${reply.nodeId}.`)
  },
})

export const navigateBrowserTool = defineTool({
  name: 'navigate_browser',
  description: 'Sends a browser card that open_browser made to another address. The user sees it change.',
  inputSchema: z.object({
    node_id: z.string().describe('The browser card, as open_browser returned it'),
    url: z.string().describe('An http or https address'),
  }),
  async handler({ node_id, url }) {
    const reply = await request<ScriptEditCardResult>({ type: 'script-navigate-browser', nodeId: node_id, url })
    if (!reply.ok) return text(`Spaceterm did not navigate it: ${reply.error ?? JSON.stringify(reply)}`, true)
    return text(`Browser card ${node_id} is going to ${url}.`)
  },
})
