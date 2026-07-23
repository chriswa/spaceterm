---
description: Summarize what this forked surface learned/decided since it branched and place a handoff card on its parent surface (review, then "Ship it"). Run inside a forked surface.
---

# Fork handoff

This surface was **forked** from a parent surface: the two shared a common
history, then diverged. This command distills everything that happened on
**this** side of the fork into a compact handoff and drops it as a markdown card
on the **parent** surface, where the user reviews it and clicks **"Ship it"** to
inject it into the parent conversation.

## How it works

Do **not** summarize the transcript yourself. Spawn a single distiller sub-agent
so this surface's own context stays clean — it reads the post-fork transcript off
disk and emits the card directly. Your only jobs are to launch it and relay the
result.

## Procedure

1. Use the **Task/Agent tool** to spawn **one** general-purpose sub-agent. Pass it
   the prompt below **verbatim** (it is fully self-contained — the sub-agent
   resolves the transcript path, the fork point, and the parent surface itself):

   ---
   You are a distiller. Your job is to summarize what a forked Claude Code surface
   learned and decided since it forked, and emit that summary as a card on its
   parent surface. Your final message is not shown to a human — keep it to one line.

   **Step 1 — Resolve context.** Call `resolve_handoff_context`. It returns
   `{ transcriptPath, isFork, targetSurface }`.
   - If `isFork` is false, STOP. Return: "Not a fork — nothing to hand off."
   - If `targetSurface` is null, STOP. Return: "No parent surface to hand off to."
   - If `targetSurface.alive` is false, continue but note it in your final line
     (the card will land on a dead surface and can't be shipped until it's live).

   **Step 2 — Extract the post-fork messages.** The fork stamps `forkedFrom` on
   every entry copied from before the fork; entries written after the fork lack it.
   Take only real user/assistant prose (no tool calls, no tool results). Run,
   substituting the real `transcriptPath`, and writing to a temp file:

   ```bash
   jq -rc '
     select(.forkedFrom == null)
     | select(.type == "user" or .type == "assistant")
     | . as $e
     | (if ($e.message.content | type) == "string"
          then $e.message.content
          else ([$e.message.content[]? | select(.type == "text") | .text] | join("\n"))
        end) as $text
     | select($text != null and ($text | test("\\S")))
     | "## " + ($e.message.role | ascii_upcase) + "\n\n" + $text
   ' "TRANSCRIPT_PATH_HERE" > "${TMPDIR:-/tmp}/fork-handoff-slice.md"
   ```

   Then Read that file. If it is empty, STOP and return: "No post-fork activity to
   hand off."

   **Step 3 — Distill.** Write a handoff (a few short sections, markdown). Capture
   only what the parent needs: **decisions made**, **facts/knowledge established**,
   and the **current state / open threads**. Do NOT include tool mechanics,
   step-by-step narration, or alternatives that were considered and dropped. Be
   concise and information-dense.

   **Step 4 — Wrap.** Prepend exactly this line, then a blank line, then your
   handoff body:
   `The following is a summary of information from a sub-agent.`
   After the body, add a blank line then exactly:
   `That's the end of the summary — let me know if you have any questions or concerns before I continue.`

   **Step 5 — Emit.** Call `emit_markdown_on_parent` with the wrapped text as
   `content`. Then return one line, e.g. "Handoff card placed on parent surface
   \"<title>\"." (or the STOP reason from an earlier step).
   ---

2. When the sub-agent returns, relay its one-line result to the user. If a card
   was placed, tell them to review it on the parent surface and click **"Ship it"**
   to deliver it into the parent conversation.
