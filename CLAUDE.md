# Spaceterm

## Orientation

- `NEXT_STEPS.md` — prioritised backlog: which modules still need a test seam, which
  need extracting first, and the structural issues worth fixing. Start here.
- `MODDING.md` — design note on turning features into mods, and why the scripts
  socket is already most of an extension API.
- `menubar/` — SpacetermBar, the macOS menu bar app that supervises the server
  and client in place of `npm run dev` (Swift, separate from the npm build).
  `menubar/README.md` covers its restart policy and how to verify it headless.

## After making changes

Run `npm run typecheck && npm run lint` after editing files in `src/`.

- `npm run typecheck` is the important one. Neither `tsx` (server) nor `electron-vite` (client) checks types — they strip them — so nothing else catches contract drift between `src/shared/`, `src/client/preload/`, and the renderer.
- `npm run lint` catches use-before-define errors (temporal dead zone bugs with `const`/`useCallback` ordering).

### Flag a needed server restart

If your change only takes effect after the Spaceterm server is restarted — editing
this `CLAUDE.md`, server code under `src/server/`, or the shared protocol — run:

```
npm run flag-restart -- "why a restart is needed"
```

This raises a marching-ants animation on the client's ↻ Restart button so the
human notices the pending restart instead of it getting buried in your prose. Do
**not** restart the server yourself; the restart is the human's call, and a fresh
server clears the flag automatically on startup.

Run `npm test` when changing a module that has a `.test.ts` beside it. Tests run on
Vitest and are discovered by glob, so a new test file needs no registration — just
put it next to the module it covers. `npm run test:watch` reruns on save, and
`npm test -- <substring>` runs a single file.

Three vitest projects, split by what a suite needs:

- **`node`** — server, shared, CLI. Default for anything not under
  `src/client/renderer/`.
- **`renderer`** — jsdom. React components and renderer libraries. Use
  `installFakeBridge()` from `src/client/renderer/src/testing/fake-bridge.ts`
  instead of Electron; it implements the `Api` interface explicitly, so a bridge
  change that the fake has not caught up with is a compile error.
- **`e2e`** — the real app. `npm run test:e2e` builds, fetches Electron's binary
  if missing, and runs under Xvfb on Linux. Keep this layer to smoke tests:
  it is seconds per test and the most brittle thing in the repo. Behaviour
  belongs in `renderer`.

**The GUI *can* be launched headlessly.** Earlier notes in this repo said
otherwise; they were wrong. `npm install --ignore-scripts` skips *electron's*
postinstall (a zip download) alongside `electron-rebuild`'s (a native compile),
and the two are unrelated. `npm run electron:install` fixes it and the session
hook runs it automatically. Do not defer work to "do this at a keyboard" without
checking whether an e2e or jsdom test would cover it.

## Testing

Prefer a dependency seam over module mocking. The pattern the codebase already
uses: a narrow deps interface passed to the constructor, with the real
implementation as the default — `BackgroundLedger(probes = REAL_PROBES)`,
`DaemonClient(onMessage, { transport = REAL_DAEMON_TRANSPORT })`,
`SessionManager(daemon, deps)`. A test then supplies a small fake rather than
intercepting `fs` or `child_process`, so the test exercises behaviour instead of
implementation.

- **Don't inject wall-clock time.** Take an optional `now` parameter
  (`PlanCache.snapshot`, `StateManager.setAlert`) or expose a flush hook
  (`ClaudeStateMachine.flushForTest`).
- **The PTY daemon is fakeable.** It's a separate Go process, but it speaks a
  stable JSON-lines protocol, so `src/server/testing/fake-daemon.ts` stands in
  for the socket. That's what makes the whole session lifecycle testable
  in-process — see `session-manager.test.ts`.
- **Hook events and transcript JSONL are data, not collaborators.** Use fixtures
  (`.claude/skills/claude-state-transition-research/canonical-observations.jsonl`),
  not mocks.
- **Assert properties, not coordinates**, where the code is a heuristic — see
  `node-placement.test.ts`. Pinning exact output makes every legitimate retune
  look like a regression.

If a module can't be tested without reaching into `fs`, `child_process`, or a
timer, add the seam rather than the mock. That refactor is the deliverable.

## Parallel agents

Multiple Claude Code agents may be running on this repo at the same time. Files can be modified by other agents mid-conversation. Never assume a file's contents are stable between reads. To revert your own changes, use surgical `Edit` calls (replacing your new text with the original) rather than `git restore` or full-file `Write`, which would clobber work done by other agents.

## Logging

Use the logger at `src/client/main/logger.ts` — never `console.log`/`console.error`. The log file lives at `~/.spaceterm/electron.log`, which the agent can read directly. Logs sent to the Electron terminal console or DevTools console are invisible to the agent and require the human to manually copy them, wasting time.

## Bug fixes and fragile code

After finding or fixing a bug caused by fragile code, do not just patch the symptom. Take the time to improve the design of the surrounding code so that the same class of bug cannot recur. This means addressing the root cause — whether that's tightening types, restructuring control flow, adding invariants, factoring duplicated code out into a function, or simplifying the logic — not just making the failing case work. Try to identify and fix issues the codebase has which made it difficult to find the source of the bug, and made it easy to introduce the bug in the first place.

## When finishing work

When you're ready to stop working on a feature or task, always end your final message with a brief, product-focused sentence summarizing what was implemented. Preface the summary with "FEATURE: " so the user knows it came from this instruction. This helps the user quickly re-orient when context switching between tasks.

## When providing a project plan

At the top of every project plan, before the context section, include a product-centric one-sentence explanation of what the change accomplishes. Preface it with "FEATURE: " so the user knows it came from this instruction. Below the FEATURE line, if there are perceived risks, detrimental side effects, or important caveats to the plan, include a "CAVEATS: " section listing them. Caveats should not include implementation-mitigatable issues that are already addressed elsewhere in the plan.
