const GIT_DISCIPLINE = `Remember: always \`git pull\` before making any changes (the CI auto-linter may have pushed). Never rebase or force-push — the incremental review diff is sacred. Merge only.`;

const BROADCAST_INSTRUCTIONS = `When you're done, spaceterm broadcast "babysitter:resume" so I can continue monitoring.
If you need my input on something, spaceterm broadcast "babysitter:halt" instead.`;

export function buildRemediateMessage(
  remediate: string[],
  failedTestUrls: string[],
): string {
  const parts: string[] = [];

  parts.push(`I just ran pr-check on my PR and found issues that need attention.`);
  parts.push("");

  // Priority order: Conflicts > Tests > CodeRabbit/Changes requested > Linear > Self Comment
  const ordered = [...remediate].sort((a, b) => {
    const priority = ["Conflicts", "Tests", "CodeRabbit", "Changes requested", "Linear", "Self Comment"];
    return priority.indexOf(a) - priority.indexOf(b);
  });

  for (const blocker of ordered) {
    switch (blocker) {
      case "Tests":
        parts.push(`**Tests are failing.** This is the highest priority.`);
        if (failedTestUrls.length > 0) {
          parts.push(`Failed CI links:`);
          for (const url of failedTestUrls) {
            parts.push(`- ${url}`);
          }
        }
        parts.push(
          `I need you to investigate these test failures. If it's a simple fix (typo, missing import, lint issue, obvious test assertion), go ahead and fix it. If the fix requires design decisions or seems like it could contradict the intent of my changes, tell me what you found instead.`,
        );
        parts.push("");
        break;

      case "CodeRabbit":
        parts.push(`**CodeRabbit has requested changes.**`);
        parts.push(
          `I need you to review the CodeRabbit comments on the PR. For each one, decide if it's (A) out of scope for this PR, (B) wrong or misguided, or (C) a valid concern. Fix any easy C items. Draft reply text for A and B items. If everything is straightforward, go ahead and push.`,
        );
        parts.push("");
        break;

      case "Changes requested":
        parts.push(`**A human reviewer has requested changes.**`);
        parts.push(
          `I need you to review their comments on the PR carefully. For each comment, classify as either (A) out of scope for this PR, or (C) a valid concern. Never assume the reviewer is wrong — I'll make that call myself. Fix easy C items. For anything complex or that could contradict my design intent, tell me what you think. Draft reply text for A items. Go ahead and push straightforward fixes.`,
        );
        parts.push("");
        break;

      case "Conflicts":
        parts.push(`**There are merge conflicts.**`);
        parts.push(
          `I need you to resolve the conflicts by merging master into my branch — never rebase, the "changes since last review" incremental diff is sacred. If the conflicts are in files I've modified and require judgment about which changes to keep, tell me about them instead of guessing.`,
        );
        parts.push("");
        break;

      case "Linear":
        parts.push(`**The PR is missing an associated Linear issue.**`);
        parts.push(
          `Check if my branch name contains a Linear ticket ID pattern. If you can figure out the ticket URL, associate it. Otherwise let me know.`,
        );
        parts.push("");
        break;

      case "Self Comment":
        parts.push(`**I have unresolved comments on my own PR.**`);
        parts.push(
          `Look at my unresolved self-comments on the PR and resolve any that are stale or no longer relevant. If any look like they need actual work, tell me what's needed.`,
        );
        parts.push("");
        break;
    }
  }

  parts.push(GIT_DISCIPLINE);
  parts.push("");
  parts.push(BROADCAST_INSTRUCTIONS);

  return parts.join("\n");
}

export function buildHaltMessage(halt: string[]): string {
  const descriptions = halt.map((b) => {
    switch (b) {
      case "Security":
        return "a security scan failure";
      case "Breaking":
        return "a breaking API change was detected";
      case "Safety":
        return "the PR safety check failed";
      case "Dequeued":
        return "the PR was kicked from the merge queue";
      case "Nutshell":
        return "a specific Nutshell approver is needed";
      case "-1 Reviewers":
        return "reviewers need to be added to the PR";
      case "-auto-merge":
        return "the auto-merge label is missing";
      case "Checklist":
        return "the PR checklist is incomplete";
      default:
        return `"${b}" is blocking`;
    }
  });

  const situation = descriptions.join(", and ");
  return `I just ran pr-check on my PR and ${situation}. This needs my attention — can you look into what's going on so I can decide how to handle it?`;
}

export function buildTerminalMessage(terminal: string[]): string {
  if (terminal.includes("Merged")) {
    return `I just ran pr-check — my PR has been merged! We're done here.`;
  }
  if (terminal.includes("Closed")) {
    return `I just ran pr-check — my PR has been closed.`;
  }
  return `PR has reached a terminal state.`;
}

export function buildDraftCleanMessage(): string {
  return `I just ran pr-check — my draft PR is clean! All checks that matter in draft mode are passing. I'm ready to take it to the next step when I'm back.`;
}
