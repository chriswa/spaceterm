import * as fs from 'fs'
import * as path from 'path'
import { spawn } from 'child_process'
import { homedir } from 'os'

const USER_MESSAGES_TO_SAMPLE = 3
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
  input: string[]
  output: string | null
  error: string | null
}

function logJsonl(entry: TitleLogEntry): void {
  fs.appendFile(JSONL_PATH, JSON.stringify(entry) + '\n', () => {})
}

function extractUserText(content: unknown): string | null {
  if (typeof content === 'string') return content.trim() || null
  if (!Array.isArray(content)) return null
  const texts: string[] = []
  for (const block of content) {
    if (block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      texts.push(block.text)
    }
  }
  const joined = texts.join(' ').trim()
  return joined || null
}

function readLastUserMessages(transcriptPath: string, count: number): string[] {
  let raw: string
  try {
    raw = fs.readFileSync(transcriptPath, 'utf-8')
  } catch {
    return []
  }

  const texts: string[] = []
  for (const line of raw.split('\n')) {
    if (!line) continue
    try {
      const obj = JSON.parse(line)
      if (!obj || obj.type !== 'user') continue
      const text = extractUserText(obj.message?.content)
      if (text) texts.push(text)
    } catch {
      // Skip malformed lines
    }
  }

  return texts.slice(-count)
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
    const messages = readLastUserMessages(transcriptPath, USER_MESSAGES_TO_SAMPLE)
    if (messages.length === 0) {
      log(`${surfaceId.slice(0, 8)}: no user messages, skipping`)
      return
    }

    log(`${surfaceId.slice(0, 8)}: found ${messages.length} user messages, spawning claude -p`)
    const joined = messages.map((m, i) => `${i + 1}. ${m}`).join('\n')
    const prompt =
      `Summarize the following user messages in exactly 3 words. ` +
      `Output ONLY the 3 words, nothing else:\n\n${joined}`

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
      logJsonl({ ts, claudeSessionId, surfaceId, input: messages, output: null, error: errorMsg })
    })

    child.on('close', (code) => {
      if (code !== 0) {
        const errorMsg = `claude -p exited ${code} (stderr: ${stderr.trim()})`
        log(`${surfaceId.slice(0, 8)}: ${errorMsg}`)
        logJsonl({ ts, claudeSessionId, surfaceId, input: messages, output: null, error: errorMsg })
        return
      }

      const raw = stdout.trim()
      if (!raw) {
        log(`${surfaceId.slice(0, 8)}: empty response`)
        logJsonl({ ts, claudeSessionId, surfaceId, input: messages, output: null, error: 'empty response' })
        return
      }

      // Accept only the first line, strip non-printable characters
      const title = raw.split('\n')[0].replace(/[^\x20-\x7E]/g, '').trim()
      if (!title) {
        log(`${surfaceId.slice(0, 8)}: unusable response: ${JSON.stringify(raw)}`)
        logJsonl({ ts, claudeSessionId, surfaceId, input: messages, output: raw, error: 'unusable response' })
        return
      }

      log(`${surfaceId.slice(0, 8)}: injecting title "${title}"`)
      logJsonl({ ts, claudeSessionId, surfaceId, input: messages, output: title, error: null })
      this.deps.injectTitle(surfaceId, title)
    })
  }
}
