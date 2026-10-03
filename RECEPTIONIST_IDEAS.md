# Receptionist (Control): ideas and open work

Control is the voice receptionist in `src/server/receptionist/`. You talk to it
about every live Claude Code agent at once, and it quotes agents in their own
named voices ("Kevin here."), reads transcripts, asks disposable forks, sends
messages, watches agents, and starts new ones.

This file keeps what was decided *not* to build yet, so it isn't lost. The
vision, the decisions and the MVP were worked out in Claude Code session
`2d3dfd71-35d1-4fbf-a4ad-20366c55f8d5`
(https://claude.ai/code/session_01XJp71sx84yb5TYamiRkp1Z), October 2026. Read
that transcript for the reasoning behind any item here.

## How it works today (for orientation)

- **Brain**: Haiku (no thinking) in one long-lived `claude -p` session
  through claude-print-daemon, with the instructions as its system prompt
  (a changed prompt starts a new session). Each turn sends only what is new:
  events, the user's words, and NOTEs (how much of an interrupted reply was
  heard, or that a reply was talked over). The model answers with one JSON
  object: parts to speak and tool calls (`list_agents`, `find_agent`, `read`,
  `recall`, `ask_fork`, `monitor`, `send`, `interrupt`, `spawn`). Words that
  come with a blocking tool ("let me check") are spoken straight away.
  Messages to the session are queued, never overlapping.
- **Caching**: the daemon keeps the session's process live for an hour
  (`--keep-alive 60m --priority`), compacts it 55 minutes after the last
  turn so the compaction runs on a warm cache (`--auto-compact`), and above
  40k tokens of context (`--compact-above`). Verified: each turn reads the
  whole conversation so far from the 1-hour cache and writes only its own
  tail. Below Haiku's minimum cacheable size (about 4k tokens) nothing is
  cached, which costs little at that size.
- **Speech**: one Voice Operator job per reply, multi-voice (`parts`), through
  the `SpeechChannel` shared with Summary Chat. Interruptions cut the stored
  history down to what was heard.
- **Names**: lazily assigned, gender-matched name/voice pairs from the roster
  ported out of Voice Operator (`name-voice-table.ts`, `name-registry.ts`).
  Sticky until the surface is archived; released at the next assignment.
  `af_heart` is reserved for Control.
- **Forks**: `SessionForks` (`session-fork.ts`) runs
  `claude -p --resume <session> --fork-session` with the surface's *own*
  command line from the claude driver, plus a PreToolUse guard hook
  (`fork-read-only-guard.sh`) that only allows Read/Grep/Glob. Using the
  surface's own flags is what makes a fork read the agent's prompt cache:
  roughly $0.09 for a 300k-token Opus session instead of $1.51. Every fork
  and follow-up raises a toast with its cost.
- **Sending**: Ship it into the agent's PTY; Escape to interrupt. Every send
  and spawn is logged to `~/.spaceterm/receptionist/log.jsonl` and
  auto-monitored.
- **Memory**: the session holds the conversation. `conversation.jsonl`
  under `~/.spaceterm/receptionist/` is the full record of every message,
  sends and spawns included, never trimmed, for `recall`, since compaction
  forgets detail. `session.json` holds the session id; `names.json` the
  names. (`history.json` is left over from the earlier design and unused.)
  Talk-to-me is a ServerState setting; the voice target defaults to Control
  on every server start.
- **Misheard names**: no deterministic layer. The prompt says input is
  dictated, gives examples ("heaven" for Evan), and asks Control to confirm
  when unsure. The registry still never assigns two sound-alike names at once
  (`name-phonetics.ts`).

## MVP leftovers (small, not done)

- **Fork cleanup.** Fork transcripts accumulate under `~/.claude/projects` and
  show up in `claude --resume` lists. Nothing ever deletes them. Forks are
  also tracked only in memory, so a follow-up to a fork made before a server
  restart re-forks instead.
- **Jev is not installed on this Mac.** `find_agent` asks Jev (the same
  chooser as the agent search box) and falls back to `list_agents` when it
  fails, which costs a wasted model step. Needs the `jev` CLI on PATH and
  `TYPESAFE_API_KEY` in the login environment.
- **Compaction only half-reuses the cache.** The daemon's `/compact` call
  reads the cache only up to the end of the session's first user message
  and pays for the rest uncached. Rare, and cheap on Haiku, but worth a look
  before moving to Sonnet.
- **The worked example in the prompt** quotes an agent straight from the
  roster preview without a `read`, which slightly contradicts the
  "read before quoting" rule.
- **Spoken acknowledgement for spawn.** A reply that sends and says nothing
  gets an automatic "Sent to Kevin."; a silent spawn gets nothing.

## V2 and beyond

- **Raise-hand mode.** The other half of talk-to-me: an inbox-style signal
  that Control wants to talk, *without* deciding what it will say until you
  come to it (by then there may be more news). A toolbar toggle chooses
  between raise-hand and talk-to-me.
- **Permission prompts by voice** (`waiting_permission`). Explicitly out of
  MVP. Also `waiting_question` / AskUserQuestion answers.
- **Smarter recall.** `recall` is a plain substring search, newest first.
  Ideas: search by time ("last night"), and read a stretch of the record
  around a hit.
- **Benchmark Haiku against Sonnet**, with and without thinking and at a few
  Sonnet effort levels, now that turns read the cache. The model is one line
  (`RECEPTIONIST_MODEL` in `real-deps.ts`).
- **Fork lineage.** Record where in a transcript a session was forked and from
  which session, so Control knows "this agent was forked from Kevin", across
  chains of forks.
- **Fork answers back to the agent.** Ask a copy, then hand the useful part to
  the real agent as an instruction.
- **Cost and cache awareness.** Let Control weigh an agent's context size,
  cache warmth (already in Spaceterm's state) and model price before forking
  or waking it.
- **Wider reach.** Archived agents, and Codex and Cursor surfaces. Plain
  terminals stay out.
- **Half-written prompts.** A send pastes on top of whatever is already in
  the agent's input box.
- **Replace Summary Chat.** Control is meant to replace it; for now they
  coexist and a Summary Chat press takes the voice target.
- **Forks through the daemon: decided against.** Each fork question is one
  cold `claude -p` process (about 3 s). The daemon is fast because it keeps
  *empty* sessions warm, and a fork is never empty; its fixed profile (no
  system prompt, no tools) is also what broke caching. The `--fork` option
  added to it was reverted.

## Rough edges not yet looked at

- While Control is the voice target, Summary Chat's "target" indicator on the
  cards (which surface follow-ups would go to) is hidden, because follow-ups
  go to Control instead.
- After the camera follows an agent, keyboard focus stays on whichever
  terminal had it, which may now be off screen.
- Status errors show only as a toast.
- The phone may not play Control's waiting echo; the cue lives in the
  desktop renderer's server-sync.

## Open question

- **Why forks cost what they cost.** A fork re-sends the agent's whole
  context. With a cache hit that context is billed at the cache-read rate
  (a 300k-token Opus session came to about $0.09). A follow-up that makes
  several model calls pays that read once per call. Before the fix, forks
  missed the cache entirely and paid cache *writes* on everything, hence
  $1.51. The toasts are there to keep an eye on it; whether 1-hour cache
  writes, thinking tokens, or long tool loops dominate is still unmeasured.
