import * as fs from 'fs'
import * as path from 'path'
import { spawn } from 'child_process'
import { homedir } from 'os'

const USER_MESSAGES_TO_SAMPLE = 3
const LOG_PATH = path.join(process.env.SPACETERM_HOME || path.join(homedir(), '.spaceterm'), 'title-summarizer.log')

function log(msg: string): void {
  const line = `${new Date().toISOString()} ${msg}\n`
  fs.appendFileSync(LOG_PATH, line)
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
  summarize(surfaceId: string, transcriptPath: string): void {
    setImmediate(() => this.run(surfaceId, transcriptPath))
  }

  private run(surfaceId: string, transcriptPath: string): void {
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
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        log(`ERROR: claude not found in PATH`)
      } else {
        log(`${surfaceId.slice(0, 8)}: spawn error: ${err.message}`)
      }
    })

    child.on('close', (code) => {
      if (code !== 0) {
        log(`${surfaceId.slice(0, 8)}: claude -p exited ${code} (stderr: ${stderr.trim()})`)
        return
      }

      const raw = stdout.trim()
      if (!raw) {
        log(`${surfaceId.slice(0, 8)}: empty response`)
        return
      }

      // Accept only the first line, strip non-printable characters
      const title = raw.split('\n')[0].replace(/[^\x20-\x7E]/g, '').trim()
      if (!title) {
        log(`${surfaceId.slice(0, 8)}: unusable response: ${JSON.stringify(raw)}`)
        return
      }

      log(`${surfaceId.slice(0, 8)}: injecting title "${title}"`)
      this.deps.injectTitle(surfaceId, title)
    })
  }
}
