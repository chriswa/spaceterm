#!/usr/bin/env node
/**
 * Deep-dive analysis for traces heavy on GPU/cc/viz events.
 * Focuses on compositor, devtools.timeline breakdown, and frame-level timing.
 */

import { readFileSync } from "fs";

const file = process.argv[2];
if (!file) {
  console.error("Usage: node deep-dive.mjs <trace.json>");
  process.exit(1);
}

console.error(`Loading...`);
const raw = JSON.parse(readFileSync(file, "utf-8"));
const events = raw.traceEvents || raw;
console.error(`${events.length} events.\n`);

const usToMs = (us) => (us / 1000).toFixed(2);

// ─── Process/thread maps ────────────────────────────────────────────
const processNames = {};
const threadNames = {};
for (const e of events) {
  if (e.ph === "M") {
    if (e.name === "process_name") processNames[e.pid] = e.args?.name;
    if (e.name === "thread_name") threadNames[`${e.pid}:${e.tid}`] = e.args?.name;
  }
}

const rendererPid = Object.entries(processNames).find(([, n]) => n === "Renderer")?.[0];
const rendererMainTid = rendererPid
  ? Object.entries(threadNames).find(
      ([k, n]) => k.startsWith(`${rendererPid}:`) && n === "CrRendererMain"
    )?.[0]?.split(":")[1]
  : null;

// ═══════════════════════════════════════════════════════════════════
// 1. devtools.timeline event breakdown
// ═══════════════════════════════════════════════════════════════════
console.log("═══════════════════════════════════════════════════════");
console.log("  devtools.timeline EVENT BREAKDOWN");
console.log("═══════════════════════════════════════════════════════");

const dtEvents = events.filter((e) => (e.cat || "").includes("devtools.timeline"));
const dtByName = {};
for (const e of dtEvents) {
  if (!dtByName[e.name]) dtByName[e.name] = { count: 0, totalDur: 0, maxDur: 0 };
  dtByName[e.name].count++;
  if (e.dur) {
    dtByName[e.name].totalDur += e.dur;
    if (e.dur > dtByName[e.name].maxDur) dtByName[e.name].maxDur = e.dur;
  }
}
Object.entries(dtByName)
  .sort((a, b) => b[1].totalDur - a[1].totalDur)
  .forEach(([name, s]) =>
    console.log(
      `  ${name.padEnd(35)} x${s.count.toString().padStart(5)}  total=${usToMs(s.totalDur).padStart(8)}ms  max=${usToMs(s.maxDur).padStart(6)}ms`
    )
  );

// ═══════════════════════════════════════════════════════════════════
// 2. ALL unique event names with duration totals (top 50)
// ═══════════════════════════════════════════════════════════════════
console.log("\n═══════════════════════════════════════════════════════");
console.log("  TOP 50 EVENT NAMES BY TOTAL DURATION");
console.log("═══════════════════════════════════════════════════════");

const allByName = {};
for (const e of events) {
  if (e.ph !== "X") continue;
  const key = `${e.cat}::${e.name}`;
  if (!allByName[key]) allByName[key] = { count: 0, totalDur: 0, maxDur: 0 };
  allByName[key].count++;
  allByName[key].totalDur += e.dur || 0;
  if ((e.dur || 0) > allByName[key].maxDur) allByName[key].maxDur = e.dur;
}
Object.entries(allByName)
  .sort((a, b) => b[1].totalDur - a[1].totalDur)
  .slice(0, 50)
  .forEach(([name, s]) =>
    console.log(
      `  ${usToMs(s.totalDur).padStart(9)}ms total  ${usToMs(s.maxDur).padStart(6)}ms max  x${s.count.toString().padStart(5)}  ${name}`
    )
  );

// ═══════════════════════════════════════════════════════════════════
// 3. Renderer main thread timeline (what's taking time?)
// ═══════════════════════════════════════════════════════════════════
console.log("\n═══════════════════════════════════════════════════════");
console.log("  RENDERER MAIN THREAD - TOP EVENTS BY DURATION");
console.log("═══════════════════════════════════════════════════════");

const rendererMainEvents = events.filter(
  (e) =>
    e.ph === "X" &&
    String(e.pid) === String(rendererPid) &&
    String(e.tid) === String(rendererMainTid)
);

const rByName = {};
for (const e of rendererMainEvents) {
  const key = `${e.cat}::${e.name}`;
  if (!rByName[key]) rByName[key] = { count: 0, totalDur: 0, maxDur: 0 };
  rByName[key].count++;
  rByName[key].totalDur += e.dur || 0;
  if ((e.dur || 0) > rByName[key].maxDur) rByName[key].maxDur = e.dur;
}
Object.entries(rByName)
  .sort((a, b) => b[1].totalDur - a[1].totalDur)
  .slice(0, 30)
  .forEach(([name, s]) =>
    console.log(
      `  ${usToMs(s.totalDur).padStart(9)}ms total  ${usToMs(s.maxDur).padStart(6)}ms max  x${s.count.toString().padStart(5)}  ${name}`
    )
  );

// ═══════════════════════════════════════════════════════════════════
// 4. CC/Compositor frame pipeline
// ═══════════════════════════════════════════════════════════════════
console.log("\n═══════════════════════════════════════════════════════");
console.log("  COMPOSITOR FRAME PIPELINE");
console.log("═══════════════════════════════════════════════════════");

// Look for DrawFrame, ProxyMain::BeginMainFrame, ProxyImpl
const compositorNames = [
  "ProxyImpl::ScheduledActionDraw",
  "ProxyImpl::ScheduledActionSendBeginMainFrame",
  "ThreadProxy::BeginMainFrame",
  "LayerTreeHostImpl::PrepareToDraw",
  "DrawLayers",
  "RasterTask",
  "RasterBufferProviderImpl",
  "TileManager::AssignGpuMemoryToTiles",
];

for (const name of compositorNames) {
  const matching = events.filter((e) => e.name === name && e.ph === "X");
  if (matching.length === 0) continue;
  const durs = matching.map((e) => e.dur).sort((a, b) => a - b);
  const total = durs.reduce((s, d) => s + d, 0);
  const max = durs[durs.length - 1];
  console.log(
    `  ${name.padEnd(45)} x${matching.length.toString().padStart(5)}  total=${usToMs(total).padStart(8)}ms  max=${usToMs(max).padStart(6)}ms`
  );
}

// Also try broader search for cc:: events
const ccEvents = events.filter((e) => (e.cat || "").startsWith("cc") && e.ph === "X");
const ccByName = {};
for (const e of ccEvents) {
  if (!ccByName[e.name]) ccByName[e.name] = { count: 0, totalDur: 0, maxDur: 0 };
  ccByName[e.name].count++;
  ccByName[e.name].totalDur += e.dur || 0;
  if ((e.dur || 0) > ccByName[e.name].maxDur) ccByName[e.name].maxDur = e.dur;
}
console.log(`\n  All cc events by total duration:`);
Object.entries(ccByName)
  .sort((a, b) => b[1].totalDur - a[1].totalDur)
  .slice(0, 20)
  .forEach(([name, s]) =>
    console.log(
      `  ${usToMs(s.totalDur).padStart(9)}ms total  ${usToMs(s.maxDur).padStart(6)}ms max  x${s.count.toString().padStart(5)}  ${name}`
    )
  );

// ═══════════════════════════════════════════════════════════════════
// 5. GPU process breakdown
// ═══════════════════════════════════════════════════════════════════
console.log("\n═══════════════════════════════════════════════════════");
console.log("  GPU PROCESS - TOP EVENTS BY DURATION");
console.log("═══════════════════════════════════════════════════════");

const gpuPid = Object.entries(processNames).find(([, n]) => n === "GPU Process")?.[0];
const gpuEvents = events.filter(
  (e) => e.ph === "X" && String(e.pid) === String(gpuPid)
);
const gpuByName = {};
for (const e of gpuEvents) {
  const key = e.name;
  if (!gpuByName[key]) gpuByName[key] = { count: 0, totalDur: 0, maxDur: 0 };
  gpuByName[key].count++;
  gpuByName[key].totalDur += e.dur || 0;
  if ((e.dur || 0) > gpuByName[key].maxDur) gpuByName[key].maxDur = e.dur;
}
Object.entries(gpuByName)
  .sort((a, b) => b[1].totalDur - a[1].totalDur)
  .slice(0, 25)
  .forEach(([name, s]) =>
    console.log(
      `  ${usToMs(s.totalDur).padStart(9)}ms total  ${usToMs(s.maxDur).padStart(6)}ms max  x${s.count.toString().padStart(5)}  ${name}`
    )
  );

// ═══════════════════════════════════════════════════════════════════
// 6. Frame timing from cc.benchmark markers
// ═══════════════════════════════════════════════════════════════════
console.log("\n═══════════════════════════════════════════════════════");
console.log("  FRAME TIMING (cc,benchmark)");
console.log("═══════════════════════════════════════════════════════");

const benchmarkEvents = events
  .filter((e) => (e.cat || "").includes("benchmark"))
  .sort((a, b) => a.ts - b.ts);

// Look for "PipelineReporter" events which track frame lifecycle
const pipelineEvents = events.filter(
  (e) => e.name === "PipelineReporter" && e.ph === "X"
);
if (pipelineEvents.length > 0) {
  const durs = pipelineEvents.map((e) => e.dur).sort((a, b) => a - b);
  const total = durs.reduce((s, d) => s + d, 0);
  const p50 = durs[Math.floor(durs.length * 0.5)];
  const p90 = durs[Math.floor(durs.length * 0.9)];
  const p99 = durs[Math.floor(durs.length * 0.99)];
  const max = durs[durs.length - 1];
  console.log(`  PipelineReporter frames: ${pipelineEvents.length}`);
  console.log(`  P50=${usToMs(p50)}ms  P90=${usToMs(p90)}ms  P99=${usToMs(p99)}ms  max=${usToMs(max)}ms`);

  const slow = pipelineEvents.filter((e) => e.dur > 16667);
  console.log(`  Frames >16.67ms: ${slow.length} (${((slow.length / pipelineEvents.length) * 100).toFixed(1)}%)`);
} else {
  console.log("  No PipelineReporter events.");
}

// Also check for "Display::DrawAndSwap" which is the final presentation
const drawSwap = events.filter(
  (e) => e.name === "Display::DrawAndSwap" && e.ph === "X"
);
if (drawSwap.length > 0) {
  const durs = drawSwap.map((e) => e.dur).sort((a, b) => a - b);
  const total = durs.reduce((s, d) => s + d, 0);
  const p50 = durs[Math.floor(durs.length * 0.5)];
  const p90 = durs[Math.floor(durs.length * 0.9)];
  const max = durs[durs.length - 1];
  console.log(`\n  Display::DrawAndSwap: ${drawSwap.length} calls`);
  console.log(`  P50=${usToMs(p50)}ms  P90=${usToMs(p90)}ms  max=${usToMs(max)}ms  total=${usToMs(total)}ms`);
}

// ═══════════════════════════════════════════════════════════════════
// 7. Look at what requestAnimationFrame / timer callbacks are running
// ═══════════════════════════════════════════════════════════════════
console.log("\n═══════════════════════════════════════════════════════");
console.log("  ANIMATION FRAME & TIMER CALLBACKS");
console.log("═══════════════════════════════════════════════════════");

const rafEvents = events.filter(
  (e) =>
    (e.name === "FireAnimationFrame" ||
      e.name === "TimerFire" ||
      e.name === "RequestAnimationFrame" ||
      e.name === "TimerInstall" ||
      e.name === "TimerRemove") &&
    String(e.pid) === String(rendererPid)
);

const rafByName = {};
for (const e of rafEvents) {
  if (!rafByName[e.name]) rafByName[e.name] = { count: 0, totalDur: 0, maxDur: 0 };
  rafByName[e.name].count++;
  rafByName[e.name].totalDur += e.dur || 0;
  if ((e.dur || 0) > rafByName[e.name].maxDur) rafByName[e.name].maxDur = e.dur;
}
Object.entries(rafByName)
  .sort((a, b) => b[1].count - a[1].count)
  .forEach(([name, s]) =>
    console.log(
      `  ${name.padEnd(30)} x${s.count.toString().padStart(5)}  total=${usToMs(s.totalDur).padStart(8)}ms  max=${usToMs(s.maxDur).padStart(6)}ms`
    )
  );

// Show individual FireAnimationFrame events sorted by duration
const rafFires = events
  .filter(
    (e) =>
      e.name === "FireAnimationFrame" &&
      e.ph === "X" &&
      String(e.pid) === String(rendererPid)
  )
  .sort((a, b) => b.dur - a.dur)
  .slice(0, 15);

if (rafFires.length > 0) {
  console.log(`\n  Top FireAnimationFrame by duration:`);
  for (const e of rafFires) {
    console.log(`    ${usToMs(e.dur).padStart(8)}ms  @${usToMs(e.ts)}  ${JSON.stringify(e.args?.data || {}).slice(0, 80)}`);
  }
}

// ═══════════════════════════════════════════════════════════════════
// 8. Scroll / Input events
// ═══════════════════════════════════════════════════════════════════
console.log("\n═══════════════════════════════════════════════════════");
console.log("  INPUT / SCROLL EVENTS");
console.log("═══════════════════════════════════════════════════════");

const inputEvents = events.filter(
  (e) =>
    (e.cat || "").includes("input") ||
    (e.name || "").includes("Scroll") ||
    (e.name || "").includes("scroll") ||
    e.name === "EventDispatch"
);
const inputByName = {};
for (const e of inputEvents) {
  const key = e.name + (e.args?.data?.type ? `:${e.args.data.type}` : "");
  if (!inputByName[key]) inputByName[key] = { count: 0, totalDur: 0, maxDur: 0 };
  inputByName[key].count++;
  inputByName[key].totalDur += e.dur || 0;
  if ((e.dur || 0) > inputByName[key].maxDur) inputByName[key].maxDur = e.dur;
}
Object.entries(inputByName)
  .sort((a, b) => b[1].totalDur - a[1].totalDur)
  .slice(0, 20)
  .forEach(([name, s]) =>
    console.log(
      `  ${name.padEnd(45)} x${s.count.toString().padStart(5)}  total=${usToMs(s.totalDur).padStart(8)}ms  max=${usToMs(s.maxDur).padStart(6)}ms`
    )
  );
