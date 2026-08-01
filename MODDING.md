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
is 3061 lines and `Toolbar.tsx` is 1021 lines of which the actual toolbar is 65.

A mod system is worth building exactly to the extent that it drives that 45% to
near zero. That is the number to measure against, not "do we have plugins".

## What already exists

Three extension surfaces, none of them called that:

**1. The scripts socket — this is already a mod API.**
`~/.spaceterm/scripts.sock`, JSON-lines, seven message types (`ScriptMessage`,
`protocol.ts:813`). It already supports subscribing to events
(`ScriptSubscribeMessage` → `broadcastToScriptSubscribers`). And there are already
**nine tools written against it**, in `src/claude-code-plugin/mcp-server/`: spawn a
surface, fork a surface, emit a markdown card, emit one onto the parent, resolve
handoff context, broadcast, play a sound, speak, read surface env.

That is a mod. It runs out-of-process, loads no code into spaceterm, and does real
work. The MCP server is spaceterm's first mod and nobody called it one.

**2. The hooks/ingest socket.** `IngestMessage`, ten types. How agent hook handlers
push state in. Also out-of-process — the producers are shell scripts.

**3. The three agent plugin directories.** `claude-code-plugin/`,
`cursor-agent-plugin/`, `codex-agent-plugin/`. Note these are plugins *for other
tools*, provisioned by spaceterm into `~/.cursor/` and `~/.codex/`. They are not
spaceterm mods, but they prove the project already thinks in terms of pluggable agent
integrations.

## The three things that are secretly plugin points

Each of these is a place where adding a variant means editing many files. That is the
signature of a missing registry.

**Agent types** (`claude` | `cursor` | `codex`) — the strongest candidate.
The literal `'claude' | 'cursor' | 'codex'` appears **ten times** across the codebase
rather than being exported once as an `AgentType`. Adding an agent
today means editing six spawn-dispatch sites, five watcher-wiring sites, three label
ternaries, two icon dispatches, plus capability gates mirrored on the client. Two
functions (`lastCursorSessionId`, `lastCodexSessionId`) are byte-for-byte identical.
Commit `bffb2e3` ("Add Cursor and Codex agent surfaces") touched **37 files**.

An `AgentDriver` registry — `Record<AgentType, AgentDriver>` with `label`, `icon`,
`buildCreateOptions`, `provision`, `resolveResumeId`, `createWatcher`, and a
`capabilities` block — absorbs essentially all of it. This is both the review's #1
recommendation and the single most mod-shaped thing in the codebase.

**Node / card types** (`terminal` | `markdown` | `directory` | `file` | `title`).
Adding one touches `state.ts`, `protocol.ts`, `node-size.ts`, `node-placement`,
`state-manager`, `App.tsx`'s five near-identical card maps, and `AddNodeBody`. A
`CardType` registry would carry: pixel-size function, default spawn payload,
add-menu entry, and the React component.

**Toolbar widgets.** `Toolbar.tsx` is 1021 lines, of which the exported `Toolbar`
component is 66 (`:52-117`). The rest are unrelated tenants — a 416-line `CrabGroup`
(`:388-803`) that is simultaneously a FLIP animation, a rAF dance loop, a
drag-to-reorder implementation and a nav-indicator state machine; a ~160-line GitHub
rate-limit charting module with zero coupling to the toolbar; and nine inline SVG
icons.

## Recommended shape, in order

### Tier 0 — internal registries (prerequisite, no mod loading)

`AgentDriver`, `CardType`, `ToolbarWidget`. **Every first-party feature must be
registered through them, not special-cased.** No dynamic loading yet, no manifest, no
API surface — just the seams. If the registries cannot express the features you
already have, they cannot express a mod's either, and you will find that out cheaply.

This tier is worth doing on its own merits even if mods never happen. It is the same
work as breaking up `index.ts` and `Toolbar.tsx`.

### Tier 1 — out-of-process mods over a versioned scripts socket

Cheap, safe, and half-built. A mod is a process spaceterm spawns from a manifest; it
speaks JSON-lines over `scripts.sock`.

Needed to make it real:
- **A version and capability handshake.** There is no version field anywhere in the
  105 message variants today. Without one, the first mod written freezes the protocol
  by accident.
- **A stable subscribe/event contract.** `ScriptSubscribeMessage` exists; it needs a
  documented event set rather than whatever `broadcastToScriptSubscribers` happens to
  emit.
- **A manifest** — name, version, protocol range, the command to run, what it
  subscribes to, what it may call.
- **Lifecycle**: spawn, health, restart-on-crash, and a way to be disabled without
  editing spaceterm.

Good fits: pollers and data feeds, notifications, external-service integrations,
automation, anything an agent should be able to trigger. Bad fit: anything that draws.

### Tier 2 — renderer-side mods for UI

Only worth attempting after Tier 0 exists, because a widget contract without a widget
registry is nothing. This is where the GitHub sparkline's "how does a mod draw?"
problem gets solved. Defer it; a data-only mod that feeds an existing surface gets
most of the value.

## Pilot conversions, in order

**1. The GitHub rate-limit sparkline.** The best first mod, because it is the exact
shape of the feature that `653cd1d` had to tear out of five layers, and because half
of it is already extracted (`RingBuffer` now lives in `ring-buffer.ts` with 20 tests).
It is a poller shelling out to `gh`, a ring buffer, one protocol message, one store,
and one widget — small enough to finish, complete enough to prove the API including
the awkward widget half.

**2. `git-status-poller`.** Data-only; it feeds `DirectoryCard` rather than owning a
widget. Easier than the sparkline but proves less.

**3. Voice / summary chat.** Already talks HTTP to an external service (Voice Operator
on `127.0.0.1`), already ~450 lines with its own lifecycle. The most natural
out-of-process citizen in the codebase.

**4. Agent types**, once `AgentDriver` exists — a mod that adds an agent is the most
compelling demo, and the per-agent shell hook handlers are already separate files.

## Preconditions — be honest about these

A mod API is a public contract. These are load-bearing before one exists:

- **Protocol versioning.** None today.
- **State migrations.** `STATE_VERSION` is written into the persisted state
  (`state-manager.ts:21`, `:90`) and **never read back**. Mods will read and write
  node state; without a migration path the first schema change breaks every mod.
- **Exhaustiveness checks.** Zero in the codebase. `handleIngestMessage` has no
  `default`, so unknown messages vanish silently — a terrible property for an API
  whose whole job is receiving messages from code you did not write.
- **Stable identifiers.** `surfaceId` vs `nodeId` is currently a documented trap
  (`protocol.ts:802`) that the code itself falls into (`index.ts:740`). Do not export
  that ambiguity to mod authors.

Items 1, 2 and 3 are also on the "make it more serious" list in `NEXT_STEPS.md` —
they are worth doing regardless, which is a good sign this is the right direction.

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

## What not to do

- **Do not build a plugin loader first.** Tier 0 with no dynamic loading is most of
  the benefit at a fraction of the risk, and it is a prerequisite anyway.
- **Do not make the first mod a UI widget.** The rendering path is the least ready
  part of the codebase (`App.tsx` still prop-drills 53 props into `TerminalCard`).
- **Do not extract a feature into a mod before it has tests.** You lose the only
  signal that the conversion preserved behaviour. `RingBuffer` was extracted and
  tested first, on purpose; do it in that order.
- **Do not add a mod API to `index.ts`.** It is the file the mod system exists to
  shrink.
