# Next Steps

Working notes for whoever picks this up next. Written at the end of the session that
added the typecheck gate and the test suite; see `MODDING.md` for the separate
question of turning features into mods.

## Where things stand

| | Before | Now |
|---|---|---|
| `npm run typecheck` | did not exist | 0 errors, both projects |
| Tests | 89, hand-rolled `&&` chain | 331, Vitest, glob-discovered |
| Test files | 5 | 18 |
| CI | none | typecheck + lint + test on PR |
| Cloud session setup | none | SessionStart hook, `npm ci` in ~45s |

Nine real bugs surfaced along the way (Summary Chat's error path threw
`ReferenceError`; OSC titles were dropped when the ST terminator split across PTY
chunks; `DaemonClient` reconnected after `dispose()`; ANSI state was lost on
scrollback truncation; etc.). Each is described in the commit that fixed it —
`git log` on this branch is the record, and the messages carry the reasoning.

**Do this first:** the SessionStart hook only takes effect once it is on the default
branch. Until this branch merges, every new cloud session still starts with no
`node_modules` and no way to verify its own work.

## The rule that produced the above

Every module that was testable had a **dependency seam**: a narrow interface with the
real implementation as a default (`BackgroundLedger(probes = REAL_PROBES)`,
`DaemonClient(onMessage, { transport = REAL_DAEMON_TRANSPORT })`). Every module that
was not, wasn't. It had nothing to do with the code being complicated —
`node-placement` is 315 lines of dense geometry and needed zero refactoring to test.

So: **if a module cannot be tested without reaching into `fs`, `child_process`, or a
timer, adding the seam is the deliverable.** Not a mock. This is written up in
CLAUDE.md under "Testing".

## Tier B — modules that need a small seam (do next)

Each of these is one or two collaborators away from testable. Roughly ordered by
value per unit of work.

- **`summary-chat.ts`** (448 LOC). Injectable `fetch` and discovery-file read. This
  is the highest-value one: it took two follow-up bug fixes (`c4c5d64` long-poll
  timeout, `9c48644` wait cues), both of which a test would have caught.
- **`session-title-summarizer.ts`**, **`git-status-poller.ts`**. Both shell out
  inline. Inject `execFile`.
- **`persistence.ts`**. The debounce timer is *module-scoped* (`persistence.ts:10`),
  so two `StateManager`s cannot exist in one process. That makes this a **blocker for
  all of Tier C** — you cannot write a `StateManager` test until it is fixed. Make it
  a class or inject the scheduler.
- **`snapshot-manager.ts`**. Starts a timer in its constructor with no injection
  point.
- **`plan-cache.ts`**, **`file-content-manager.ts`**. Same shape, less traffic.

## Tier C — extract before testing

Do **not** try to test these in place; you would cement the shape you are trying to
change. Each extraction lands with its own tests.

- **`state-manager.ts`** (1180 LOC). Needs a deps interface for `{persist, broadcast}`
  and one private helper to replace the ~40 hand-written
  mutate → `onNodeUpdate` → `schedulePersist` triples. Those triples each carry an
  `as Partial<X>` cast, so a typo'd field name compiles today. Also move the
  cwd-mismatch alert engine (`:1079-1157`) and the constructor migrations (`:53-87`)
  out — the latter includes a `// TEMPORARY:` block that wipes all alerts on every
  boot.
- **`server/index.ts`** (3061 LOC). Nothing is exported, so nothing is reachable.
  Highest-value extraction is the spawn sequence duplicated at seven sites
  (`resolve resume id → build options → sessionManager.create → snapshotManager.addSession`).
  See `MODDING.md` — this is the same work as the `AgentDriver` registry.
- **`App.tsx`** (2429 LOC), **`TerminalCard.tsx`** (1246), **`Toolbar.tsx`** (1021).
  The obvious seams: App's 380-line keyboard handler (`:1629-2008`), TerminalCard's
  466-line xterm mount effect (`:182-647`), Toolbar's 416-line `CrabGroup`. Note
  `TerminalCard` exports four module-level `Map`s as an imperative side-channel so
  App's keyboard handler can reach into a card instance — extract the handler and
  that escape hatch disappears on its own.

## Making it more serious (independent of mods)

These are the things that would matter if other people depended on this.

1. **Protocol versioning and exhaustiveness.** 105 message variants across five
   unions, no version field anywhere, and **zero** exhaustiveness checks in the whole
   codebase (`grep` for `assertNever` returns nothing). `handleIngestMessage`
   (`index.ts:842`) has no `default` at all, so an unhandled ingest message is
   silently dropped. Adding `const _: never = msg` to the three server switches and
   `server-client.ts` is a few lines and prevents a whole defect class.
2. **State migrations.** `STATE_VERSION` is written into the persisted file
   (`state-manager.ts:21`, `:90`) and **never read back**. There is no migration path,
   which is why the constructor accumulates ad-hoc backfills. If the node schema is
   ever going to be a public contract (it must be, for mods), this needs to exist
   first.
3. **Branded identifiers.** `surfaceId`, `nodeId`, `sessionId`, `ptySessionId`,
   `claudeSessionId` are all plain `string`. `protocol.ts:802-805` documents that
   `surfaceId` is a *pty session id* and "is NOT a node id: the two coincide only at a
   terminal's first launch and diverge after a restart/resume" — and then
   `index.ts:740` does `getNodeIdForSession(surfaceId) ?? surfaceId`, falling back to
   the thing the comment says is wrong. Branded types make that a compile error and
   cost nothing at runtime.
4. **One owner for surface state.** `claudeState`, `claudeStatusUnread`,
   `claudeStatusAsleep`, `claudeContextPercent`, `claudeSessionLineCount` live in
   *both* `SessionManager`'s in-memory session and `StateManager`'s persisted node,
   hand-synced through `index.ts`. Related: `potential_error` is decided outside the
   state machine (`index.ts:2617`) by re-entering `setClaudeState`, so one of seven
   `ClaudeState` values never appears in the decision log — the artifact that made
   every other state bug solvable.
5. **One owner for the PTY byte stream.** Three post-mortems in this repo
   (`ANSI_PRESERVATION_BUG.md`, `Potential UTF Bug Fix.md`, and the `potential_error`
   regex false positives) all trace to the same shape: a consumer slicing the raw
   stream at an arbitrary boundary without owning its state. The ANSI one is now
   fixed; the UTF-8 one is not. `title-parser.ts` is the model — a proper stateful
   parser that survives chunk boundaries.

## Things deliberately not done

- **`--ignore-scripts`** in the hook and CI skips `electron-rebuild` and Electron's
  binary download. Fine for typecheck/lint/test; it does mean an agent cannot launch
  the GUI. If you need that, a full `npm install` is required.
- **No jsdom project in the Vitest config.** Everything tested today is pure logic or
  a deps-injected class. When component tests arrive, add a second project rather
  than making jsdom the default for the server suites that outnumber them.
- **xterm / WebGL / canvas rendering** will not test meaningfully in jsdom. Extract
  the logic (e.g. `renderSnapshotToCanvas(ctx, snapshot, theme)` against a fake 2D
  context that records calls) and leave the pixels to manual verification.
