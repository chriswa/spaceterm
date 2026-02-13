import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

const INTEGRATION_DIR = join(homedir(), '.spaceterm', 'shell-integration')
const ZSH_DIR = join(INTEGRATION_DIR, 'zsh')

// .zshenv that restores original ZDOTDIR and adds a precmd hook to emit OSC 7
const ZSHENV_CONTENT = `\
# Restore original ZDOTDIR so user's config loads normally
if [ -n "\$SPACETERM_ORIGINAL_ZDOTDIR" ]; then
  ZDOTDIR="\$SPACETERM_ORIGINAL_ZDOTDIR"
  unset SPACETERM_ORIGINAL_ZDOTDIR
else
  unset ZDOTDIR
fi

# Source user's .zshenv if it exists
[ -f "\${ZDOTDIR:-$HOME}/.zshenv" ] && source "\${ZDOTDIR:-$HOME}/.zshenv"

# Add precmd hook to emit OSC 7 (CWD reporting)
__spaceterm_osc7() {
  printf '\\e]7;file://%s%s\\a' "\${HOST}" "\${PWD}"
}

autoload -Uz add-zsh-hook
add-zsh-hook precmd __spaceterm_osc7
`

/**
 * Write shell integration scripts to ~/.spaceterm/shell-integration/.
 * Called once at server startup.
 */
export function setupShellIntegration(): void {
  mkdirSync(ZSH_DIR, { recursive: true })
  writeFileSync(join(ZSH_DIR, '.zshenv'), ZSHENV_CONTENT, { mode: 0o644 })
}

/**
 * Returns a modified env object that injects shell integration for the given shell.
 * Only modifies env for interactive shell spawns (not arbitrary commands).
 */
export function getShellEnv(shell: string, baseEnv: Record<string, string>): Record<string, string> {
  const env = { ...baseEnv }

  if (shell.endsWith('/zsh') || shell === 'zsh') {
    // ZDOTDIR trick: save the user's ZDOTDIR, point to ours.
    // Our .zshenv restores the original and adds the precmd hook.
    if (env.ZDOTDIR) {
      env.SPACETERM_ORIGINAL_ZDOTDIR = env.ZDOTDIR
    }
    env.ZDOTDIR = ZSH_DIR
  } else if (shell.endsWith('/bash') || shell === 'bash') {
    // Prepend OSC 7 reporter to PROMPT_COMMAND
    const osc7 = 'printf \'\\e]7;file://%s%s\\a\' "$(hostname)" "$PWD"'
    const existing = env.PROMPT_COMMAND || ''
    env.PROMPT_COMMAND = existing ? `${osc7};${existing}` : osc7
  }

  return env
}
