import { z } from 'zod'
import { defineTool } from './stdio-mcp.js'
import { requireSurfaceId } from './surface-env.js'
import { notifyPhone } from './notify-phone.js'

export const notifyUserTool = defineTool({
  name: 'notify_user',
  description:
    "Sends a notification to the user's phone through the Spaceterm iPhone app, titled with this agent's name; tapping it opens this terminal. " +
    'Use it when the user asks to be notified or pinged, or asked to be told when something finishes. ' +
    'Use it instead of PushNotification, which Claude Code holds back while this terminal is active; this always goes to the phone. ' +
    'Not for a question you need answered: asking it (AskUserQuestion) already notifies the phone. ' +
    'Says whether a phone was reached, and if not, why.',
  inputSchema: z.object({
    body: z.string().min(1).max(800).describe('What the notification says, short enough to read at a glance'),
  }),
  async handler({ body }) {
    const surfaceId = requireSurfaceId()
    const result = await notifyPhone(surfaceId, body)

    if (result.type !== 'script-notify-result') {
      return { content: [{ type: 'text' as const, text: `Spaceterm refused it: ${JSON.stringify(result)}` }], isError: true }
    }
    return {
      content: [{ type: 'text' as const, text: `Notification ${result.outcome}.` }],
      ...(result.reached ? {} : { isError: true }),
    }
  },
})
