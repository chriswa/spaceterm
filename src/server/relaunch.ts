/**
 * Restarting the server in place, whatever started it.
 *
 * The server used to restart by exiting with `SERVER_RESTART_EXIT_CODE` and
 * trusting whatever ran it to start it again. Two things broke that:
 *
 * - Not everything that runs the server relaunches it. SpacetermBar and
 *   `npm run dev` do; `tsx src/server/index.ts` in a terminal does not, and a
 *   restart there simply ended the server.
 * - The exit code never arrived. Once the turn model has been loaded,
 *   onnxruntime-node's static destructor aborts during `exit()` ("mutex lock
 *   failed"), so every restart ended in SIGABRT, which a supervisor reads as a
 *   crash rather than a request: SpacetermBar backs off, and `npm run dev`'s
 *   loop gives up.
 *
 * So the process replaces its own image instead (`execve`): same pid, same
 * parent, same stdout, nothing for a supervisor to notice or get wrong, and no
 * `exit()` for a native destructor to abort in. Only where `execve` is missing
 * (Node before 22.15) does it fall back to the exit code.
 */

/** Exits with this to ask a supervisor for a relaunch: SpacetermBar and `npm run server:dev` honour it. */
export const SERVER_RESTART_EXIT_CODE = 75

export interface RelaunchProcess {
  execPath: string
  /** Node's own flags, such as tsx's `--import` of its loader. */
  execArgv: readonly string[]
  argv: readonly string[]
  env: NodeJS.ProcessEnv
  /** Undefined where Node has no `process.execve`. Does not return when it works. */
  execve?: (file: string, args: string[], env: NodeJS.ProcessEnv) => never
  exit(code: number): never
}

/**
 * Become a fresh copy of this server: the same node, flags, script and
 * arguments. Call it once everything is shut down and persisted — like
 * `exit`, nothing after it runs.
 */
export function relaunchInPlace(proc: RelaunchProcess, log: (message: string) => void): never {
  if (proc.execve) {
    log('[restart] Relaunching in place')
    try {
      return proc.execve(proc.execPath, [proc.execPath, ...proc.execArgv, ...proc.argv.slice(1)], proc.env)
    } catch (err) {
      log(`[restart] Relaunching in place failed (${err instanceof Error ? err.message : String(err)}); exiting for a supervisor to relaunch instead`)
    }
  } else {
    log('[restart] This Node cannot relaunch in place; exiting for a supervisor to relaunch instead')
  }
  return proc.exit(SERVER_RESTART_EXIT_CODE)
}

/** The running process, as `relaunchInPlace` needs it. */
export function realProcess(): RelaunchProcess {
  const execve = (process as { execve?: RelaunchProcess['execve'] }).execve
  return {
    execPath: process.execPath,
    execArgv: process.execArgv,
    argv: process.argv,
    env: process.env,
    ...(execve ? { execve: execve.bind(process) } : {}),
    exit: (code) => process.exit(code),
  }
}
