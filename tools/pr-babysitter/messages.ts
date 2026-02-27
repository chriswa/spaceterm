const GIT_DISCIPLINE = `Remember: always \`git pull\` before making any changes (the CI auto-linter may have pushed). The PR must remain incrementally reviewable — do not rewrite commits that reviewers have already seen (no amending, squashing, or interactive-rebasing reviewed history). Adding new commits and rebasing onto the base branch are both fine.`;

const BROADCAST_INSTRUCTIONS = `When you're done, spaceterm broadcast "babysitter:resume" so I can continue monitoring.
If you need my input on something, spaceterm broadcast "babysitter:halt" instead.`;

const RESOLVE_THREAD_INSTRUCTIONS = `**CRITICAL: Every comment you post on the PR MUST be prefixed with "[Claude]"** so human readers know it was written by an AI agent and the PR author may not have seen it. Exception: bot commands like \`@mergifyio requeue\` or \`@coderabbitai approve\` must be sent verbatim without the prefix. Example: "[Claude] Fixed by renaming the variable in abc123."

Never silently resolve a thread. Every resolution must include a reply on the thread:
- **Valid concern → code fix**: Make the change, reply briefly describing what you did (prefixed with [Claude]), then resolve.
- **Out of scope or wrong**: Reply explaining why no change is needed (prefixed with [Claude]), then resolve.
Note: top-level review comments (the review body) cannot be resolved as threads — add a 👍 reaction to those instead.
To reply to a thread:
\`\`\`
gh api graphql -f query='mutation { addPullRequestReviewThreadReply(input: {pullRequestReviewThreadId: "<THREAD_ID>", body: "[Claude] your reply"}) { comment { id } } }'
\`\`\`
To resolve a thread:
\`\`\`
gh api graphql -f query='mutation { resolveReviewThread(input: {threadId: "<THREAD_ID>"}) { thread { id isResolved } } }'
\`\`\`
If you cannot confidently resolve a comment, do NOT resolve it — halt instead so I can address it myself.`;

interface ThreadDetail {
  threadId: string;
  path: string;
  line: number | null;
  comments: { author: string; body: string }[];
}

interface UnresolvedThreads {
  selfThreads: ThreadDetail[];
  reviewerThreads: ThreadDetail[];
}

function formatThreadsForPrompt(threads: ThreadDetail[]): string {
  return threads.map((thread) => {
    const location = thread.line ? `${thread.path}:${thread.line}` : thread.path;
    const comments = thread.comments.map((c) => `  ${c.author}: ${c.body}`).join("\n");
    return `**Thread ${thread.threadId}** (${location})\n${comments}`;
  }).join("\n\n");
}

export function buildRemediateMessage(
  remediate: string[],
  failedTestUrls: string[],
  unresolvedThreads?: UnresolvedThreads,
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
        if (unresolvedThreads?.reviewerThreads.length) {
          parts.push(`Here are the unresolved threads:\n\n${formatThreadsForPrompt(unresolvedThreads.reviewerThreads)}`);
        }
        parts.push(
          `I need you to review the CodeRabbit comments on the PR. For each one, decide if it's (A) out of scope for this PR, (B) wrong or misguided, or (C) a valid concern. Fix any easy C items. Draft reply text for A and B items. If everything is straightforward, go ahead and push.`,
        );
        parts.push("");
        break;

      case "Changes requested":
        parts.push(`**A human reviewer has requested changes.**`);
        parts.push(RESOLVE_THREAD_INSTRUCTIONS);
        if (unresolvedThreads?.reviewerThreads.length) {
          parts.push(`Here are the unresolved threads:\n\n${formatThreadsForPrompt(unresolvedThreads.reviewerThreads)}`);
        }
        parts.push(
          `I need you to review their comments on the PR carefully. Classify each as either (A) out of scope for this PR, or (C) a valid concern. Never assume the reviewer is wrong — I'll make that call myself. Fix easy C items. For anything complex or that could contradict my design intent, tell me what you think. Draft reply text for A items. Go ahead and push straightforward fixes.`,
        );
        parts.push("");
        break;

      case "Review Comments":
        parts.push(`**A reviewer has left unresolved comments on my PR.**`);
        parts.push(RESOLVE_THREAD_INSTRUCTIONS);
        if (unresolvedThreads?.reviewerThreads.length) {
          parts.push(`Here are the unresolved threads:\n\n${formatThreadsForPrompt(unresolvedThreads.reviewerThreads)}`);
        }
        parts.push(
          `I need you to review each unresolved reviewer comment. Classify each as either (A) out of scope for this PR, or (C) a valid concern. Never assume the reviewer is wrong — I'll make that call myself. Fix easy C items. For anything complex or that could contradict my design intent, tell me what you think. Draft reply text for A items. Go ahead and push straightforward fixes.`,
        );
        parts.push("");
        break;

      case "Conflicts":
        parts.push(`**There are merge conflicts.**`);
        parts.push(
          `First, determine the PR's base branch: \`gh pr view --json baseRefName --jq '.baseRefName'\`. Then resolve the conflicts — either merge or rebase onto that base branch (NOT necessarily master). Using the wrong branch will balloon the PR diff. If the conflicts are in files I've modified and require judgment about which changes to keep, tell me about them instead of guessing.`,
        );
        parts.push("");
        break;

      case "Self Comment":
        parts.push(`**I have unresolved comments on my own PR addressed to you.**`);
        parts.push(RESOLVE_THREAD_INSTRUCTIONS);
        if (unresolvedThreads?.selfThreads.length) {
          parts.push(`Here are the threads addressed to you:\n\n${formatThreadsForPrompt(unresolvedThreads.selfThreads)}`);
        }
        parts.push(
          `These are action items I left for myself, prefixed with "claude: " to indicate they're directed at you. For simple fixes, go ahead and implement and push. For complex changes that could affect the design intent, tell me what you think the fix should be so I can decide.`,
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
