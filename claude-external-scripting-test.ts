#!/usr/bin/env bun

import { $ } from "bun";

const CLI = process.env.SPACETERM_CLI ?? "tsx src/cli/spaceterm-cli.ts";
const nodeId = process.env.SPACETERM_NODE_ID;

if (!nodeId) {
  console.error("SPACETERM_NODE_ID is not set — run this inside a spaceterm terminal.");
  process.exit(1);
}

// Fetch parent node ID from ancestors list (self is first, parent is second)
const ancestorsRaw = await $`${CLI.split(" ")} get-ancestors`.text();
const ancestors: string[] = JSON.parse(ancestorsRaw.trim());
const parentId = ancestors[1];

if (!parentId) {
  console.error("No parent node found in ancestors:", ancestors);
  process.exit(1);
}

console.log(`Node ID: ${nodeId}`);
console.log(`Parent node ID: ${parentId}`);
// Tell Claude Code (on the parent node) to trigger a broadcast
console.log("Shipping 'spaceterm broadcast' to parent...");
await $`${CLI.split(" ")} ship-it ${parentId} ${'spaceterm broadcast "hello"'}`;

console.log("Listening for broadcast events (1 hour timeout)...");

// Subscribe to broadcast events, with a 1-hour timeout
const sub = Bun.spawn(CLI.split(" ").concat(["subscribe", "--events", "broadcast"]), {
  stdout: "pipe",
  stderr: "inherit",
});

const timeout = setTimeout(() => {
  console.log("Timed out after 1 hour with no broadcast.");
  sub.kill();
  process.exit(0);
}, 60 * 60 * 1000);

const reader = sub.stdout.getReader();
const decoder = new TextDecoder();
let buffer = "";

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
      if (event.type === "broadcast") {
        console.log("Broadcast received!", event);
        clearTimeout(timeout);

        // Count down 10 seconds
        for (let i = 10; i > 0; i--) {
          console.log(`Responding in ${i}...`);
          await Bun.sleep(1000);
        }

        // Ship it to the parent node
        await $`${CLI.split(" ")} ship-it ${parentId} ${"broadcast received! congrats!"}`;
        console.log("Shipped response to parent.");

        sub.kill();
        process.exit(0);
      }
    } catch {
      // ignore non-JSON lines
    }
  }
}
