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

console.log(`Parent node ID: ${parentId}`);

// Fork the parent claude node — the forked node becomes a child of this script's node
const forkResultRaw = await $`${CLI.split(" ")} fork-claude ${parentId} ${nodeId}`.text();
const forkResult = JSON.parse(forkResultRaw.trim());
const forkedNodeId = forkResult.nodeId;

if (!forkedNodeId) {
  console.error("Fork failed:", forkResult);
  process.exit(1);
}

console.log(`Forked node ID: ${forkedNodeId}`);

// Wait 10 seconds for the forked node to start up
for (let i = 10; i > 0; i--) {
  console.log(`Sending message in ${i}...`);
  await Bun.sleep(1000);
}

// Ship a message to the forked node
console.log('Shipping "hello, please respond" to forked node...');
await $`${CLI.split(" ")} ship-it ${forkedNodeId} ${"hello, please respond"}`;

// Wait 10 seconds
for (let i = 10; i > 0; i--) {
  console.log(`Sending self-terminate in ${i}...`);
  await Bun.sleep(1000);
}

// Ship self-terminate to the forked node
console.log('Shipping "self-terminate" to forked node...');
await $`${CLI.split(" ")} ship-it ${forkedNodeId} ${"self-terminate"}`;

console.log("Done.");
