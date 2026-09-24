import type { LoginEnvSource } from '../login-env'

/** A LoginEnvSource that never spawns a shell: `env` is what `current()` returns. */
export class FakeLoginEnv implements LoginEnvSource {
  refreshes = 0
  constructor(public env: Record<string, string> | null = null) {}
  current(): Record<string, string> | null {
    return this.env
  }
  refresh(): void {
    this.refreshes++
  }
  dispose(): void {}
}
