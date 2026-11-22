/**
 * PreToolUse hook for Claude Code's built-in PushNotification.
 *
 * Claude Code drops a PushNotification whenever this terminal is "active",
 * which in Spaceterm says nothing about whether the user is looking: the Mac
 * may have it open while the user is away with their phone. So inside a
 * Spaceterm surface the hook sends the message through Spaceterm instead —
 * the same path as the `notify_user` tool, which always reaches the phone —
 * and denies the original call so it is never sent twice, telling the agent
 * how it went. Outside a Spaceterm surface it lets the call through untouched.
 */
import { isSpacetermUuid } from '../mcp-server/surface-env.js'
import { notifyPhone } from '../mcp-server/notify-phone.js'

interface PreToolUseInput {
  tool_name?: string
  tool_input?: { message?: unknown }
}

function decide(decision: 'deny', reason: string): void {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: reason },
  }) + '\n')
}

async function readStdin(): Promise<string> {
  let data = ''
  for await (const chunk of process.stdin) data += chunk
  return data
}

async function main(): Promise<void> {
  const surfaceId = process.env.SPACETERM_SURFACE_ID
  if (!isSpacetermUuid(surfaceId)) return
  const input = JSON.parse(await readStdin()) as PreToolUseInput
  if (input.tool_name !== 'PushNotification') return
  const message = typeof input.tool_input?.message === 'string' ? input.tool_input.message.trim() : ''
  if (!message) return

  try {
    const result = await notifyPhone(surfaceId, message)
    if (result.type !== 'script-notify-result') {
      decide('deny', `Spaceterm sends notifications in place of PushNotification, and it refused this one: ${JSON.stringify(result)}`)
      return
    }
    decide('deny', result.reached
      ? `Not sent by PushNotification: Spaceterm sent it to the user's phone instead (${result.outcome}). Nothing more to do; do not retry.`
      : `Not sent by PushNotification: Spaceterm sends it instead, and it ${result.outcome}.`)
  } catch (err) {
    decide('deny', `Spaceterm sends notifications in place of PushNotification, and could not: ${(err as Error).message}`)
  }
}

void main()
