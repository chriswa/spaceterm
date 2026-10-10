/**
 * Render the input of a tool whose input *is* the user-facing message.
 *
 * Most tool calls (Bash, Grep, …) are machinery and stay out of what a
 * listener is told. Three are not: `ExitPlanMode` and Cursor's `CreatePlan` carry a
 * whole plan, and `AskUserQuestion` carries the decision the listener is being
 * asked to make. For those, dropping the tool call drops the message.
 *
 * `agent-transcript.ts` renders `tool_use` blocks read from a transcript
 * through this.
 *
 * Everything here treats its input as `unknown`. Transcripts are written by
 * another program, and a shape that has moved on should render nothing rather
 * than throw inside a transcript read.
 */

/** Tools whose input is the user-facing answer, keyed by how it is rendered. */
const PLAN_TOOLS = new Set(['CreatePlan', 'ExitPlanMode'])
const QUESTION_TOOLS = new Set(['AskUserQuestion'])

export function speakableToolText(name: unknown, input: unknown): string | undefined {
  if (typeof name !== 'string') return undefined
  if (!input || typeof input !== 'object') return undefined
  if (PLAN_TOOLS.has(name)) return planText(input as Record<string, unknown>)
  if (QUESTION_TOOLS.has(name)) return questionText(input as Record<string, unknown>)
  return undefined
}

function planText(input: Record<string, unknown>): string | undefined {
  const plan = text(input.plan)
  if (!plan) return undefined
  const name = text(input.name)
  const overview = text(input.overview)
  const sections: string[] = [name ? `Plan: ${name}` : 'Plan']
  if (overview) sections.push(overview)
  sections.push(plan)
  return sections.join('\n\n')
}

/**
 * Render an `AskUserQuestion` payload.
 *
 * The options are included, not just the questions. The listener's next move is
 * to pick one, and an account that says only "the agent asked about scope"
 * tells them nothing they can act on without going back to the screen.
 */
function questionText(input: Record<string, unknown>): string | undefined {
  const questions = Array.isArray(input.questions) ? input.questions : []
  const rendered: string[] = []
  for (const entry of questions) {
    if (!entry || typeof entry !== 'object') continue
    const question = text((entry as Record<string, unknown>).question)
    if (!question) continue
    const header = text((entry as Record<string, unknown>).header)
    const parts = [header ? `Question (${header}): ${question}` : `Question: ${question}`]
    const options = renderOptions((entry as Record<string, unknown>).options)
    if (options) parts.push(options)
    rendered.push(parts.join('\n'))
  }
  if (!rendered.length) return undefined
  return `The agent is asking the user to decide:\n\n${rendered.join('\n\n')}`
}

function renderOptions(raw: unknown): string | undefined {
  if (!Array.isArray(raw)) return undefined
  const lines: string[] = []
  for (const option of raw) {
    if (!option || typeof option !== 'object') continue
    const label = text((option as Record<string, unknown>).label)
    if (!label) continue
    const description = text((option as Record<string, unknown>).description)
    lines.push(description ? `- ${label}: ${description}` : `- ${label}`)
  }
  return lines.length ? lines.join('\n') : undefined
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}
