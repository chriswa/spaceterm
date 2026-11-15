import { spawn } from 'child_process'

/**
 * The `ai-spend` CLI, for Control's agent_usage tool: AI Spend Tracker's
 * latest readings of Claude usage windows and agent spend, as JSON. It reads
 * the app's saved readings rather than fetching, so it answers in a moment.
 *
 * Only signed-in accounts are listed; any others are named in its
 * `omittedAccounts`, which is passed on with the rest.
 */

const AI_SPEND_TIMEOUT_MS = 10_000

/**
 * Runs `ai-spend` in `env`, whose login-shell PATH finds it (a symlink in
 * `/opt/homebrew/bin` to claude-usage-tracker's `scripts/ai-spend`), and
 * resolves with its JSON as printed. Rejects with why it could not.
 */
export function aiSpendRunner(env: () => NodeJS.ProcessEnv): () => Promise<string> {
  return () => new Promise((resolve, reject) => {
    const child = spawn('ai-spend', [], { env: env(), timeout: AI_SPEND_TIMEOUT_MS })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', (err) => reject(new Error(`could not run ai-spend: ${err.message}`)))
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `ai-spend exited with code ${code}`))
        return
      }
      try {
        JSON.parse(stdout)
      } catch {
        reject(new Error('ai-spend printed something other than JSON'))
        return
      }
      resolve(stdout.trim())
    })
  })
}
