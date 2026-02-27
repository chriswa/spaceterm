const GIT_DISCIPLINE = `Remember: always \`git pull\` before making any changes (the CI auto-linter may have pushed). Never rebase or force-push — the incremental review diff is sacred. Merge only.`;

const BROADCAST_INSTRUCTIONS = `When you're done, spaceterm broadcast "babysitter:resume" so I can continue monitoring.
If you need my input on something, spaceterm broadcast "babysitter:halt" instead.`;

const RESOLVE_THREAD_INSTRUCTIONS = `**CRITICAL: Every comment you post on the PR MUST be prefixed with "[Claude]"** so human readers know it was written by an AI agent and the PR author may not have seen it. Exception: bot commands like \`@mergifyio requeue\` or \`@coderabbitai approve\` must be sent verbatim without the prefix. Example: "[Claude] Fixed by renaming the variable in abc123."

Never silently resolve a thread. Every resolution must include a reply on the thread:
- **Valid concern → code fix**: Make the change, reply briefly describing what you did (prefixed with [Claude]), then resolve.
- **Out of scope or wrong**: Reply explaining why no change is needed (prefixed with [Claude]), then resolve.
Note: top-level review comments (the review body) cannot be resolved as threads — add a 👍 reaction to those instead.
To fetch unresolved thread IDs:
\`\`\`
gh api graphql -f query='query { repository(owner: "{owner}", name: "{repo}") { pullRequest(number: {number}) { reviewThreads(first: 100) { nodes { id isResolved path line comments(first: 20) { nodes { author { login } body } } } } } } }' | jq '[.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved == false) | {threadId: .id, path: .path, line: .line, comments: [.comments.nodes[] | {author: .author.login, body: .body}]}]'
\`\`\`
To resolve a thread:
\`\`\`
gh api graphql -f query='mutation { resolveReviewThread(input: {threadId: "<THREAD_ID>"}) { thread { id isResolved } } }'
\`\`\`
If you cannot confidently resolve a comment, do NOT resolve it — halt instead so I can address it myself.`;

export function buildRemediateMessage(
  remediate: string[],
  failedTestUrls: string[],
): string {
  const parts: string[] = [];

  parts.push(`I just ran pr-check on my PR and found issues that need attention.`);
  parts.push("");

  const priority = ["Dequeued", "Conflicts", "Tests", "CodeRabbit", "Changes requested", "Review Comments", "Self Comment"];
  const ordered = [...remediate].sort((a, b) => {
    return priority.indexOf(a) - priority.indexOf(b);
  });

  for (const blocker of ordered) {
    switch (blocker) {
      case "Dequeued":
        parts.push(`**My PR was kicked from the merge queue.**`);
        parts.push(
          `Post a comment on the root of the PR that reads exactly: \`@mergifyio requeue\`. Use: \`gh pr comment <PR_NUMBER> --body "@mergifyio requeue"\`. Note: do NOT prefix this with [Claude] — bot commands must be sent verbatim.`,
        );
        parts.push("");
        break;

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
        parts.push(RESOLVE_THREAD_INSTRUCTIONS);
        parts.push(
          `I need you to review the CodeRabbit comments on the PR. For each one, decide if it's (A) out of scope for this PR, (B) wrong or misguided, or (C) a valid concern. Fix any easy C items. Draft reply text for A and B items. If everything is straightforward, go ahead and push.`,
        );
        parts.push("");
        break;

      case "Changes requested":
        parts.push(`**A human reviewer has requested changes.**`);
        parts.push(RESOLVE_THREAD_INSTRUCTIONS);
        parts.push(
          `I need you to review their comments on the PR carefully. For each un-👍'd comment, classify as either (A) out of scope for this PR, or (C) a valid concern. Never assume the reviewer is wrong — I'll make that call myself. Fix easy C items. For anything complex or that could contradict my design intent, tell me what you think. Draft reply text for A items. Go ahead and push straightforward fixes.`,
        );
        parts.push("");
        break;

      case "Review Comments":
        parts.push(`**A reviewer has left unresolved comments on my PR.**`);
        parts.push(RESOLVE_THREAD_INSTRUCTIONS);
        parts.push(
          `I need you to review each un-👍'd reviewer comment carefully. For each one, classify as either (A) out of scope for this PR, or (C) a valid concern. Never assume the reviewer is wrong — I'll make that call myself. Fix easy C items. For anything complex or that could contradict my design intent, tell me what you think. Draft reply text for A items. Go ahead and push straightforward fixes.`,
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

      case "Self Comment":
        parts.push(`**I have unresolved comments on my own PR addressed to you.**`);
        parts.push(RESOLVE_THREAD_INSTRUCTIONS);
        parts.push(
          `These are action items I left for myself, prefixed with "claude: " to indicate they're directed at you. Only address comments whose body starts with \`claude: \` (case insensitive) — ignore any other self-comments, those are notes for human readers. For simple fixes, go ahead and implement and push. For complex changes that could affect the design intent, tell me what you think the fix should be so I can decide.`,
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

export function buildHaltMessage(halt: string[], meticulousUrl: string | null): string {
  const descriptions = halt.map((b) => {
    switch (b) {
      case "Security":
        return "a security scan failure";
      case "Breaking":
        return "a breaking API change was detected";
      case "Safety":
        return "the PR safety check failed";
      case "-auto-merge":
        return "the auto-merge label is missing";
      case "Checklist":
        return "the PR checklist is incomplete";
      case "Linear":
        return "the PR is missing an associated Linear issue";
      case "Meticulous":
        return meticulousUrl
          ? `Meticulous visual tests failed (${meticulousUrl})`
          : "Meticulous visual tests failed";
      default:
        if (/^-\d+ Reviewers?$/.test(b)) return "reviewers need to be added to the PR";
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
