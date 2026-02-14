# Spaceterm

## After making changes

Run `npm run lint` after editing files in `src/` to catch use-before-define errors (temporal dead zone bugs with `const`/`useCallback` ordering).

## Logging

Use the logger at `src/client/main/logger.ts` — never `console.log`/`console.error`. The log file lives at `~/.spaceterm/electron.log`, which the agent can read directly. Logs sent to the Electron terminal console or DevTools console are invisible to the agent and require the human to manually copy them, wasting time.
