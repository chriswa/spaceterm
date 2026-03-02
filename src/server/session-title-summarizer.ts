import * as fs from 'fs'
import * as path from 'path'
import { spawn } from 'child_process'
import { homedir } from 'os'

const SPACETERM_HOME = process.env.SPACETERM_HOME || path.join(homedir(), '.spaceterm')
const LOG_PATH = path.join(SPACETERM_HOME, 'title-summarizer.log')
const JSONL_PATH = path.join(SPACETERM_HOME, 'title-summarizer.jsonl')

function log(msg: string): void {
  const line = `${new Date().toISOString()} ${msg}\n`
  fs.appendFileSync(LOG_PATH, line)
}

interface TitleLogEntry {
  ts: string
  claudeSessionId: string
  surfaceId: string
  input: string
  output: string | null
  error: string | null
}

function logJsonl(entry: TitleLogEntry): void {
  fs.appendFile(JSONL_PATH, JSON.stringify(entry) + '\n', () => {})
}

function readLastUserMessage(transcriptPath: string): string | null {
  let raw: string
  try {
    raw = fs.readFileSync(transcriptPath, 'utf-8')
  } catch {
    return null
  }

  let last: string | null = null
  for (const line of raw.split('\n')) {
    if (!line) continue
    try {
      const obj = JSON.parse(line)
      if (!obj || obj.type !== 'user') continue
      // Human-typed messages have content as a string;
      // tool results have it as an array — skip those.
      const content = obj.message?.content
      if (typeof content !== 'string') continue
      const text = content.trim()
      if (text) last = text
    } catch {
      // Skip malformed lines
    }
  }

  return last
}

export interface SummarizerDeps {
  injectTitle(sessionId: string, title: string): void
}

export class SessionTitleSummarizer {
  private deps: SummarizerDeps

  constructor(deps: SummarizerDeps) {
    this.deps = deps
  }

  /** Fire-and-forget: read transcript, summarize, inject title. */
  summarize(surfaceId: string, transcriptPath: string, claudeSessionId: string): void {
    setImmediate(() => this.run(surfaceId, transcriptPath, claudeSessionId))
  }

  private run(surfaceId: string, transcriptPath: string, claudeSessionId: string): void {
    log(`${surfaceId.slice(0, 8)}: triggered, reading ${transcriptPath}`)
    const message = readLastUserMessage(transcriptPath)
    if (!message) {
      log(`${surfaceId.slice(0, 8)}: no user messages, skipping`)
      return
    }

    log(`${surfaceId.slice(0, 8)}: found last user message, spawning claude -p`)
    const prompt =
      `Summarize the following user messages in exactly 3 words. ` +
      `Output ONLY the 3 words, nothing else:\n\n${message}`

    const ts = new Date().toISOString()

    // stdio: 'ignore' stdin — claude -p hangs forever if stdin is a pipe because
    // it unconditionally waits for stdin EOF when process.stdin.isTTY is false.
    const child = spawn('claude', ['-p', prompt], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    child.stdout!.setEncoding('utf-8')
    child.stderr!.setEncoding('utf-8')
    child.stdout!.on('data', (d: string) => { stdout += d })
    child.stderr!.on('data', (d: string) => { stderr += d })

    child.on('error', (err) => {
      const errorMsg = (err as NodeJS.ErrnoException).code === 'ENOENT'
        ? 'claude not found in PATH'
        : `spawn error: ${err.message}`
      log(`${surfaceId.slice(0, 8)}: ${errorMsg}`)
      logJsonl({ ts, claudeSessionId, surfaceId, input: message, output: null, error: errorMsg })
    })

    child.on('close', (code) => {
      if (code !== 0) {
        const errorMsg = `claude -p exited ${code} (stderr: ${stderr.trim()})`
        log(`${surfaceId.slice(0, 8)}: ${errorMsg}`)
        logJsonl({ ts, claudeSessionId, surfaceId, input: message, output: null, error: errorMsg })
        return
      }

      const raw = stdout.trim()
      if (!raw) {
        log(`${surfaceId.slice(0, 8)}: empty response`)
        logJsonl({ ts, claudeSessionId, surfaceId, input: message, output: null, error: 'empty response' })
        return
      }

      // Accept only the first line, strip non-printable characters, truncate if too long
      const MAX_WORDS = 5
      const MAX_CHARS = 40
      let title = raw.split('\n')[0].replace(/[^\x20-\x7E]/g, '').trim()
      const words = title.split(/\s+/)
      if (words.length > MAX_WORDS) {
        title = words.slice(0, MAX_WORDS).join(' ') + '...'
      } else if (title.length > MAX_CHARS) {
        title = title.slice(0, MAX_CHARS) + '...'
      }
      if (!title) {
        log(`${surfaceId.slice(0, 8)}: unusable response: ${JSON.stringify(raw)}`)
        logJsonl({ ts, claudeSessionId, surfaceId, input: message, output: raw, error: 'unusable response' })
        return
      }

      log(`${surfaceId.slice(0, 8)}: injecting title "${title}"`)
      logJsonl({ ts, claudeSessionId, surfaceId, input: message, output: title, error: null })
      this.deps.injectTitle(surfaceId, title)
    })
  }
}
