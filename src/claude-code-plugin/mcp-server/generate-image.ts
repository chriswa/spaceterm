import * as net from 'net'
import * as path from 'path'
import * as os from 'os'
import * as fs from 'fs'
import * as crypto from 'crypto'
import { execFile } from 'child_process'
import { z } from 'zod'
import { defineTool } from './stdio-mcp.js'

const SPACETERM_HOME = process.env.SPACETERM_HOME ?? path.join(os.homedir(), '.spaceterm')
const SOCKET_PATH = path.join(SPACETERM_HOME, 'spaceterm.sock')
const GENERATED_IMAGES_DIR = path.join(SPACETERM_HOME, 'generated-images')
const SOCKET_TIMEOUT_MS = 3000
const GENERATE_TIMEOUT_MS = 3 * 60 * 1000 // 3 minutes

export const generateImageTool = defineTool({
  name: 'generate_image',
  description:
    'Generate an image using mflux and add it as an image node on the canvas, parented to the calling Claude surface.',
  inputSchema: z.object({
    prompt: z.string().describe('Text prompt describing the image to generate'),
    size: z.number().describe('Width and height in pixels (used for both dimensions). Must be a multiple of 32, minimum 256, maximum 1440.'),
    remove_background: z.boolean().describe('Whether to remove the background using rembg after generation'),
  }),
  async handler({ prompt, size, remove_background }) {
    const surfaceId = process.env.SPACETERM_SURFACE_ID
    if (!surfaceId) {
      return {
        content: [{ type: 'text' as const, text: 'Error: SPACETERM_SURFACE_ID environment variable is not set. This tool only works inside a spaceterm terminal.' }],
        isError: true,
      }
    }

    // Flux requires dimensions: multiple of 32, min 256, max 1440
    if (size < 256 || size > 1440 || size % 32 !== 0) {
      return {
        content: [{ type: 'text' as const, text: `Error: size must be a multiple of 32 between 256 and 1440 (got ${size}).` }],
        isError: true,
      }
    }

    fs.mkdirSync(GENERATED_IMAGES_DIR, { recursive: true })

    const filename = crypto.randomUUID() + '.png'
    const filePath = path.join(GENERATED_IMAGES_DIR, filename)

    // Run mflux-generate
    await new Promise<void>((resolve, reject) => {
      execFile(
        'mflux-generate-z-image-turbo',
        [
          '--prompt', prompt,
          '--width', String(size),
          '--height', String(size),
          '--steps', '4',
          '-q', '8',
          '--output', filePath,
        ],
        { timeout: GENERATE_TIMEOUT_MS },
        (err, _stdout, stderr) => {
          if (err) reject(new Error(`mflux-generate failed: ${err.message}`))
          else {
            // mflux can exit 0 but produce a 0-byte file on failure
            try {
              const stat = fs.statSync(filePath)
              if (stat.size === 0) {
                reject(new Error(`mflux-generate produced an empty file. stderr: ${stderr}`))
                return
              }
            } catch {
              reject(new Error(`mflux-generate did not produce an output file. stderr: ${stderr}`))
              return
            }
            resolve()
          }
        }
      )
    })

    // Optionally remove background
    if (remove_background) {
      const rembgOutput = filePath + '.rembg.png'
      await new Promise<void>((resolve, reject) => {
        execFile(
          'rembg',
          ['i', filePath, rembgOutput],
          { timeout: GENERATE_TIMEOUT_MS },
          (err) => {
            if (err) reject(new Error(`rembg failed: ${err.message}`))
            else resolve()
          }
        )
      })
      fs.renameSync(rembgOutput, filePath)
    }

    // Send message to spaceterm server to create the image node
    const message = JSON.stringify({
      type: 'generate-image',
      surfaceId,
      filePath,
      width: size,
      height: size,
    }) + '\n'

    await new Promise<void>((resolve, reject) => {
      const socket = net.createConnection(SOCKET_PATH, () => {
        socket.write(message, () => {
          socket.end()
          resolve()
        })
      })
      socket.setTimeout(SOCKET_TIMEOUT_MS)
      socket.on('timeout', () => {
        socket.destroy()
        reject(new Error(`Connection to spaceterm server timed out after ${SOCKET_TIMEOUT_MS}ms`))
      })
      socket.on('error', (err) => {
        reject(new Error(`Failed to connect to spaceterm server at ${SOCKET_PATH}: ${err.message}`))
      })
    })

    return {
      content: [{ type: 'text' as const, text: `Image generated successfully and added to canvas.` }],
    }
  },
})
