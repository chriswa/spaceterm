# Docs

Notes that outlive the session that wrote them. Start with the root
`README.md`, then `NEXT_STEPS.md` (the backlog) and `MODDING.md` (the extension
design), which stay at the root because `CLAUDE.md` points there.

- `design/` — how a built feature works and why: `agent-meta.md` (live
  CLAUDE.md / SKILL.md cards), `theme-mods.md` (themeable facets for mods).
- `ideas/` — designed but not built, with the alternatives already rejected:
  `browser-cards.md` (web pages on the canvas), `control.md` (Control, the
  voice receptionist: open work and V2).
- `investigations/` — a bug's analysis, kept for what the fix's tests assert:
  `ansi-preservation.md`.
- `performance/` — `potential-optimizations.md` (open leads and how to
  measure), `markdown-card-snapshots.md` (a deferred plan).
- `runbooks/` — `claude-session-recovery.md` (put a lost Claude session back on
  the canvas by hand).

Perf captures (`~/.spaceterm/perf-captures/`) are analysed with
`scripts/perf/analyze-trace.mjs` and `scripts/perf/deep-dive.mjs`.
