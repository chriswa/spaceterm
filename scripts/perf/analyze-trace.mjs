#!/usr/bin/env node
/**
 * Chrome Trace Event analyzer for Spaceterm perf captures.
 * Usage: node analyze-trace.mjs <trace.json> [--section=<name>]
 *
 * Sections: summary, long-tasks, frames, react, js-hotspots, layout-paint, gc, user-timing
 */

import { readFileSync } from "fs";

const file = process.argv[2];
if (!file) {
  console.error("Usage: node analyze-trace.mjs <trace.json> [--section=<name>]");
  process.exit(1);
}

const sectionArg = process.argv.find((a) => a.startsWith("--section="));
const section = sectionArg ? sectionArg.split("=")[1] : "all";

console.error(`Loading ${file}...`);
const raw = JSON.parse(readFileSync(file, "utf-8"));
const events = raw.traceEvents || raw;
console.error(`Loaded ${events.length} trace events.\n`);

// ─── Helpers ────────────────────────────────────────────────────────
const usToMs = (us) => (us / 1000).toFixed(2);
const usToS = (us) => (us / 1_000_000).toFixed(3);

// Build process/thread name maps from metadata events
const processNames = {};
const threadNames = {};
for (const e of events) {
  if (e.ph === "M") {
    if (e.name === "process_name") processNames[e.pid] = e.args?.name;
    if (e.name === "thread_name") threadNames[`${e.pid}:${e.tid}`] = e.args?.name;
  }
}

function procLabel(pid) {
  return processNames[pid] || `pid:${pid}`;
}
function threadLabel(pid, tid) {
  return threadNames[`${pid}:${tid}`] || `tid:${tid}`;
}

// Find the renderer main thread (where JS runs)
const rendererPid = Object.entries(processNames).find(
  ([, n]) => n === "Renderer"
)?.[0];
const rendererMainTid = rendererPid
  ? Object.entries(threadNames).find(
      ([k, n]) => k.startsWith(`${rendererPid}:`) && n === "CrRendererMain"
    )?.[0]?.split(":")[1]
  : null;

// ─── 1. Summary ─────────────────────────────────────────────────────
function printSummary() {
  console.log("═══════════════════════════════════════════════════════");
  console.log("  TRACE SUMMARY");
  console.log("═══════════════════════════════════════════════════════");

  let minTs = Infinity,
    maxTs = -Infinity;
  for (const e of events) {
    if (e.ts > 0) {
      if (e.ts < minTs) minTs = e.ts;
      const end = e.ts + (e.dur || 0);
      if (end > maxTs) maxTs = end;
    }
  }
  console.log(`Total events: ${events.length}`);
  console.log(`Time range:   ${usToS(maxTs - minTs)}s`);
  console.log(`Renderer PID: ${rendererPid} (main tid: ${rendererMainTid})`);

  // Category breakdown
  const cats = {};
  for (const e of events) {
    const c = e.cat || "(none)";
    cats[c] = (cats[c] || 0) + 1;
  }
  console.log(`\nTop categories:`);
  Object.entries(cats)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .forEach(([cat, count]) => console.log(`  ${count.toString().padStart(7)} ${cat}`));

  // Process breakdown
  console.log(`\nProcesses:`);
  const procEvents = {};
  for (const e of events) {
    const label = procLabel(e.pid);
    procEvents[label] = (procEvents[label] || 0) + 1;
  }
  Object.entries(procEvents)
    .sort((a, b) => b[1] - a[1])
    .forEach(([p, c]) => console.log(`  ${c.toString().padStart(7)} ${p}`));
}

// ─── 2. Long tasks on renderer main thread ──────────────────────────
function printLongTasks() {
  console.log("\n═══════════════════════════════════════════════════════");
  console.log("  LONG TASKS (renderer main thread, >16ms)");
  console.log("═══════════════════════════════════════════════════════");

  if (!rendererPid) {
    console.log("  No renderer process found.");
    return;
  }

  const longTasks = events
    .filter(
      (e) =>
        e.ph === "X" &&
        String(e.pid) === String(rendererPid) &&
        String(e.tid) === String(rendererMainTid) &&
        e.dur > 16000
    )
    .sort((a, b) => b.dur - a.dur)
    .slice(0, 40);

  if (longTasks.length === 0) {
    console.log("  No tasks longer than 16ms found.");
    return;
  }

  for (const e of longTasks) {
    const argsStr = e.args ? JSON.stringify(e.args).slice(0, 100) : "";
    console.log(
      `  ${usToMs(e.dur).padStart(9)}ms  ${e.cat}::${e.name}  ${argsStr}`
    );
  }
}

// ─── 3. Frame analysis ──────────────────────────────────────────────
function printFrames() {
  console.log("\n═══════════════════════════════════════════════════════");
  console.log("  FRAME ANALYSIS");
  console.log("═══════════════════════════════════════════════════════");

  const beginFrames = events
    .filter(
      (e) =>
        e.name === "BeginFrame" &&
        e.ph === "X" &&
        String(e.pid) === String(rendererPid)
    )
    .sort((a, b) => a.ts - b.ts);

  if (beginFrames.length > 1) {
    const gaps = [];
    for (let i = 1; i < beginFrames.length; i++) {
      gaps.push(beginFrames[i].ts - beginFrames[i - 1].ts);
    }
    gaps.sort((a, b) => a - b);
    const p50 = gaps[Math.floor(gaps.length * 0.5)];
    const p90 = gaps[Math.floor(gaps.length * 0.9)];
    const p99 = gaps[Math.floor(gaps.length * 0.99)];
    const max = gaps[gaps.length - 1];

    console.log(`  BeginFrame events: ${beginFrames.length}`);
    console.log(`  Frame gap P50: ${usToMs(p50)}ms`);
    console.log(`  Frame gap P90: ${usToMs(p90)}ms`);
    console.log(`  Frame gap P99: ${usToMs(p99)}ms`);
    console.log(`  Frame gap Max: ${usToMs(max)}ms`);

    const janky = gaps.filter((g) => g > 33000);
    console.log(`  Janky frames (>33ms gap): ${janky.length}/${gaps.length}`);
  } else {
    console.log("  Not enough BeginFrame events for analysis.");
  }

  const commitEvents = events
    .filter((e) => e.name === "Commit" && e.ph === "X")
    .sort((a, b) => b.dur - a.dur)
    .slice(0, 10);

  if (commitEvents.length > 0) {
    console.log(`\n  Longest Commit events:`);
    for (const e of commitEvents) {
      console.log(`    ${usToMs(e.dur).padStart(8)}ms  ${procLabel(e.pid)}::${threadLabel(e.pid, e.tid)}`);
    }
  }
}

// ─── 4. React / user JS profiling ───────────────────────────────────
function printReact() {
  console.log("\n═══════════════════════════════════════════════════════");
  console.log("  REACT & USER CODE");
  console.log("═══════════════════════════════════════════════════════");

  const reactEvents = events.filter(
    (e) =>
      (e.cat || "").includes("blink.user_timing") ||
      (e.name || "").includes("React") ||
      (e.name || "").includes("react") ||
      (e.name || "").startsWith("--")
  );

  if (reactEvents.length > 0) {
    console.log(`  Found ${reactEvents.length} React/user-timing events.`);

    const byName = {};
    for (const e of reactEvents) {
      const key = e.name;
      if (!byName[key]) byName[key] = { count: 0, totalDur: 0, maxDur: 0 };
      byName[key].count++;
      if (e.dur) {
        byName[key].totalDur += e.dur;
        if (e.dur > byName[key].maxDur) byName[key].maxDur = e.dur;
      }
    }

    const sorted = Object.entries(byName).sort((a, b) => b[1].totalDur - a[1].totalDur);
    console.log(`\n  Top user-timing events by total duration:`);
    for (const [name, stats] of sorted.slice(0, 30)) {
      console.log(
        `    ${usToMs(stats.totalDur).padStart(9)}ms total  ${usToMs(stats.maxDur).padStart(8)}ms max  x${stats.count.toString().padStart(5)}  ${name.slice(0, 80)}`
      );
    }
  } else {
    console.log("  No React/user-timing events found.");
  }

  const fnCalls = events
    .filter(
      (e) =>
        (e.name === "FunctionCall" || e.name === "EvaluateScript") &&
        e.ph === "X" &&
        String(e.pid) === String(rendererPid) &&
        e.dur > 1000
    )
    .sort((a, b) => b.dur - a.dur)
    .slice(0, 20);

  if (fnCalls.length > 0) {
    console.log(`\n  Long FunctionCall/EvaluateScript (>1ms):`);
    for (const e of fnCalls) {
      const url = e.args?.data?.url || e.args?.data?.functionName || "";
      console.log(
        `    ${usToMs(e.dur).padStart(8)}ms  ${e.name}  ${url.slice(0, 80)}`
      );
    }
  }
}

// ─── 5. JS Execution Hotspots ───────────────────────────────────────
function printJsHotspots() {
  console.log("\n═══════════════════════════════════════════════════════");
  console.log("  JS EXECUTION HOTSPOTS");
  console.log("═══════════════════════════════════════════════════════");

  const v8Events = events
    .filter(
      (e) =>
        (e.cat || "").includes("v8") &&
        e.ph === "X" &&
        e.dur > 500
    )
    .sort((a, b) => b.dur - a.dur);

  const byName = {};
  for (const e of v8Events) {
    const key = e.name;
    if (!byName[key]) byName[key] = { count: 0, totalDur: 0, maxDur: 0 };
    byName[key].count++;
    byName[key].totalDur += e.dur;
    if (e.dur > byName[key].maxDur) byName[key].maxDur = e.dur;
  }

  console.log(`  V8 events (>0.5ms):`);
  Object.entries(byName)
    .sort((a, b) => b[1].totalDur - a[1].totalDur)
    .slice(0, 20)
    .forEach(([name, s]) =>
      console.log(
        `    ${usToMs(s.totalDur).padStart(9)}ms total  ${usToMs(s.maxDur).padStart(8)}ms max  x${s.count.toString().padStart(5)}  ${name}`
      )
    );

  const timerEvents = events
    .filter(
      (e) =>
        (e.name === "TimerFire" || e.name === "EventDispatch" || e.name === "FireAnimationFrame") &&
        e.ph === "X" &&
        String(e.pid) === String(rendererPid) &&
        e.dur > 5000
    )
    .sort((a, b) => b.dur - a.dur)
    .slice(0, 20);

  if (timerEvents.length > 0) {
    console.log(`\n  Long Timer/Event/AnimationFrame fires (>5ms):`);
    for (const e of timerEvents) {
      const detail = e.args?.data?.type || e.args?.data?.timerId || "";
      console.log(
        `    ${usToMs(e.dur).padStart(8)}ms  ${e.name}  ${detail}`
      );
    }
  }
}

// ─── 6. Layout & Paint ──────────────────────────────────────────────
function printLayoutPaint() {
  console.log("\n═══════════════════════════════════════════════════════");
  console.log("  LAYOUT & PAINT");
  console.log("═══════════════════════════════════════════════════════");

  const layoutPaintNames = [
    "Layout",
    "UpdateLayoutTree",
    "RecalculateStyles",
    "Paint",
    "PaintImage",
    "CompositeLayers",
    "UpdateLayer",
    "HitTest",
    "PrePaint",
    "IntersectionObserver",
  ];

  for (const name of layoutPaintNames) {
    const matching = events.filter(
      (e) =>
        e.name === name &&
        e.ph === "X" &&
        String(e.pid) === String(rendererPid)
    );
    if (matching.length === 0) continue;

    const durs = matching.map((e) => e.dur).sort((a, b) => a - b);
    const total = durs.reduce((s, d) => s + d, 0);
    const p50 = durs[Math.floor(durs.length * 0.5)];
    const p90 = durs[Math.floor(durs.length * 0.9)];
    const max = durs[durs.length - 1];

    console.log(
      `  ${name.padEnd(25)} count=${matching.length.toString().padStart(5)}  total=${usToMs(total).padStart(8)}ms  P50=${usToMs(p50).padStart(6)}ms  P90=${usToMs(p90).padStart(6)}ms  max=${usToMs(max).padStart(6)}ms`
    );

    if (name === "Layout" && max > 5000) {
      const longLayouts = matching.filter((e) => e.dur > 5000).sort((a, b) => b.dur - a.dur).slice(0, 5);
      for (const e of longLayouts) {
        const stack = e.args?.beginData?.stackTrace?.[0] || {};
        console.log(
          `    └─ ${usToMs(e.dur)}ms at ${stack.url || "?"}:${stack.lineNumber || "?"}`
        );
      }
    }
  }
}

// ─── 7. GC Events ───────────────────────────────────────────────────
function printGC() {
  console.log("\n═══════════════════════════════════════════════════════");
  console.log("  GARBAGE COLLECTION");
  console.log("═══════════════════════════════════════════════════════");

  const gcEvents = events.filter(
    (e) =>
      ((e.cat || "").includes("devtools.timeline") &&
        (e.name === "MajorGC" || e.name === "MinorGC" || e.name === "GCEvent" || e.name === "BlinkGC.AtomicPhase")) ||
      (e.name || "").startsWith("V8.GC")
  );

  if (gcEvents.length === 0) {
    const gcLike = events.filter(
      (e) => (e.name || "").includes("GC") || (e.name || "").includes("gc")
    );
    if (gcLike.length > 0) {
      const byName = {};
      for (const e of gcLike) {
        if (!byName[e.name]) byName[e.name] = { count: 0, totalDur: 0 };
        byName[e.name].count++;
        byName[e.name].totalDur += e.dur || 0;
      }
      Object.entries(byName)
        .sort((a, b) => b[1].totalDur - a[1].totalDur)
        .slice(0, 15)
        .forEach(([n, s]) =>
          console.log(`  ${n.padEnd(40)} x${s.count.toString().padStart(4)}  ${usToMs(s.totalDur).padStart(8)}ms`)
        );
    } else {
      console.log("  No GC events found.");
    }
    return;
  }

  const byType = {};
  for (const e of gcEvents) {
    const key = e.name;
    if (!byType[key]) byType[key] = { count: 0, totalDur: 0, maxDur: 0 };
    byType[key].count++;
    if (e.dur) {
      byType[key].totalDur += e.dur;
      if (e.dur > byType[key].maxDur) byType[key].maxDur = e.dur;
    }
  }

  Object.entries(byType).forEach(([name, s]) =>
    console.log(
      `  ${name.padEnd(25)} x${s.count.toString().padStart(4)}  total=${usToMs(s.totalDur).padStart(8)}ms  max=${usToMs(s.maxDur).padStart(6)}ms`
    )
  );
}

// ─── 8. User Timing (performance.mark / performance.measure) ────────
function printUserTiming() {
  console.log("\n═══════════════════════════════════════════════════════");
  console.log("  USER TIMING (performance.mark / performance.measure)");
  console.log("═══════════════════════════════════════════════════════");

  const userTimingEvents = events.filter(
    (e) => (e.cat || "").includes("blink.user_timing")
  );

  if (userTimingEvents.length === 0) {
    console.log("  No user timing events found.");
    return;
  }

  const marks = userTimingEvents.filter((e) => e.ph === "R" || e.ph === "I" || e.ph === "i");
  const measures = userTimingEvents.filter((e) => e.ph === "X" || e.ph === "b" || e.ph === "e");

  console.log(`  Marks: ${marks.length}`);
  console.log(`  Measures: ${measures.length}`);

  if (marks.length > 0) {
    console.log(`\n  All marks (sorted by time):`);
    marks
      .sort((a, b) => a.ts - b.ts)
      .slice(0, 50)
      .forEach((e) => console.log(`    @${usToMs(e.ts).padStart(12)}  ${e.name}`));
  }

  if (measures.length > 0) {
    const byName = {};
    for (const e of measures) {
      if (!byName[e.name]) byName[e.name] = { count: 0, totalDur: 0, maxDur: 0 };
      byName[e.name].count++;
      if (e.dur) {
        byName[e.name].totalDur += e.dur;
        if (e.dur > byName[e.name].maxDur) byName[e.name].maxDur = e.dur;
      }
    }

    console.log(`\n  Measures by total duration:`);
    Object.entries(byName)
      .sort((a, b) => b[1].totalDur - a[1].totalDur)
      .slice(0, 30)
      .forEach(([name, s]) =>
        console.log(
          `    ${usToMs(s.totalDur).padStart(9)}ms total  ${usToMs(s.maxDur).padStart(8)}ms max  x${s.count.toString().padStart(5)}  ${name.slice(0, 70)}`
        )
      );
  }
}

// ─── Run sections ───────────────────────────────────────────────────
const sections = {
  summary: printSummary,
  "long-tasks": printLongTasks,
  frames: printFrames,
  react: printReact,
  "js-hotspots": printJsHotspots,
  "layout-paint": printLayoutPaint,
  gc: printGC,
  "user-timing": printUserTiming,
};

if (section === "all") {
  for (const fn of Object.values(sections)) fn();
} else if (sections[section]) {
  sections[section]();
} else {
  console.error(`Unknown section: ${section}. Available: ${Object.keys(sections).join(", ")}`);
  process.exit(1);
}
