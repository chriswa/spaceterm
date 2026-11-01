import * as net from 'net'
import * as path from 'path'
import * as os from 'os'
import { z } from 'zod'
import { defineTool } from './stdio-mcp.js'
import { isSpacetermUuid } from './surface-env.js'
import type { ScriptGetLocationResult } from '../../shared/protocol.js'

// Queries go to the request/response scripts socket, not the fire-and-forget hooks socket.
const SCRIPTS_SOCKET_PATH = process.env.SPACETERM_HOME
  ? path.join(process.env.SPACETERM_HOME, 'scripts.sock')
  : path.join(os.homedir(), '.spaceterm', 'scripts.sock')
/** Past the server's own deadline (LOCATION_DEADLINE_MS, 20 s), so its reason arrives first. */
const TIMEOUT_MS = 25_000

export const getUserLocationTool = defineTool({
  name: 'get_user_location',
  description:
    "Returns the user's current position — latitude, longitude, accuracy in metres and how old the reading is — " +
    "read from the device they are using: the Spaceterm iPhone app or Mac client, whichever holds Control or was used last. " +
    'Use it only when the task needs to know where the user is (local weather, nearby places, distances, time zones). ' +
    'Takes a few seconds, up to 20 when a device has to find a GPS fix. ' +
    'Fails with each device’s reason when none can give one, such as location permission being off.',
  inputSchema: z.object({}),
  async handler() {
    const surfaceId = process.env.SPACETERM_SURFACE_ID
    const request = JSON.stringify({
      type: 'script-get-location',
      seq: 1,
      ...(isSpacetermUuid(surfaceId) ? { surfaceId } : {}),
    }) + '\n'

    const result = await new Promise<ScriptGetLocationResult>((resolve, reject) => {
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
          resolve(JSON.parse(buffer.slice(0, nl)) as ScriptGetLocationResult)
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

    if (!result.location) {
      return {
        content: [{ type: 'text' as const, text: result.error ?? 'No location was returned.' }],
        isError: true,
      }
    }

    const { device, latitude, longitude, accuracyMeters, altitudeMeters, timestamp } = result.location
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          latitude,
          longitude,
          accuracyMeters: Math.round(accuracyMeters),
          ...(altitudeMeters === undefined ? {} : { altitudeMeters: Math.round(altitudeMeters) }),
          capturedAt: new Date(timestamp).toISOString(),
          ageSeconds: Math.max(0, Math.round((Date.now() - timestamp) / 1000)),
          device,
        }, null, 2),
      }],
    }
  },
})
