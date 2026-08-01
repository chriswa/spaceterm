# Making Spaceterm Moddable

A design note, not a spec. Written to answer "could some of this functionality become
mods, and would that make the project more serious?" Grounded in what the codebase
already does — several of the pieces exist, they just are not named as such.

## Short answer

**Yes, and you have already built most of the hard part twice.** The scripts socket is
a working out-of-process extension API with nine tools written against it. What is
missing is not a plugin loader — it is that the *first-party* features do not go
through any of the seams a mod would have to use, so there is nothing for a mod to
plug into.

The order that follows from that: **make the internal seams first, convert one
first-party feature onto them as proof, and only then talk about third-party mods.**
Building a mod API before the first-party features use it produces an API that is
fiction, because nothing has ever had to be expressed through it.

Also worth saying plainly: for a single-user tool, the payoff is not an ecosystem.
It is that **features stop being smeared across shared files**. That is measurable
here, so start there.

### Status

The seams are built. All three Tier 0 registries exist and every first-party
feature goes through them; all four contract preconditions are met; the scripts
socket is versioned, has a documented event set, and its dispatch is a
separately tested module whose host interface is the mod capability surface.

**What remains is the mod lifecycle — manifest, spawn, health, restart, disable
— and nothing about the contract.** Everything below the "Recommended shape"
heading is a record of how that was arrived at, kept because the *method*
generalises to the next registry-shaped problem.

## The evidence: what a feature costs today

Commit `653cd1d` removed the usage-cost tracking feature. It is the cleanest natural
experiment in the repo, because deleting a feature reveals exactly how much of it was
not really *in* the feature:

```
907 deletions across 11 files
  the feature's own modules:  484 lines  (api-usage 346, claude-usage 111, usageStore 27)
  wiring in shared files:    ~420 lines  (index.ts 236, Toolbar.tsx 154,
                                          protocol.ts, preload, server-client,
                                          global.d.ts, server-sync)
```

**Roughly 45% of the feature lived in files belonging to everything else.** That tax
is paid twice — once to add a feature, once to remove it — and it is why `index.ts`
was 3061 lines and `Toolbar.tsx` was 1021 lines of which the actual toolbar was 65.

A mod system is worth building exactly to the extent that it drives that 45% to
near zero. That is the number to measure against, not "do we have plugins".

**Where the number stands.** `Toolbar.tsx` is now 40 lines and adding or removing
a toolbar widget is one registry entry plus one component — for that surface the
tax is zero. `index.ts` is 2543. Adding an agent is one `AgentDriver`; adding a
card type is one `CARD_TYPE_SPECS` entry plus a component. The remaining tax is
concentrated in `protocol.ts`, the preload bridge and `server-sync`, which no
registry touches because they are the *transport*, and which a mod would not pay
at all: it speaks the scripts socket instead.

## What already exists

Three extension surfaces, none of them called that:

**1. The scripts socket — this is already a mod API.**
`~/.spaceterm/scripts.sock`, JSON-lines, eight message types (`ScriptMessage` in
`protocol.ts`). It supports subscribing to a documented event set
(`ScriptSubscribeMessage` → `ScriptApi.broadcast`), and it now announces itself:
`script-hello` reports the served protocol range and the complete event list.
There are **nine tools written against it**, in
`src/claude-code-plugin/mcp-server/`: spawn a surface, fork a surface, emit a
markdown card, emit one onto the parent, resolve handoff context, broadcast,
play a sound, speak, read surface env.

That is a mod. It runs out-of-process, loads no code into spaceterm, and does real
work. The MCP server is spaceterm's first mod and nobody called it one.

**2. The hooks/ingest socket.** `IngestMessage`, ten types. How agent hook handlers
push state in. Also out-of-process — the producers are shell scripts.

**3. The three agent plugin directories.** `claude-code-plugin/`,
`cursor-agent-plugin/`, `codex-agent-plugin/`. Note these are plugins *for other
tools*, provisioned by spaceterm into `~/.cursor/` and `~/.codex/`. They are not
spaceterm mods, but they prove the project already thinks in terms of pluggable agent
integrations.

## The three things that were secretly plugin points

Each was a place where adding a variant meant editing many files — the signature
of a missing registry. All three now have one; kept here because the *signature*
is what to look for next time, not the specific three.

**Agent types** (`claude` | `cursor` | `codex`). The clearest case: the literal
appeared **ten times** rather than being exported once as an `AgentType`; adding
an agent meant editing six spawn-dispatch sites, five watcher-wiring sites,
three label ternaries and two icon dispatches; and two functions
(`lastCursorSessionId`, `lastCodexSessionId`) were byte-for-byte identical.
Commit `bffb2e3` ("Add Cursor and Codex agent surfaces") touched **37 files**.

**Node / card types** (`terminal` | `markdown` | `directory` | `file` | `title`).
Adding one touched `state.ts`, `protocol.ts`, `node-size.ts`, `node-placement`,
`state-manager`, `App.tsx`'s five near-identical card maps, and `AddNodeBody`.
The data half is now `CARD_TYPE_SPECS`; the *component* half is not, and is the
one piece of Tier 0 deliberately left undone — see NEXT_STEPS.md.

**Toolbar widgets.** `Toolbar.tsx` was 1021 lines of which the exported
`Toolbar` was 66. The rest were unrelated tenants: a 416-line `CrabGroup` that
is simultaneously a FLIP animation, a rAF dance loop, a drag-to-reorder
implementation and a nav-indicator state machine; a ~160-line GitHub rate-limit
charting module with zero coupling to the toolbar; and nine inline SVG icons.

### How to spot the fourth one

The signature was never "this looks like it should be pluggable". It was:

1. **A string literal union appearing in more places than it is defined.**
2. **Two functions that differ only by which literal they mention.**
3. **A `switch` whose branches each edit a different file's worth of state.**
4. **A commit that added one variant and touched more than ten files.**

By that test the remaining candidates in this repo are the **five card
components** in `App.tsx` and the **hook event handlers** in `handleIngestMessage`
— ten message types, several of which differ only by which agent produced them.

## Recommended shape, in order

### Tier 0 — internal registries — **complete**

`AgentDriver`, `CardType`, `ToolbarWidget`. All three exist, and every
first-party feature goes through them rather than being special-cased. No
dynamic loading, no manifest, no API surface — just the seams. The point of
doing this first was to find out cheaply whether the registries could express
the features that already exist; they can, and the process of making them do so
found things nothing else would have.

**`AgentDriver`** (`src/server/agent-drivers.ts`, `src/shared/agent-type.ts`).
Absorbed seven spawn-dispatch chains, three label ternaries, five capability
checks and three watcher wirings. Verified by differential test: 1152 launch
specs produce byte-identical command lines to the code it replaced.

- **The capability block is where the value was.** Writing it forced a question
  the name tests had been fudging: `canForkSession` turned out to be three
  distinct answers (`'none' | 'native' | 'transcript-clone'`), because Cursor
  cannot fork, Codex forks itself, and Claude forks by spaceterm cloning the
  transcript. Two call sites had quietly disagreed about which they meant.
- **The one spec, many drivers contract holds.** A single `AgentLaunchSpec`
  (cwd, prompt, resume, fork, appendSystemPrompt, extraArgs) covers all three
  CLIs; each ignores what it does not use. That is exactly the shape a mod's
  driver would need, and it survived contact with three genuinely different
  command-line grammars — including one with load-bearing argument order.

**`CardType`** (`src/shared/card-types.ts`). Carries the pixel-size function per
type, with `measureCard` dispatching through `assertNever`. Two findings:

- **Registries invite import cycles, and neither typecheck nor lint catches
  them.** Re-exporting `measureCard` from `node-size.ts` — which `card-types.ts`
  imports constants from — produced a clean typecheck, a clean lint, and a
  runtime `Cannot access 'CELL_WIDTH' before initialization` in three test
  files. `src/shared/module-cycles.test.ts` now walks the import graph
  (value edges only; `import type` erases at runtime) and fails on a cycle.
- **A type-level cross-check between the registry and the union is worth
  having, and is easy to write in a form that asserts nothing.** See
  NEXT_STEPS.md; the working version is two one-way `Assignable` aliases.

**`ToolbarWidget`** (`src/client/renderer/src/components/toolbar/registry.tsx`).
`Toolbar.tsx` went from 1021 lines to 40. The finding here was the sharpest of
the three:

- **Widgets split cleanly into two kinds, and the split is exactly the mod
  boundary.** Nine of the fourteen are *standalone*: they own their state
  through a zustand store, `localStorage` or `window.api`, and take **no props
  at all**. Five are *host-driven* — a keyboard-toggled overlay, a WebGL
  setting, an in-flight server restart, the crab-nav selection, the zoom level.
  A mod could supply any of the nine today and none of the five.
- **That line is enforced, not documented.** A standalone widget's `render` is
  typed `() => ReactNode`, so a function taking `ToolbarHost` fails to compile
  ("Target signature provides too few arguments"). `renderToolbarWidget`
  withholds the host at runtime too, and a test renders the real registry
  against a `Proxy` host asserting no standalone widget reaches for one.
- **Nine of fourteen is the evidence that a widget contract is viable at all.**
  Before the registry it was not obvious the toolbar contained *any* widget that
  could come from elsewhere — every button looked like it belonged to the
  toolbar because it was written inside it. If that count ever drops to zero,
  the widget contract has become fiction; there is a test guarding it.

**What Tier 0 cost, and what it returned.** Toolbar.tsx: 1021 → 40 lines.
index.ts: 3087 → 2543. Test count: 641 → 843. Every registry was worth doing on
its own merits before any mod exists, which was the claim.

### Tier 1 — out-of-process mods over a versioned scripts socket

Cheap, safe, and now more than half built. A mod is a process spaceterm spawns
from a manifest; it speaks JSON-lines over `scripts.sock`.

**Done:**
- ~~A version and capability handshake.~~ `SCRIPT_PROTOCOL_VERSION` /
  `MIN_SCRIPT_PROTOCOL_VERSION` and `script-hello`. A script is told "too old"
  or "too new" instead of half-understanding a reply.
- ~~A stable subscribe/event contract.~~ `SCRIPT_EVENTS` is a documented
  constant the broadcast helper is typed against, so emitting an undocumented
  event is a compile error. `spaceterm-cli protocol` reports the whole contract.
- ~~A readable capability surface.~~ `src/server/script-api.ts` — `ScriptHost`'s
  method list **is** what a mod can do to spaceterm. Adding a method widens the
  mod API, which is now a visible act rather than a new singleton reference in
  a 3000-line file. 45 tests cover the dispatch without a server.

**Still needed:**
- **A manifest** — name, version, protocol range, the command to run, what it
  subscribes to, what it may call.
- **Lifecycle**: spawn, health, restart-on-crash, and a way to be disabled
  without editing spaceterm.
- **Per-mod scoping of `ScriptHost`.** Today every connected script gets every
  capability. The manifest's "what it may call" is only meaningful if the
  host handed to a mod's connection is a subset. `ScriptApi` takes its host by
  constructor injection, so this is a per-connection host rather than a
  rewrite — but it is not free, and it is not security (see below), only
  blast-radius reduction.

Good fits: pollers and data feeds, notifications, external-service integrations,
automation, anything an agent should be able to trigger. Bad fit: anything that
draws.

### Tier 2 — renderer-side mods for UI

`ToolbarWidget` has moved this from "not worth attempting" to "the contract
exists and nine first-party widgets already satisfy it". What is still missing
is the transport: a standalone widget is a React component in this bundle, and
a mod's widget is not. The realistic first step is not arbitrary components but
a **declarative widget** — the mod supplies data over the scripts socket and
picks from a small set of renderers spaceterm already has (a metric, a
sparkline, a toggle). `DeltaSparkline` is already generic over any minute-keyed
monotonic series precisely so this is possible.

That is a much smaller thing than "renderer-side mods", and it covers the
sparkline case, which is the one that motivated the tier.

## Pilot conversions, in order

**1. The GitHub rate-limit sparkline.** Still the best first mod, and now four
fifths extracted. `RingBuffer` is its own module with 20 tests; the poller is
`gh-rate-limit.ts` with a deps seam and 24 tests; `DeltaSparkline` is generic
over any minute-keyed monotonic series; `GhRateLimitIndicator` is a standalone
toolbar widget that takes no props. What is left is exactly the mod lifecycle —
spawn the poller as a separate process and let it push readings over
`scripts.sock` — plus the declarative-widget step in Tier 2. That is the whole
point: the conversion is now *only* the parts a mod system has to provide.

**2. `git-status-poller`.** Data-only; it feeds `DirectoryCard` rather than
owning a widget. Easier than the sparkline but proves less. Deps seam and 22
tests, so the "don't extract before it has tests" rule below is satisfied.

**3. Voice / summary chat.** Already talks HTTP to an external service (Voice
Operator on `127.0.0.1`), already ~450 lines with its own lifecycle. The most
natural out-of-process citizen in the codebase. Deps seam and 37 tests. It is
also the feature that most needs the treatment for a *different* reason: it is
unavailable on any machine without the macOS Keychain and a running Voice
Operator, so making it a mod is also how it stops being a button that silently
does nothing for most users.

**4. Agent types.** `AgentDriver` exists and `AgentProvisioning` now owns the
plugin directories and config merges (`agent-provisioning.ts`, 47 tests), so
both halves are behind interfaces. A mod that adds an agent is the most
compelling demo and is now unblocked end to end.

## Preconditions — all four met

A mod API is a public contract. These were load-bearing before one could exist:

- ~~**State migrations.**~~ Done. `state-migrations.ts` runs an ordered pipeline
  and stamps the version; corrupt or newer-than-us documents are preserved
  rather than overwritten. A mod's first schema change is now survivable.
- ~~**Exhaustiveness checks.**~~ Done, and the split matters for mods
  specifically: `assertNever` throws for unions this process owns end to end,
  while `unhandledVariant` gives the same compile-time guarantee at a socket
  boundary but logs instead of throwing. That is the right posture for an API
  whose job is receiving messages from code you did not write — strict about our
  own drift, forgiving of theirs.
- ~~**Stable identifiers.**~~ Done. `NodeId`, `PtySessionId` and
  `ClaudeSessionId` are branded, so the `surfaceId`-vs-`nodeId` trap is a
  compile error rather than a comment. Branding found the code falling into it
  in two places. Mod authors will not inherit that ambiguity.
- ~~**Protocol versioning.**~~ Done for the surface that matters.
  `SCRIPT_PROTOCOL_VERSION` / `MIN_SCRIPT_PROTOCOL_VERSION` and a
  `script-hello` handshake mean a script can be told "too old" or "too new"
  instead of half-understanding a reply. `SCRIPT_EVENTS` closes the other
  Tier 1 gap: the event set is now a documented constant that
  `ScriptApi.broadcast` is typed against, so emitting an undocumented
  event is a compile error and `spaceterm-cli protocol` reports the whole
  contract. The *client* socket (`ClientMessage`/`ServerMessage`) is still
  unversioned — it does not need to be, since the Electron client ships with
  the server, but say so out loud if that ever stops being true.

**All four preconditions are met, and Tier 0 is complete.** A fifth thing has
quietly arrived too: **a mod is now testable**. The renderer runs under jsdom
against a fake preload bridge, and the whole app runs headlessly under Electron
— so "how would anyone verify a third-party widget" has an answer, which it did
not when this document was written. What remains for
Tier 1 is the mod *lifecycle*, not the contract: a manifest (name, version,
protocol range, command, subscriptions, permitted calls),
spawn/health/restart-on-crash, and a way to disable a mod without editing
spaceterm.

A fifth precondition emerged while building the registries, and it is not about
contracts at all:

- **A mod must be able to fail visibly.** `capabilities.ts` was written for
  first-party integrations — it reports at startup which of `gh`, the macOS
  Keychain, Voice Operator, `pgrep` and `lsof` are present, and *what stops
  working without each one*. That is exactly the reporting a mod needs. A mod
  that crashes, is disabled, or cannot reach its service must show up somewhere
  the user will look, or "removability" turns into "features that vanish
  without explanation". The existing `Capability` shape
  (`id`/`name`/`available`/`detail`/`affects`) generalises to mods unchanged.

## Security: say the true thing

Spaceterm spawns PTYs with `--dangerously-skip-permissions` (Claude), `--yolo --trust`
(Cursor) and `--dangerously-bypass-*` (Codex). Any mod that can spawn a surface can
run arbitrary commands as you. There is no sandbox to be had here, and pretending
otherwise would be worse than not trying.

So: **mods are trusted code, exactly like the repo is.** What out-of-process actually
buys is not security — it is *stability* (a crashing mod does not take the server
down), *removability* (delete a directory instead of reverting 11 files), and
*independent iteration*. Those are the honest selling points. Write them down as such
so a future contributor does not mistake the socket boundary for a trust boundary.

Two consequences worth stating now rather than discovering later:

- **Per-mod host scoping is blast-radius control, not a permission system.** If
  a manifest says a mod may not spawn surfaces, that stops an *honest* mod from
  spawning one by accident. It does not stop a hostile one, because the mod
  already runs as you. Say which of the two you are buying.
- **The moment mods can be installed from anywhere but your own disk, the
  honest answer changes** — not because the boundary changed, but because
  "trusted code, exactly like the repo is" stops being true. There is no need
  to solve that now; there is a need not to build an install-from-URL flow
  without noticing that it crosses this line.

## What not to do

- **Do not build a plugin loader first.** Tier 0 with no dynamic loading is most of
  the benefit at a fraction of the risk, and it is a prerequisite anyway.
- **Do not make the first mod a UI widget.** `ToolbarWidget` makes this less true
  than it was — nine standalone widgets satisfy a real contract, and the
  renderer now has 211 tests plus an Electron E2E suite, so a widget is no
  longer unverifiable. But `App.tsx` still prop-drills 53 props into
  `TerminalCard`, and a data-only mod feeding an existing surface still gets
  most of the value for a fraction of the work.
- **Do not turn the three registries into dynamic registries yet.** `AGENT_TYPES`,
  `CARD_TYPES` and `TOOLBAR_WIDGETS` are const arrays, and a registry nobody
  registers into is just a slower array. Make each mutable when the first mod
  needs it — the change is small and the shape is already right.
- **Do not extract a feature into a mod before it has tests.** You lose the only
  signal that the conversion preserved behaviour. `RingBuffer` was extracted and
  tested first, on purpose; do it in that order.
- **Do not add a mod API to `index.ts`.** It is the file the mod system exists to
  shrink.
