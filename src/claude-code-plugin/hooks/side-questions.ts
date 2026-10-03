import type { Register } from 'claude-code'

/**
 * Side questions from Spaceterm's receptionist, answered inside this agent.
 *
 * Long-polls the Spaceterm server for questions addressed to this surface and
 * answers each with `$.model.fork`: this session's own last request again —
 * same model, system prompt, tools and history — with the question after it.
 * No tools, nothing written to the transcript or the prompt cache, and the
 * agent's own work is never interrupted, so the receptionist can ask an agent
 * something at the price of reading its context from the cache.
 *
 * The server side is `src/server/side-questions.ts`. Outside a Spaceterm
 * surface (no `SPACETERM_SURFACE_ID`) this does nothing.
 */

/** Back off this long when the server cannot be reached, as when it is restarting. */
const RETRY_MS = 5_000

let running = false

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    if (running) return result
    const surface = await $.env.get('SPACETERM_SURFACE_ID')
    if (!surface) return result
    running = true
    const home = (await $.env.get('SPACETERM_HOME')) ?? `${await $.env.get('HOME')}/.spaceterm`
    const socketPath = `${home}/side-questions.sock`
    const nextUrl = `http://spaceterm/v1/side-questions/next?surface=${encodeURIComponent(surface)}`

    // One long poll at a time, each on a timer of its own: a timer's dispatch
    // may wait on the network as long as it likes, and the chain ends with the
    // module, so a reload never leaves two loops polling.
    const poll = async (): Promise<void> => {
      let delay = 0
      try {
        const response = await $.http.fetch(nextUrl, { socketPath })
        if (response.status === 200 && response.text) {
          const { id, prompt } = JSON.parse(response.text) as { id: string; prompt: string }
          const t0 = Date.now()
          const reply = await $.model.fork({ prompt })
          await $.http.fetch('http://spaceterm/v1/side-questions/answer', {
            method: 'POST', socketPath, body: JSON.stringify({ id, result: reply, ms: Date.now() - t0 }),
          })
        } else if (response.status !== 204) {
          delay = RETRY_MS
        }
      } catch {
        delay = RETRY_MS
      }
      $.clock.after(delay, poll)
    }
    $.clock.after(0, poll)
    return result
  })
}
