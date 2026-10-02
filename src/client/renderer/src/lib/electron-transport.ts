import type { ServerPipeBridge } from '../../../../shared/api'
import type { ServerTransport, TransportHandlers } from '../../../../shared/server-client'

/**
 * The Electron renderer's way to the server: main's byte pipe to the Unix
 * socket (`src/client/main/server-pipe.ts`).
 *
 * Attempt ids are unique per page load, not just per attempt, so events still
 * in flight from a previous page's socket can never be mistaken for ours.
 */
export function electronTransport(pipe: ServerPipeBridge): ServerTransport {
  const pageId = Math.random().toString(36).slice(2)
  let counter = 0
  let attempt: string | null = null
  let handlers: TransportHandlers | null = null

  pipe.onEvent((eventAttempt, kind, chunk) => {
    if (eventAttempt !== attempt || !handlers) return
    if (kind === 'open') handlers.onOpen()
    else if (kind === 'data') handlers.onData(chunk ?? '')
    else {
      const ended = handlers
      handlers = null
      attempt = null
      ended.onClose()
    }
  })

  return {
    open(next) {
      handlers = next
      attempt = `${pageId}-${++counter}`
      pipe.open(attempt)
    },
    send: (text) => pipe.send(text),
    close() {
      handlers = null
      attempt = null
      pipe.close()
    }
  }
}
