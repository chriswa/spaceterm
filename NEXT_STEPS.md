# Next Steps

Working notes for whoever picks this up next. See `MODDING.md` for the separate
question of turning features into mods.

## Where things stand

| | Three sessions ago | Two ago | Last | Now |
|---|---|---|---|---|
| `npm run typecheck` | did not exist | 0 errors | 0 errors, all of `src/` | 0 errors |
| Tests | 89, hand-rolled | 331 | 641 | **843** |
| Test files | 5 | 18 | 31 | **40** |
| Vitest projects | 1 (node) | 1 | 1 | **2 (node + jsdom)** |
| Tier 0 registries | none | none | 1 of 3 | **3 of 3** |
| `server/index.ts` | 3061 | 3087 | 3007 | **2543** |
| `Toolbar.tsx` | 1021 | 1021 | 1021 | **40** |

All three of MODDING.md's Tier 0 registries now exist — `AgentDriver`,
`CardType`, `ToolbarWidget` — and every first-party feature goes through them.
All four preconditions for a mod API are met.

## What the last session did

Six commits, each self-contained. `git log` carries the reasoning.

- **`gh-rate-limit.ts`** — the sparkline poller out of index.ts, with a deps
  seam and 24 tests. MODDING.md's nominated first mod is now a self-contained
  module rather than an inlined tenant.
- **`capabilities.ts`** — a startup probe that writes to `~/.spaceterm/electron.log`
  which optional integrations this machine has and *what stops working without
  each one*. See "Productization" below for why this matters more than it looks.
- **`script-api.ts`** — the scripts socket out of index.ts. `ScriptHost`'s method
  list is now literally the mod capability surface; 45 tests.
- **`ToolbarWidget` registry** — `Toolbar.tsx` went from 1021 lines to 40, and
  the toolbar's four unrelated tenants became four files.
- **`terminal-respawn.ts`** — six hand-written copies of an order-sensitive
  sequence collapsed to one, plus `createTerminal` converted from eleven
  positional parameters to a named spec.

### What the seams found this time

The pattern from previous sessions held: **every seam added turned up a
defect.**

- The capability probe ran `pgrep` with a non-matching pattern and read its exit
  code. pgrep exits 1 when nothing matches, so it reported a working pgrep as
  missing — **wrong on the very first machine it ran on**. Presence and exit
  code are different questions and the deps interface now offers both, with a
  comment saying which probes may use which.
- Walking node ancestors for a script did not seed its cycle-guard with the
  starting node, so a `parentId` cycle back through the start listed that node
  as its own ancestor. It terminated; it just answered wrong.
- `script-api.test.ts` typechecked only because vitest strips types — `id`
  appeared twice in the same object literal. **`npm test` passing is not
  evidence that a test file typechecks.** Run both.
- The toolbar registry's first draft keyed mapped widgets with a
  `display: contents` wrapper span. `.toolbar__zoom > :last-child` in the
  stylesheet selects the last *element*, and a wrapper wins that match even at
  `display: contents` — and would match even when the widget inside renders
  nothing, which the rate-limit meter does whenever `gh` is unavailable. A keyed
  `Fragment` adds no element.

## The rule that produced all of the above

If a module cannot be tested without reaching into `fs`, `child_process`, or a
timer, **adding the seam is the deliverable**. Not a mock. Written up in
CLAUDE.md under "Testing", and every module extracted so far follows the same
shape: a narrow deps interface with the real implementation as the default.

Two corollaries worth stating, both learned the hard way:

- **Type-level assertions have to be checked by breaking them.** Two separate
  attempts at a compile-time registry cross-check reported nothing:
  `T extends U ? true : never` in a tuple position is a legal type, and
  `MutuallyAssignable<A extends B, B extends A>` is a circular-constraint error
  rather than an assignment error. The version that works is two one-way
  `Assignable<Sub extends Super, Super>` aliases — verified by adding a node
  type with no spec and watching it fail.
- **The same goes for tests.** `module-cycles.test.ts` was written to catch a
  specific import cycle and passed *against that exact cycle*, because its
  regex used `[^'"\n]*?` and so skipped every multi-line import. Reintroduce the
  bug and watch the test go red, or you have not written a test.

## What is left

### Tier C — extract before testing

- **`server/index.ts`** (2543, down from 3087). Three tenants have moved out
  (`agent-provisioning`, `gh-rate-limit`, `script-api`). What remains is
  `handleMessage` — a ~990-line switch over 49 client message types — plus
  socket setup plus startup reconciliation. Those are three files.

  The switch is not uniformly bad: 30 of the 49 cases are under 20 lines and
  read fine as a router. The value is in the nine that are not
  (`terminal-restart` 93, `fork-session` 85, `node-unarchive` 68, `attach` 57,
  `directory-wt-spawn` 52). Those are operations, not routing, and the fork/
  spawn ones now have `respawnTerminal` and the `NewTerminalSpec` to build on.
  A `terminal-operations.ts` holding create/fork/restart/reincarnate/unarchive
  would take ~350 lines out and be the first testable coverage of the terminal
  lifecycle above the session-manager level.
- **`state-manager.ts`** (1103). Both original tenants are out and the mutate →
  broadcast → persist triples are now `patchNode`/`applyPatch`. What is left
  really is state management; the open question is whether it needs splitting at
  all rather than where to cut.
- **`App.tsx`** (2436) and **`TerminalCard.tsx`** (1248). Unchanged, and now the
  largest files in the repo. App's 380-line keyboard handler and TerminalCard's
  466-line xterm mount effect. `TerminalCard` still exports four module-level
  `Map`s as an imperative side-channel for App's keyboard handler; extract the
  handler and that escape hatch disappears on its own. **There is now a jsdom
  vitest project**, so a renderer test no longer needs config work first.

### Card component unification — deliberately deferred

`App.tsx` maps five near-identical card lists. `CardType` made the *data* side
one registry, but the components take ~30 differing props each and cannot be
verified without running the GUI, which an agent cannot do here (see "Things
deliberately not done"). Do this one at a keyboard, with the app running.

## Ideas for the next sessions

These are not backlog items with agreed shapes; they are the things that would
most improve the software, roughly ordered by value per unit of risk.

### Reliability

1. **The client socket is still unversioned.** `ClientMessage`/`ServerMessage`
   have no version field. That is defensible while the Electron client ships
   with the server — but it is an assumption, and the failure mode when it stops
   holding is a client silently misreading a message. The scripts socket's
   `script-hello` handshake is the pattern; copying it is an afternoon.
2. **No integration test spans the whole server.** `session-manager.test.ts`
   drives the fake daemon, but nothing exercises `startServer` →
   reconciliation → a client connecting → a terminal spawning. The pieces exist
   (`fake-daemon.ts`, `StatePersister` with an injectable IO, `ScriptApi` with a
   fake connection); what is missing is `startServer` being callable with
   injected collaborators rather than constructing its own.
3. **Startup reconciliation is the least-tested, highest-consequence code in
   the repo.** It decides, per node, whether to reattach, revive, or archive —
   and it runs before anyone is watching. Everything it needs is now behind a
   seam except its own structure.
4. **Nothing verifies that a persisted state file round-trips.** Migrations are
   tested, but no test loads a realistic `state.json`, runs it through the
   server, and asserts the same document comes back out. A property test over
   generated node graphs would be cheap and would have caught at least two of
   the bugs found this session.

### Robustness

5. **`restartRecovery` is keyed by node id in a module-level `Map` with a 10s
   wall-clock window and an `isRetry` flag.** It is the last piece of
   lifecycle state living outside `StateManager`, and it is the shape of thing
   that goes wrong on a slow machine. Three bugs this project has already fixed
   were "a `Date.now()` comparison deciding a sequence question".
6. **Error surfacing is one-way.** A failed spawn logs and sends
   `server-error`, which the client shows transiently. There is no record on the
   node itself, so a terminal that failed to revive at startup looks the same as
   one the user archived. `NodeAlert` already exists for cwd mismatches — the
   mechanism is there.
7. **`gatherAncestorPrompt` walks the node graph with no depth bound.** So do
   several other walks. The script API's ancestor walk is now cycle-guarded
   because a script is untrusted input; a corrupt state file is the same
   problem arriving through a different door.

### Productization — supporting users who are not the author

This axis is newer and, per the current owner, worth weighting up.

8. **Startup capability reporting exists; make it reachable.** `capabilities.ts`
   writes to the log. The next step is exposing it over the protocol so the app
   can show "Summary Chat needs X" *in the UI, next to the button that does
   nothing* — and `spaceterm-cli capabilities` for headless diagnosis. The data
   is already structured (`id`/`name`/`available`/`detail`/`affects`) for exactly
   this.
9. **The platform coupling is narrow, and now documented.** Four hard
   dependencies on macOS or on absolute paths: `/usr/bin/security` (Keychain),
   `~/Library/Application Support/VoiceOperator/`, `/usr/bin/pgrep`,
   `/usr/sbin/lsof`. All four already degrade rather than crash. Making
   Spaceterm run usefully on Linux is therefore *smaller than it looks* — it is
   mostly the two shell-outs, since Summary Chat is optional by design.
10. **There is no first-run path.** The app assumes `~/.spaceterm/` conventions,
    a working `claude` on PATH, and agent plugin directories it provisions
    silently. Someone cloning this repo finds out what is missing by watching
    things not work. A `spaceterm doctor` that runs the capability probe and
    checks the agent CLIs would be a day's work and is the difference between
    "the author's tool" and "a tool".
11. **Incremental adoption has no on-ramp.** Every feature is on. A user who
    wants a canvas of terminals also gets hook provisioning into `~/.cursor/`
    and `~/.codex/`, background-work probing, and a speech integration. The
    provisioning half is already behind `AgentProvisioning`; a settings surface
    that can decline it is mostly wiring.
12. **Nothing is documented for a reader who is not already inside the code.**
    `CLAUDE.md`, `NEXT_STEPS.md` and `MODDING.md` are all written for a
    contributor. There is no "what is this and why would I want it".

### Extensibility

13. See MODDING.md. Tier 0 is complete, so the next real step is the mod
    *lifecycle* — manifest, spawn, health, restart-on-crash, disable — not more
    contract work.
14. **The three registries are not yet reachable from outside their modules.**
    `AGENT_TYPES`, `CARD_TYPES` and `TOOLBAR_WIDGETS` are const arrays. Making
    each a mutable registry with a `register()` is a small change that should be
    made *when the first mod needs it* and not before — a registry nobody
    registers into is just a slower array.

## Things deliberately not done

- **`session-title-summarizer.ts` has no seam.** It is hard-disabled at
  `const ENABLED = Boolean(false)`. Add the seam when it is turned back on.
- **No UTF-8 sanitizer.** The ESC-eats-the-escape defect does not reproduce
  against current xterm.js — tested by driving `@xterm/headless` with the exact
  bytes rather than assumed. See the rewritten `Potential UTF Bug Fix.md`. The
  investigation found a real bug next door instead (Unicode 6.0 vs 11.0 width
  tables between the snapshot and visible terminals), which is fixed.
- **`--ignore-scripts`** in the hook and CI still skips `electron-rebuild` and
  Electron's binary download. Fine for typecheck/lint/test; an agent cannot
  launch the GUI without a full `npm install`. This is why anything requiring
  visual verification is deferred rather than attempted.
- **xterm / WebGL / canvas rendering** will not test meaningfully in jsdom.
  `snapshot-manager.test.ts` shows the workable middle ground: `@xterm/headless`
  runs fine in node, so the serialization path *is* tested; only pixels are left
  to manual verification.
