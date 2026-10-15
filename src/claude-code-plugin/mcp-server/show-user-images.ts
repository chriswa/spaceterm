import * as fs from 'fs'
import * as net from 'net'
import * as path from 'path'
import * as os from 'os'
import { z } from 'zod'
import { defineTool } from './stdio-mcp.js'
import { requireSurfaceId } from './surface-env.js'
import { imageType } from '../../shared/image-type.js'

const SOCKET_PATH = process.env.SPACETERM_HOME
  ? path.join(process.env.SPACETERM_HOME, 'hooks.sock')
  : path.join(os.homedir(), '.spaceterm', 'hooks.sock')
const TIMEOUT_MS = 3000
/** As the server's own limit (`MAX_IMAGE_BYTES`): refused here, the agent hears why. */
const MAX_IMAGE_BYTES = 25 * 1024 * 1024
const MAX_IMAGES = 12

/**
 * Each picture as an absolute path, or why it cannot be shown. Checked here
 * because the hooks socket answers nothing: a bad path the server found
 * would be lost, where one found here goes back to the agent to fix.
 */
export function checkImages(
  images: ReadonlyArray<{ path: string; caption?: string }>,
  cwd: string,
  read: (file: string) => { size: number; head: Uint8Array } = readHead,
): { ok: Array<{ path: string; caption?: string }>; problems: string[] } {
  const ok: Array<{ path: string; caption?: string }> = []
  const problems: string[] = []
  for (const image of images) {
    const file = path.resolve(cwd, image.path)
    let found: { size: number; head: Uint8Array }
    try { found = read(file) } catch (err) {
      problems.push(`${image.path}: cannot be read (${err instanceof Error ? err.message : String(err)})`)
      continue
    }
    if (found.size > MAX_IMAGE_BYTES) problems.push(`${image.path}: ${Math.round(found.size / 1024 / 1024)} MB is over the ${MAX_IMAGE_BYTES / 1024 / 1024} MB limit`)
    else if (!imageType(found.head)) problems.push(`${image.path}: not a PNG, JPEG, GIF or WebP image`)
    else ok.push({ path: file, ...(image.caption?.trim() ? { caption: image.caption.trim() } : {}) })
  }
  return { ok, problems }
}

function readHead(file: string): { size: number; head: Uint8Array } {
  const fd = fs.openSync(file, 'r')
  try {
    const head = Buffer.alloc(16)
    const got = fs.readSync(fd, head, 0, head.length, 0)
    return { size: fs.fstatSync(fd).size, head: head.subarray(0, got) }
  } finally {
    fs.closeSync(fd)
  }
}

export const showUserImagesTool = defineTool({
  name: 'show_user_images',
  description:
    'Shows the user one or more pictures, such as screenshots of a visual change you just made, in the transcript of Control, ' +
    'their voice assistant, on their Mac and their phone. Control tells them aloud that you have pictures for them, but it cannot see the pictures; ' +
    'it only knows how many there are and their captions. Use it when the user would want to see what something looks like. ' +
    'Give each picture a short caption saying what it shows, since the captions are all Control can tell the user about it. ' +
    'The files are copied when you call this, so you may overwrite them afterwards.',
  inputSchema: z.object({
    images: z.array(z.object({
      path: z.string().describe('Absolute path to a PNG, JPEG, GIF or WebP file'),
      caption: z.string().optional().describe('A few words saying what this picture shows'),
    })).min(1).max(MAX_IMAGES).describe('The pictures, in the order to show them'),
    summary: z.string().optional().describe('One sentence about the pictures as a whole, such as what changed'),
  }),
  async handler({ images, summary }) {
    const surfaceId = requireSurfaceId()
    const { ok, problems } = checkImages(images, process.cwd())
    if (!ok.length) throw new Error(`No picture could be shown:\n${problems.join('\n')}`)

    const message = JSON.stringify({ type: 'show-user-images', surfaceId, images: ok, ...(summary?.trim() ? { summary: summary.trim() } : {}) }) + '\n'

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

    const shown = `${ok.length === 1 ? 'The picture is' : `${ok.length} pictures are`} in Control's transcript for the user.`
    return {
      content: [{ type: 'text' as const, text: problems.length ? `${shown} Not shown:\n${problems.join('\n')}` : shown }],
    }
  },
})
