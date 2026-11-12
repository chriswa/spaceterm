# Garbled screens after a server restart

## Status: diagnosed, not fixed

## Symptom

After a server restart, some long-running Claude Code surfaces show a screen
made of two layers: the current UI where Claude Code has repainted recently, and
stale text elsewhere, with odd single characters written over it. Observed on
2026-11-03 on `191e183c` (Claude Code, 160×45, over four hours old). The rows
below the prompt read like

```
  This is sxpsting behsviour:5run record⧉ in the oldgLoopssystemashow the same ids to loop readers.
  - Pro:rno-work,sandWittmatches Loops..done status file          4h 21m 59s · ↓ 265.3k tokens
```

where the real screen there is the separator, `⏵⏵ bypass permissions on …`,
`⏺ main`, and the background-agent rows. The garbage is what the old screen
held; the stray letters are the cells Claude Code's diff renderer updated.

The garbling does not go away by itself. Every attach shows it again, because
attach serializes the same server emulator.

## Root cause

1. The pty daemon keeps a 1MB ring of raw bytes per session
   (`pty-daemon/ringbuf.go`). When it wraps, the oldest bytes are overwritten at
   an arbitrary offset. No ANSI state, cursor position or screen contents are
   kept for what was dropped.
2. On server startup, `reattachSurface` (`src/server/index.ts`) feeds that ring
   into a fresh headless xterm in `SnapshotManager`. When the ring has wrapped,
   that replay starts in the middle of the stream, from a blank screen with the
   cursor at the origin.
3. Claude Code repaints by cell diffs relative to what it believes is on
   screen, e.g. `ESC[H CR ESC[138C ESC[42B` + one character. A wrong starting
   screen is never corrected; only a full repaint (resize, probably) would
   clear it.
4. Client attach (`serializeForAttach`) serializes that emulator, so every
   client inherits the bad screen.

Evidence: on 2026-11-03 18 of 36 daemon sessions had full rings (exactly
1,048,576 bytes), `191e183c` among them, and the server had restarted at 12:21
PT. Replaying that session's *current* ring into a fresh 160×45
`@xterm/headless` rendered correctly, since Claude Code had done full repaints
since, which places the bad state in the emulator seeded at restart, not in
the bytes.

The server's `ScrollbackBuffer` is not involved. It already folds the evicted
prefix's ANSI state forward (`src/server/ansi-state.ts`, see
`ansi-preservation.md`), and attach no longer replays it; it is read only for
the output tail and by the script API. The daemon ring has no equivalent, and
it is the only source of truth across a server restart.

## Fix ideas

The goal: when the replayed history is truncated, it should start with a
synthesized full redraw of the screen as it was at the cut (contents, SGR,
modes, scroll region, cursor), so anything the application never rewrites is
still correct.

### A. Server checkpoints (preferred)

The server's emulator is already correct for as long as the server lives, and
`@xterm/addon-serialize` already turns it into a redraw.

- The daemon keeps a monotonic count of bytes written per session and returns
  it with `attached` (and with output, or on request).
- The server periodically, and on shutdown, writes each session's serialized
  state plus the byte offset it covers to disk.
- On restart, the server loads the checkpoint, asks for the ring, and replays
  only the bytes past the checkpoint offset. If the offset has fallen out of the
  ring (more than 1MB since the checkpoint), fall back to today's behaviour.

Open questions:
- The daemon change means rebuilding and restarting the daemon, which kills
  every pty. It needs a rollout plan (ship before a planned daemon restart) and
  a server that tolerates an old daemon without the counter.
- Checkpoint cadence, and what a crash between checkpoints costs (at most the
  bytes since the last one, as long as they are still in the ring).
- A checkpoint and the offset it claims must be taken at the same parse point:
  reuse the drain barrier `serializeForAttach` already uses.

Matching the checkpoint against the ring by a byte fingerprint of its tail,
which would avoid the daemon change, is unsafe: Claude Code's spinner and
status updates repeat byte for byte, so a match can land on the wrong copy.

### B. Synthesize in the daemon

When the ring wraps, a lagging terminal emulator in Go takes in the evicted
bytes, and `Contents()` prepends its rendering as a full redraw. This is
self-contained and survives anything the server does, but it needs a Go VT
emulator whose behaviour matches xterm.js closely enough, which is a large
surface for subtle divergence of exactly the kind this bug is.

### Interim mitigation

After reattaching a surface whose ring was full, force a full repaint
(e.g. a resize to the same size or a nudge of one row and back, to send
SIGWINCH). The server deliberately avoids a SIGWINCH to every surviving agent at
boot, so restrict it to sessions whose ring has wrapped, and check that
Claude Code actually repaints the whole screen on SIGWINCH before relying on it.
