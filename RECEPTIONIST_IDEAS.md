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

- **Brain**: Haiku through claude-print-daemon, no thinking. Each turn the
  model sees the roster of live Claude surfaces and the directory nodes, and
  answers with one JSON object: parts to speak, and tool calls (`read`,
  `recall`, `ask_fork`, `monitor`, `send`, `interrupt`, `spawn`). See
  `prompt.ts`. Words that come with a `read`/`recall` ("let me check") are
  spoken straight away, ahead of the answer.
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
- **Memory**: three layers under `~/.spaceterm/receptionist/`.
  `conversation.jsonl` is the full record of every message, sends and spawns
  included, never trimmed; `recall` searches it. `history.json` is the
  working memory: a bounded window (24 messages / 40k chars) plus a running
  summary that Haiku folds aged-out messages into, off the turn path.
  Names live in `names.json`. Talk-to-me is a ServerState setting; the voice
  target defaults to Control on every server start.
- **Misheard names**: no deterministic layer. The prompt says input is
  dictated, gives examples ("heaven" for Evan), and asks Control to confirm
  when unsure. The registry still never assigns two sound-alike names at once
  (`name-phonetics.ts`).

## MVP leftovers (small, not done)

- **Fork cleanup.** Fork transcripts accumulate under `~/.claude/projects` and
  show up in `claude --resume` lists. Nothing ever deletes them. Forks are
  also tracked only in memory, so a follow-up to a fork made before a server
  restart re-forks instead.
- **Jev for disambiguation.** Haiku alone picks which agent you mean.
  `agent-search.ts` already has a two-pass Jev chooser with a "none of these"
  probability; it could back Haiku up on close calls.
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
- **Smarter memory.** Compaction and `recall` exist; `recall` is a plain
  substring search, newest first. Ideas: search by time ("last night"), read
  a stretch of the record around a hit, and, if Control moves to Sonnet,
  compact a big session just before its prompt cache's TTL expires.
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
