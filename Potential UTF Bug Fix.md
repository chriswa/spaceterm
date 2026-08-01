# Potential UTF-8 Bug Fix — investigated, mostly already fixed

**Status: the sanitizer proposed here is not needed. One real defect was found
next door and is fixed. Kept for the reasoning.**

## What was proposed

That xterm.js decodes UTF-8 before parsing escape sequences, so a broken
multi-byte sequence with an ESC (0x1B) in the middle could have the ESC consumed
as a continuation byte — corrupting the character, swallowing the escape, and
throwing off cursor tracking for the rest of the line. The fix was to be a
preprocessing sanitizer before `term.write()` that (1) buffers incomplete
trailing bytes across chunks and (2) flushes a partial sequence as U+FFFD when
an ESC arrives where a continuation byte was expected.

## What is actually true

**(1) is already done, in the daemon.** `pty-daemon/session.go` holds back an
incomplete trailing sequence via `incompleteUTF8Tail` and prepends it to the
next read, so a multi-byte character is never split across a JSON message. That
landed after this note was written. `ringbuf.go` also skips orphaned leading
continuation bytes when the scrollback ring wraps mid-character.

**(2) does not reproduce.** Driving `@xterm/headless` directly with the exact
byte sequence — `e2 94` followed immediately by `1b 5b 33 31 6d` — the SGR is
parsed and applied normally. Same result when the bytes are split across two
writes at the worst possible point, and same result on the string path with the
invalid bytes already replaced by U+FFFD (which is what spaceterm actually
delivers, since Go's `json.Marshal` substitutes them). ESC terminates the
partial sequence correctly in every case. Either the premise was wrong or
xterm.js fixed it upstream; either way there is nothing to sanitize, and adding
a preprocessing layer would be speculative complexity in the hottest path in
the app.

## The real defect this turned up

The note's closing line — "ensure the `@xterm/addon-unicode11` is loaded
(currently missing)" — was half right. `TerminalCard.tsx` does load it. The
*headless* terminal in `snapshot-manager.ts` did not, so it was still on
Unicode 6.0 width tables.

That is a genuine desync, measured rather than assumed:

| | Unicode 6 (headless) | Unicode 11 (visible) |
|---|---|---|
| 😀 | 1 cell | 2 cells |
| ✅ | 1 cell | 2 cells |
| 🎉 | 1 cell | 2 cells |
| → | 1 cell | 1 cell |

Any line containing an emoji laid out differently in the snapshot than on
screen, and everything after it on that line was shifted by one column per
emoji. Since snapshots are what a client in snapshot mode renders — and what a
re-attaching client sees first — the terminal visibly jumped when it switched
back to live. Fixed by loading `Unicode11Addon` and setting
`unicode.activeVersion = '11'` on the headless terminal too, with tests.

## Still open

`@xterm/addon-unicode-graphemes` (grapheme clusters, mode 2027) would improve
width calculation for compound emoji — ZWJ sequences like 👨‍👩‍👧 are still
measured per-component. Check whether it has been published to npm since; it had
not as of late 2024. Lower priority than the above, since the two emulators now
at least agree with each other.
