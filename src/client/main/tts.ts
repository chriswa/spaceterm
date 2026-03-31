import { ipcMain } from 'electron'
import { spawn, execFileSync, ChildProcess } from 'child_process'
import * as os from 'os'
import * as path from 'path'
import { log } from './logger'

let currentProcess: ChildProcess | null = null

/** Expand PATH so GUI-launched Electron can find cartesia-read, uv, and ffplay. */
function spawnPath(): string {
  const base = process.env.PATH || ''
  const extra = [
    path.join(os.homedir(), '.local', 'bin'),
    path.join(os.homedir(), 'cartesia-read'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ].filter((d) => !base.split(':').includes(d))
  return [...extra, base].join(':')
}

/** Recursively SIGKILL a process and all its descendants (leaf-first). */
function killTree(pid: number): void {
  // Find direct children
  try {
    const out = execFileSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' })
    for (const line of out.trim().split('\n')) {
      const child = parseInt(line, 10)
      if (child) killTree(child)
    }
  } catch {
    // no children
  }
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    // already dead
  }
}

function killCurrentProcess(): void {
  if (currentProcess) {
    const proc = currentProcess
    currentProcess = null
    if (proc.pid) {
      log(`[TTS] killing process tree (root pid ${proc.pid})`)
      killTree(proc.pid)
    }
  }
}

export function setupTTSHandlers(): void {
  log('[TTS] handler registered')

  ipcMain.handle(
    'tts:speak',
    async (_event, text: string): Promise<{ available: boolean }> => {
      killCurrentProcess()

      log(`[TTS] speak requested (${text.length} chars)`)

      return new Promise<{ available: boolean }>((resolve) => {
        let resolved = false

        const proc = spawn('cartesia-read', [], {
          stdio: ['pipe', 'ignore', 'ignore'],
          env: { ...process.env, PATH: spawnPath() },
        })

        currentProcess = proc

        proc.on('error', (err) => {
          log(`[TTS] failed to spawn cartesia-read: ${err.message}`)
          if (currentProcess === proc) currentProcess = null
          if (!resolved) {
            resolved = true
            resolve({ available: false })
          }
        })

        proc.on('close', (code) => {
          log(`[TTS] cartesia-read exited (code ${code})`)
          if (currentProcess === proc) currentProcess = null
          if (!resolved) {
            resolved = true
            resolve({ available: true })
          }
        })

        proc.stdin?.write(text, () => {
          proc.stdin?.end()
        })
      })
    },
  )

  ipcMain.on('tts:stop', () => {
    killCurrentProcess()
  })
}
