#!/usr/bin/env bun

import { $ } from "bun";
import { buildRemediateMessage, buildHaltMessage, buildTerminalMessage, buildDraftCleanMessage } from "./messages";

// ---- Configuration ----

const POLL_INTERVAL_MS = 1 * 60 * 1000; // 1 minute
const NUDGE_DELAY_MS = 5 * 1000; // wait before nudging after Claude stops
const WAIT_TIMEOUT_MS = 30 * 60 * 1000; // 30 min max wait for Claude

const CLI = (process.env.SPACETERM_CLI ?? "spaceterm-cli").split(" ");

// ---- Setup ----

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`Usage: pr-babysitter [PR_URL]

Monitors a GitHub PR's CI checks and nudges the parent Claude Code session
to fix failures or acknowledge terminal states.

If PR_URL is omitted, detects the PR for the current branch via \`gh pr view\`.

Requires SPACETERM_NODE_ID to be set (run inside a spaceterm terminal).`);
  process.exit(0);
}

let prUrl = process.argv[2];
if (!prUrl) {
  try {
    prUrl = (await $`gh pr view --json url --jq '.url'`.text()).trim();
  } catch {
    console.error("No PR URL provided and no PR found for the current branch.\nRun `pr-babysitter --help` for usage.");
    process.exit(1);
  }
}

const nodeId = process.env.SPACETERM_NODE_ID;
if (!nodeId) {
  console.error("SPACETERM_NODE_ID is not set — run this inside a spaceterm terminal.");
  process.exit(1);
}

const ancestorsRaw = await $`${CLI} get-ancestors`.text();
const ancestors: string[] = JSON.parse(ancestorsRaw.trim());
const parentId = ancestors[1];

if (!parentId) {
  console.error("No parent node found in ancestors:", ancestors);
  process.exit(1);
}

console.log(`Babysitter started for ${prUrl}`);
console.log(`Parent Claude Code node: ${parentId}`);

// ---- Spaceterm Helpers ----

async function shipIt(message: string): Promise<void> {
  console.log(`\n--- Will ship to Claude in 5s (^C to abort) ---\n${message}\n---`);
  await Bun.sleep(5000);
  await $`${CLI} ship-it ${parentId} ${message}`;
}

// ---- pr-check ----

interface Triage {
  isDraft: boolean;
  draftClean: boolean;
  wait: string[];
  remediate: string[];
  halt: string[];
  done: string[];
  postDraft: string[];
}

interface PrCheckOutput {
  blockers: { name: string; action: string }[];
  failedTestUrls: string[];
  meticulousUrl: string | null;
  triage: Triage;
}

interface PrCheckResult {
  failedTestUrls: string[];
  meticulousUrl: string | null;
  triage: Triage;
}

async function runPrCheck(): Promise<PrCheckResult> {
  const result = await $`pr-check ${prUrl}`.quiet();
  const stdout = result.stdout.toString().trim();
  const raw: PrCheckOutput = JSON.parse(stdout);
  return {
    failedTestUrls: raw.failedTestUrls,
    meticulousUrl: raw.meticulousUrl,
    triage: raw.triage,
  };
}

// ---- Wait for Claude ----

interface WaitResult {
  outcome: "resume" | "halt";
}

async function waitForClaude(): Promise<WaitResult> {
  return new Promise<WaitResult>((resolve, reject) => {
    const sub = Bun.spawn(
      [...CLI, "subscribe", "--events", "broadcast,node-updated", "--nodes", parentId],
      { stdout: "pipe", stderr: "inherit" },
    );

    let receivedBroadcast = false;
    let nudgeTimer: ReturnType<typeof setTimeout> | null = null;
    let nudgeCount = 0;

    const timeout = setTimeout(() => {
      console.log("Wait timeout (30 min) — nudging Claude one last time.");
      nudgeAndResolve();
    }, WAIT_TIMEOUT_MS);

    function cleanup() {
      clearTimeout(timeout);
      if (nudgeTimer) clearTimeout(nudgeTimer);
      sub.kill();
    }

    async function nudgeAndResolve() {
      nudgeCount++;
      if (nudgeCount > 2) {
        console.log("Claude unresponsive after multiple nudges — halting.");
        cleanup();
        resolve({ outcome: "halt" });
        return;
      }
      await shipIt(
        `You stopped without letting me know the outcome. Please either:\n- spaceterm broadcast "babysitter:resume" if you're done and I can continue monitoring\n- spaceterm broadcast "babysitter:halt" if you need my input`,
      );
    }

    const reader = sub.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    (async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop()!;

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line);

            // Broadcast event from Claude
            if (event.type === "broadcast") {
              const content: string = event.content ?? "";
              if (content.includes("babysitter:resume")) {
                console.log("Claude signaled: resume");
                receivedBroadcast = true;
                cleanup();
                resolve({ outcome: "resume" });
                return;
              }
              if (content.includes("babysitter:halt")) {
                console.log("Claude signaled: halt");
                receivedBroadcast = true;
                cleanup();
                resolve({ outcome: "halt" });
                return;
              }
            }

            // Node state change
            if (event.type === "node-updated" && event.fields?.claudeState === "stopped") {
              if (!receivedBroadcast) {
                console.log("Claude stopped without broadcasting — waiting briefly then nudging...");
                nudgeTimer = setTimeout(() => {
                  if (!receivedBroadcast) {
                    nudgeAndResolve();
                  }
                }, NUDGE_DELAY_MS);
              }
            }
          } catch {
            // ignore non-JSON lines
          }
        }
      }
    })().catch((err) => {
      cleanup();
      reject(err);
    });
  });
}

// ---- CodeRabbit cooldown ----

const CODERABBIT_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes
let codeRabbitApprovedAt: number | null = null;

function isCodeRabbitOnCooldown(): boolean {
  if (codeRabbitApprovedAt === null) return false;
  if (Date.now() - codeRabbitApprovedAt < CODERABBIT_COOLDOWN_MS) return true;
  // Cooldown expired
  codeRabbitApprovedAt = null;
  return false;
}

function filterCodeRabbitIfCooling(triage: Triage): void {
  if (!isCodeRabbitOnCooldown()) return;
  for (const arr of [triage.remediate, triage.halt, triage.wait] as string[][]) {
    const idx = arr.indexOf("CodeRabbit");
    if (idx !== -1) {
      arr.splice(idx, 1);
      console.log("CodeRabbit on cooldown — ignoring for up to 10 min after approve.");
    }
  }
}

// ---- Main Loop ----

async function main() {
  while (true) {
    console.log(`\n[${new Date().toLocaleTimeString()}] Running pr-check...`);
    let result: PrCheckResult;
    try {
      result = await runPrCheck();
    } catch (err) {
      console.error("pr-check failed:", err);
      console.log("Retrying in 1 minute...");
      await Bun.sleep(POLL_INTERVAL_MS);
      continue;
    }

    const { triage } = result;
    filterCodeRabbitIfCooling(triage);
    const allBlockers = [...triage.done, ...triage.wait, ...triage.remediate, ...triage.halt];
    console.log("Blockers:", allBlockers.join(", ") || "(none active)");

    // Terminal states
    if (triage.done.length > 0) {
      await shipIt(buildTerminalMessage(triage.done));
      console.log("Terminal state reached. Exiting.");
      process.exit(0);
    }

    // Draft-clean terminal
    if (triage.draftClean) {
      await shipIt(buildDraftCleanMessage());
      console.log("Draft PR is clean. Exiting.");
      process.exit(0);
    }

    // Remediate blockers take priority
    if (triage.remediate.length > 0) {
      const remediatedBlockers = [...triage.remediate];
      const message = buildRemediateMessage(triage.remediate, result.failedTestUrls);
      await shipIt(message);

      const waitResult = await waitForClaude();
      if (waitResult.outcome === "halt") {
        console.log("Claude halted for user input. Exiting babysitter.");
        await $`${CLI} unread ${nodeId}`.quiet();
        process.exit(0);
      }

      // CodeRabbit was remediated successfully — post approve and start cooldown
      if (remediatedBlockers.includes("CodeRabbit")) {
        console.log("CodeRabbit remediated — posting @coderabbitai approve...");
        await $`gh pr comment ${prUrl} --body "@coderabbitai approve"`.quiet();
        codeRabbitApprovedAt = Date.now();
        console.log("CodeRabbit approve posted. Ignoring CodeRabbit blockers for 10 min.");
      }

      // outcome === "resume" → continue the loop
      continue;
    }

    // Halt blockers (no remediate items)
    if (triage.halt.length > 0) {
      await shipIt(buildHaltMessage(triage.halt, result.meticulousUrl));
      console.log("Halt condition reached. Exiting.");
      await $`${CLI} unread ${nodeId}`.quiet();
      process.exit(0);
    }

    // Only loop items remain — sleep and try again
    console.log(`Nothing actionable. Waiting ${POLL_INTERVAL_MS / 1000}s...`);
    await Bun.sleep(POLL_INTERVAL_MS);
  }
}

main().catch((err) => {
  console.error("Babysitter error:", err);
  process.exit(1);
});
