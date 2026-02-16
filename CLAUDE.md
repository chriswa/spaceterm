# Spaceterm

## After making changes

Run `npm run lint` after editing files in `src/` to catch use-before-define errors (temporal dead zone bugs with `const`/`useCallback` ordering).

## Parallel agents

Multiple Claude Code agents may be running on this repo at the same time. Files can be modified by other agents mid-conversation. Never assume a file's contents are stable between reads. To revert your own changes, use surgical `Edit` calls (replacing your new text with the original) rather than `git restore` or full-file `Write`, which would clobber work done by other agents.

## Logging

Use the logger at `src/client/main/logger.ts` — never `console.log`/`console.error`. The log file lives at `~/.spaceterm/electron.log`, which the agent can read directly. Logs sent to the Electron terminal console or DevTools console are invisible to the agent and require the human to manually copy them, wasting time.
