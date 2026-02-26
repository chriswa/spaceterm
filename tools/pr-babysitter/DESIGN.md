# PR Babysitter — Design Spec

## Overview

A spaceterm external script that polls `pr-check` in a loop and injects first-person messages into a Claude Code session to remediate PR blockers. The loop is deterministic (bash/bun), so Claude's context only grows when there's real work to do. Claude signals completion via `spaceterm broadcast`.

## Architecture

```
Babysitter Script (spaceterm node)        Claude Code (parent node)
──────────────────────────────────        ────────────────────────
loop:
  pr-check <URL> → parse JSON
  categorize blockers

  if loop → sleep 5 min, continue
  if terminal → ship final msg, exit
  if halt → ship msg, exit
  if remediate:
    ship first-person msg ──────────────→ Claude receives "user" message
    subscribe to events                   Claude works on the problem
    wait for broadcast... ←──────────────── Claude: spaceterm broadcast "babysitter:resume"
    continue loop
```

## pr-check Contract

`pr-check <PR_URL>` outputs JSON to stdout:

```json
{ "blockers": ["Draft", "Tests", "-auto-merge"], "failedTestUrls": ["https://..."] }
```

PR metadata goes to stderr (ignored by the script).

### All known blocker strings

- Group 0 (Queue/Draft): `In Merge Queue`, `Draft`
- Group 1 (Critical): `Conflicts`, `Tests`, `Self Comment`, `Dequeued`
- Group 2 (Team tooling): `Checklist`, `Linear`, `Safety`, `Breaking`, `Security`
- Group 3 (CI/Bots): `CodeRabbit`, `Meticulous`
- Group 4 (Human decisions): `-1 Review`, `-2 Reviews`, `Nutshell`, `-auto-merge`, `Changes requested`
- Group 5 (Unsettled): `Tests Unsettled`, `Meticulous Unsettled`, `Checklist Unsettled`, `Linear Unsettled`, `Safety Unsettled`, `Breaking Unsettled`, `Security Unsettled`
- Group 6 (Terminal): `Merged`, `Closed`
- Group 7 (Waiting): `CI Unsettled`, `Merge Queue Pending`

## Two Modes (Inferred from Blockers)

The presence of `"Draft"` in the blocker list means the PR is in draft state.

### Draft Mode Ignore List

| Blocker | Why ignored |
|---|---|
| `Draft` | Expected — it's a draft |
| `-auto-merge` | Not needed until ready to merge |
| `-1 Approval` / `-2 Approvals` | Approvals come after undrafting |
| `-1 Reviewers` | User adds reviewers when ready |
| `Checklist` / `Checklist Unsettled` | Author fills this when ready |
| `Meticulous` / `Meticulous Unsettled` | Visual diffs matter at review time |
| `Nutshell` | Only relevant when merging |

### Ready Mode

When `Draft` is **not** present, all blockers are meaningful — but they surface in a staged order, not all at once.

## Staged Flow (Ready Mode)

Blockers are surfaced in a strict pipeline. Later-stage items are suppressed while earlier-stage items are still active. This prevents premature actions (e.g. adding auto-merge while tests are still running).

```
Stage 1: Unsettled       While any automated check is unsettled → WAIT
                          Don't surface any human-decision blockers.

Stage 2: Automated       After everything settles, if there are failures
                          (Tests, CodeRabbit, Safety, etc.) → REMEDIATE

Stage 3: Comments         After automated stuff passes, resolve outstanding
                          PR comment threads (Self Comment, Review Comments,
                          Changes requested).

Stage 4: Reviewers        After comments are dealt with, if reviewers are
                          missing → HALT, tell user to add reviewers.

Stage 5: Wait for reviews Spin waiting for reviews to come in.
                          Nothing for Claude to do here.

Stage 6: Auto-merge       After reviews come in and auto-merge is the
                          ONLY remaining blocker → HALT, tell user to
                          add the auto-merge label.
```

**Implementation**: `computeTriage()` in pr-check's `display.ts` enforces this by suppressing group 4 (human decisions) items from `halt` while earlier-stage `wait` or `remediate` items exist. `-auto-merge` is only surfaced when it is the sole remaining actionable blocker across all categories.

## Git Discipline

The repo has a CI auto-linter that pushes formatting changes to branches. This means the remote branch can change under us at any time.

### Always pull before making changes
Before starting any local modifications (test fixes, review feedback, conflict resolution), always `git pull` to pick up any commits the auto-linter (or other CI) may have pushed.

### Never rebase or force-push
The "changes since last review" incremental diff on GitHub is sacred. **Never rebase, amend, or force-push.** Always use merge commits to integrate upstream changes. This applies everywhere — not just when handling the `Conflicts` blocker, but any time we encounter conflicts while pushing our own fixes.

### Conflict recovery during push
If `git push` fails due to new remote commits:
1. `git pull --no-rebase` (merge, never rebase)
2. Resolve any conflicts from the merge
3. Push again
4. If conflicts are non-trivial, halt and present to user

## Blocker Response Categories

### 1. Loop (keep polling)

- **`In Merge Queue`** — PR is queued, just wait
- **`CI Unsettled`** — checks haven't started, wait
- **`Merge Queue Pending`** — everything passed, waiting for merge queue
- **`-1 Approval` / `-2 Approvals`** — needs human approvals, nothing Claude can do
- **`Nutshell`** — needs specific approver, nothing Claude can do
- **Any `* Unsettled` blocker** (that isn't draft-ignored) — CI still running, wait for it to settle
- **All blockers are in the ignore list** → draft-clean terminal condition

### 2. Auto-Remediate

#### `Dequeued` (kicked from merge queue)
Post `@mergifyio requeue` as a PR comment to re-enter the queue.

#### `Tests` (CI failure)
1. Spawn a subagent to pull CI logs and identify the failure
2. Subagent returns findings to main context
3. Main context evaluates: simple fix (typo, import, lint, test assertion) vs. design decision
4. **Simple fix**: apply fix, push, resume poll loop
5. **Design decision**: halt, present findings to user

#### `CodeRabbit` or `Changes requested` (review feedback)
1. Spawn a subagent to fetch and triage each review comment
2. Categorize each comment:
   - **(A) Out of scope** — comment is about code outside this PR's intent
   - **(B) Wrong** — review comment is incorrect
   - **(C) Valid concern** — legitimate issue
3. For C comments, evaluate: easy fix vs. design decision
4. If all actionable items are easy C fixes: apply fixes, compile a report with drafted replies for A/B comments
5. Otherwise: compile a full report for the user with each comment's category, proposed fixes for Cs, and drafted replies for A/Bs
6. User reviews, approves replies, and decides whether to push

**Key difference — deference level:**
- **CodeRabbit**: Treat as a helpful but fallible bot. Freely categorize as (B) when the suggestion is wrong or misguided. If all items are easy Cs, auto-push but **halt after pushing** so the user can review the changes.
- **Human reviewer**: Never auto-classify as (B) wrong — present the comment to the user and let them make that call. May auto-push easy C fixes, but **always halt after pushing** to alert the user so they can review the changes and ask the human reviewer(s) to re-review.

#### `Conflicts` (merge conflicts)
Resolve by merging master into the branch (see Git Discipline above for why never rebase).
1. `git pull` then `git merge master` into the PR branch
2. If resolution is straightforward (no content conflicts in modified lines): push, halt to notify user
3. If conflicts require judgment: halt, present conflict details to user

#### `Linear` (missing associated issue)
1. Check if branch name contains a ticket ID pattern
2. If found: could potentially associate it
3. Otherwise: alert user

#### `Self Comment` (unresolved author comments)
1. Look at unresolved self-comments on the PR
2. For each: fix the issue, 👍 the comment, resolve the thread
3. If any need actual work: halt for user

#### Comment acknowledgment convention
All comment-related blockers (Self Comment, CodeRabbit, Changes requested, Review Comments) use a two-layer acknowledgment:
- **👍 reaction** on individual comments — marks which comments have been addressed. Essential for reopened threads where old 👍'd comments are stale context and new un-👍'd comments need attention.
- **Thread resolution** via `resolveReviewThread` GraphQL mutation — marks the whole thread as done. `pr-check` skips resolved threads, which breaks the re-flagging loop.

### 3. Halt (stop the loop and notify user)

| Blocker | Message |
|---|---|
| `Merged` | PR merged successfully |
| `Closed` | PR was closed |
| `Security` | Security scan failure — needs review |
| `Breaking` | Breaking API change — intentional? |
| `Safety` | Safety check failure |
| `-1 Reviewers` (ready mode) | Reviewers need to be added to the PR (only surfaced after all automated checks pass) |
| `-auto-merge` (ready mode) | Label missing — **only surfaced when this is the sole remaining actionable blocker** |
| `Checklist` (ready mode) | PR checklist incomplete |
| All blockers ignored (draft mode) | Draft PR is clean — all draft-mode checks pass |

## Handoff Protocol

After shipping a remediation message, the script waits for Claude to signal via `spaceterm broadcast`:
- `"babysitter:resume"` — Claude is done, resume polling
- `"babysitter:halt"` — Claude needs user attention, script exits

If Claude stops (`claudeState: 'stopped'`) without broadcasting, the script nudges after 5 seconds. After 2 failed nudges or a 30-minute timeout, the script exits.

## Script Invocation

```bash
pr-babysitter <PR_URL>
```

Run as a spaceterm node alongside a Claude Code parent session.

## Open Questions

- Should `Checklist` be auto-remediable in ready mode?
- Should the sleep interval be configurable?

## Future Exploration

- **Auto-tag user for review after pushing changes**: When the babysitter pushes fixes and halts, it could automatically request the user's review on GitHub. Requires careful guardrails:
  - (A) Must not make it easy for the agent to also tag *other* humans for review — the mechanism should be scoped exclusively to the PR author
  - (B) Must not result in the user's own approval counting toward the required human approval count, which would be dishonourable
