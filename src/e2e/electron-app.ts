import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { join, dirname, basename } from 'path'
import { tmpdir } from 'os'
import { fileURLToPath } from 'url'
import { spawn, type ChildProcess } from 'child_process'
import { _electron, type ElectronApplication, type Page } from 'playwright-core'
import { SOCKET_PATH } from '../shared/protocol'

/**
 * The server's socket filename, taken from the constant rather than spelled
 * out. `SOCKET_PATH` itself resolves against the *test runner's*
 * SPACETERM_HOME, not the child's, so only the basename is usable here — but
 * taking even that from the constant means a rename cannot leave this polling
 * for a file that will never appear. The first version hardcoded
 * 'spaceterm.sock'; the real name is 'bidirectional.sock', and the symptom was
 * a launch that hung for the full timeout with no explanation.
 */
const SERVER_SOCKET_NAME = basename(SOCKET_PATH)

/**
 * Launching the real app — real Electron, real server, real Go pty daemon —
 * under a virtual display.
 *
 * The received wisdom in this repo was that a headless agent cannot launch the
 * GUI, so anything needing it was deferred to "do this at a keyboard". That was
 * wrong, and only wrong by one missing line: `npm install --ignore-scripts`
 * skips *electron's* postinstall (a zip download) along with
 * `electron-rebuild`'s (a native compile). The two are unrelated. `npm run
 * electron:install` fetches the binary, `xvfb-run` supplies a display, and the
 * app runs.
 *
 * This is the highest-fidelity and most brittle layer of the test pyramid, so
 * keep it to a handful of smoke tests. Component behaviour belongs in the jsdom
 * project, where it runs in milliseconds and fails legibly. What only this can
 * cover is the main process — `app.evaluate()` runs code *inside* it — and the
 * fact that the three processes actually talk to each other.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** Where electron's postinstall records the binary it downloaded. */
function electronBinary(): string | null {
  const pathFile = join(REPO_ROOT, 'node_modules', 'electron', 'path.txt')
  if (!existsSync(pathFile)) return null
  const relative = readFileSync(pathFile, 'utf-8').trim()
  if (!relative) return null
  const binary = join(REPO_ROOT, 'node_modules', 'electron', 'dist', relative)
  return existsSync(binary) ? binary : null
}

/**
 * Why the E2E suite cannot run here, or null if it can.
 *
 * Returned as a reason rather than thrown so the suite can skip with an
 * explanation. A suite that silently vanishes is worse than one that fails.
 */
export function e2eBlocker(): string | null {
  if (!electronBinary()) {
    return 'Electron binary not installed — run `npm run electron:install`'
  }
  if (process.platform === 'linux' && !process.env.DISPLAY) {
    return 'No DISPLAY — run under `xvfb-run -a`'
  }
  if (!existsSync(join(REPO_ROOT, 'out', 'main', 'index.js'))) {
    return 'App not built — run `npm run client:build`'
  }
  if (!existsSync(join(REPO_ROOT, 'pty-daemon', 'pty-daemon'))) {
    return 'PTY daemon not built — run `npm run daemon:build`'
  }
  return null
}

/**
 * Start the Spaceterm server against an isolated home and wait for its socket.
 *
 * The main process does `await client.connect()` *before* `createWindow()`, and
 * `connect()` retries forever rather than rejecting — so without a server there
 * is no window, ever, and no error either. That is worth knowing beyond this
 * harness: a first-run user whose server cannot start sees a dock icon and
 * nothing else.
 */
function startServer(home: string): Promise<ChildProcess> {
  const proc = spawn('npx', ['tsx', join(REPO_ROOT, 'src', 'server', 'index.ts')], {
    cwd: REPO_ROOT,
    env: { ...process.env, SPACETERM_HOME: home },
    stdio: ['ignore', 'pipe', 'pipe']
  })

  const socket = join(home, SERVER_SOCKET_NAME)
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 60_000
    const stderr: string[] = []
    proc.stderr?.on('data', (chunk) => stderr.push(String(chunk)))
    proc.once('exit', (code) =>
      reject(new Error(`server exited with ${code} before listening:\n${stderr.join('')}`))
    )

    const poll = setInterval(() => {
      if (existsSync(socket)) {
        clearInterval(poll)
        resolve(proc)
      } else if (Date.now() > deadline) {
        clearInterval(poll)
        proc.kill('SIGKILL')
        reject(new Error(`server socket never appeared at ${socket}\n${stderr.join('')}`))
      }
    }, 200)
  })
}

export interface LaunchedApp {
  app: ElectronApplication
  window: Page
  /** Isolated `~/.spaceterm` for this run. */
  home: string
  close(): Promise<void>
}

/** Stop a child and wait for it, without hanging if it ignores SIGTERM. */
function stop(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve()
  return new Promise((resolve) => {
    const force = setTimeout(() => proc.kill('SIGKILL'), 3_000)
    proc.once('exit', () => { clearTimeout(force); resolve() })
    proc.kill('SIGTERM')
  })
}

/**
 * Launch the packaged main process against an isolated `SPACETERM_HOME`.
 *
 * Isolation is the thing that makes this safe to run at all: both
 * `src/shared/protocol.ts` and `pty-daemon/main.go` honour `SPACETERM_HOME`, so
 * a test run gets its own sockets, its own state file and its own daemon rather
 * than adopting — and then destroying — the developer's live session.
 */
export async function launchApp(
  options: { timeoutMs?: number; withServer?: boolean } = {}
): Promise<LaunchedApp> {
  const blocker = e2eBlocker()
  if (blocker) throw new Error(`Cannot launch: ${blocker}`)

  const home = mkdtempSync(join(tmpdir(), 'spaceterm-e2e-'))
  // The server auto-starts the Go daemon, so this brings up the whole stack.
  // `withServer: false` is for testing what a user sees when it cannot start.
  const server = options.withServer === false ? null : await startServer(home)

  const app = await _electron.launch({
    executablePath: electronBinary()!,
    args: [
      join(REPO_ROOT, 'out', 'main', 'index.js'),
      // The container runs as root, and Chromium refuses to start its sandbox
      // as root rather than silently running unsandboxed.
      '--no-sandbox',
      '--disable-gpu-sandbox'
    ],
    cwd: REPO_ROOT,
    timeout: options.timeoutMs ?? 60_000,
    env: {
      ...process.env,
      SPACETERM_HOME: home,
      NODE_ENV: 'production',
      // dbus is absent in the container; without this Electron logs a scary
      // connection failure on every launch that reads like a real error.
      ELECTRON_DISABLE_SECURITY_WARNINGS: '1'
    }
  })

  const window = await app.firstWindow({ timeout: options.timeoutMs ?? 60_000 })

  return {
    app,
    window,
    home,
    async close() {
      await app.close().catch(() => {})
      if (server) await stop(server)
      // The daemon outlives the server on purpose (that is how sessions survive
      // a server restart), so it has to be told to go.
      await stopDaemon(home)
      rmSync(home, { recursive: true, force: true })
    }
  }
}

/**
 * Ask the isolated daemon to shut down.
 *
 * The daemon deliberately outlives its server — that is how pty sessions
 * survive a server restart — so an E2E run that only stopped the server would
 * leak one Go process and one megabyte of ring buffer per test file.
 */
async function stopDaemon(home: string): Promise<void> {
  const pidFile = join(home, 'pty-daemon.pid')
  if (!existsSync(pidFile)) return
  const pid = Number.parseInt(readFileSync(pidFile, 'utf-8').trim(), 10)
  if (!Number.isInteger(pid) || pid <= 0) return
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    // Already gone.
  }
}
