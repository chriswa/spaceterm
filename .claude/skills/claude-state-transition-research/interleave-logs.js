#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { parseArgs } = require('util');

// ── CLI ─────────────────────────────────────────────────────────────────────

const USAGE = `
Usage: node interleave-logs.js <surfaceId> [options]

Interleave decision log, hook log, Claude session transcript, and electron log
entries in chronological order for debugging state transition bugs.

Options:
  --session <id>           Claude session ID (auto-discovered from hook log if omitted)
  --cwd <path>             CWD of the Claude session (auto-discovered if omitted)
  --transcript <path>      Direct path to transcript JSONL (overrides --session/--cwd)
  --from <iso8601>         Only show entries at or after this timestamp
  --to <iso8601>           Only show entries at or before this timestamp
  --sources <list>         Comma-separated sources (default: decision,hook,transcript)
  --skip-status-lines      Hide status-line entries from hook log
  --help                   Print usage
`.trim();

let parsed;
try {
  parsed = parseArgs({
    allowPositionals: true,
    options: {
      session:            { type: 'string' },
      cwd:                { type: 'string' },
      transcript:         { type: 'string' },
      from:               { type: 'string' },
      to:                 { type: 'string' },
      sources:            { type: 'string' },
      'skip-status-lines': { type: 'boolean', default: false },
      help:               { type: 'boolean', default: false },
    },
  });
} catch (e) {
  process.stderr.write(`Error: ${e.message}\n\n${USAGE}\n`);
  process.exit(1);
}

const { values: opts, positionals } = parsed;

if (opts.help || positionals.length === 0) {
  process.stdout.write(USAGE + '\n');
  process.exit(0);
}

const surfaceId = positionals[0];
const homeDir = process.env.HOME || process.env.USERPROFILE || '';
const spacetermDir = path.join(homeDir, '.spaceterm');

const fromMs = opts.from ? new Date(opts.from).getTime() : -Infinity;
const toMs   = opts.to   ? new Date(opts.to).getTime()   : Infinity;
if (opts.from && Number.isNaN(fromMs)) {
  process.stderr.write(`Error: invalid --from timestamp: ${opts.from}\n`);
  process.exit(1);
}
if (opts.to && Number.isNaN(toMs)) {
  process.stderr.write(`Error: invalid --to timestamp: ${opts.to}\n`);
  process.exit(1);
}

const enabledSources = new Set(
  (opts.sources || 'decision,hook,transcript').split(',').map(s => s.trim()),
);

// ── Helpers ─────────────────────────────────────────────────────────────────

const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;
function stripAnsi(s) {
  return typeof s === 'string' ? s.replace(ANSI_RE, '') : s;
}

/** Source priority for tie-breaking (lower = higher priority). */
const SOURCE_PRIORITY = { hook: 0, decision: 1, transcript: 2, electron: 3 };

function abbreviateUuid(uuid) {
  const stripped = uuid.replace(/-/g, '');
  if (stripped.length <= 12) return uuid;
  return stripped.slice(0, 8) + '..' + stripped.slice(-4);
}

function truncate(s, max) {
  if (!s) return '';
  s = s.replace(/\n/g, ' ').trim();
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

function formatTs(epochMs) {
  const d = new Date(epochMs);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms}`;
}

function parseTimestamp(ts) {
  if (typeof ts !== 'string') return NaN;
  return new Date(ts).getTime();
}

// ── Parsers ─────────────────────────────────────────────────────────────────

function readJsonlFile(filePath) {
  const entries = [];
  if (!fs.existsSync(filePath)) return entries;
  const lines = fs.readFileSync(filePath, 'utf8').split('\n');
  const basename = path.basename(filePath);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      entries.push({ obj: JSON.parse(line), file: basename, lineNo: i + 1 });
    } catch {
      process.stderr.write(`warn: malformed JSON at ${basename}:${i + 1}, skipping\n`);
    }
  }
  return entries;
}

function readPlainLines(filePath) {
  const entries = [];
  if (!fs.existsSync(filePath)) return entries;
  const lines = fs.readFileSync(filePath, 'utf8').split('\n');
  const basename = path.basename(filePath);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    entries.push({ raw: line, file: basename, lineNo: i + 1 });
  }
  return entries;
}

// ── Decision log ────────────────────────────────────────────────────────────

function parseDecisionEntries(filePath) {
  const results = [];
  for (const { obj, file, lineNo } of readJsonlFile(filePath)) {
    const ms = parseTimestamp(obj.timestamp);
    if (Number.isNaN(ms)) continue;
    if (ms < fromMs || ms > toMs) continue;

    let summary = `${obj.event || '?'} ${obj.prevState || '?'}->${obj.newState || '?'}`;
    if (obj.detail) summary += ` detail=${obj.detail}`;
    if (obj.suppressed) summary += ' SUPPRESSED';
    if (obj.unread) summary += ' [!unread]';

    results.push({
      epochMs: ms,
      source: 'decision',
      loc: `${abbreviateUuid(surfaceId)}:${lineNo}`,
      summary: stripAnsi(summary),
    });
  }
  return results;
}

// ── Hook log ────────────────────────────────────────────────────────────────

function parseHookEntries(filePath, skipStatusLines) {
  const results = [];
  for (const { obj, file, lineNo } of readJsonlFile(filePath)) {
    const ms = parseTimestamp(obj.timestamp);
    if (Number.isNaN(ms)) continue;
    if (ms < fromMs || ms > toMs) continue;

    const isStatusLine = obj.type === 'status-line';
    if (isStatusLine && skipStatusLines) continue;

    let summary;
    if (isStatusLine) {
      const cost = obj.payload?.cost?.total_cost_usd;
      const ctx  = obj.payload?.context_window?.used_percentage;
      const costStr = cost != null ? `$${cost.toFixed(4)}` : '?';
      const ctxStr  = ctx  != null ? `${ctx}%` : '?';
      summary = `status-line cost=${costStr} ctx=${ctxStr}`;
    } else {
      const hookType = obj.hookType || '?';
      const p = obj.payload || {};
      let detail = '';
      if (p.tool_name) detail += ` tool=${p.tool_name}`;
      if (p.notification_type) detail += ` type=${p.notification_type}`;
      if (p.prompt) detail += ` prompt="${truncate(p.prompt, 60)}"`;
      if (p.agent_type) detail += ` agent=${p.agent_type}`;
      if (p.source) detail += ` source=${p.source}`;
      summary = `${hookType}${detail}`;
    }

    results.push({
      epochMs: ms,
      source: 'hook',
      loc: `${abbreviateUuid(surfaceId)}:${lineNo}`,
      summary: stripAnsi(summary),
    });
  }
  return results;
}

// ── Transcript ──────────────────────────────────────────────────────────────

function parseTranscriptEntries(filePath) {
  const results = [];
  for (const { obj, file, lineNo } of readJsonlFile(filePath)) {
    const ms = parseTimestamp(obj.timestamp);
    if (Number.isNaN(ms)) continue;
    if (ms < fromMs || ms > toMs) continue;

    const type = obj.type;
    let summary;

    if (type === 'user') {
      const msg = obj.message;
      if (typeof msg === 'string') {
        summary = `user "${truncate(msg, 60)}"`;
      } else if (msg && typeof msg === 'object') {
        const content = msg.content;
        if (typeof content === 'string') {
          if (content.includes('interrupted by user')) {
            summary = 'user [interrupted]';
          } else {
            summary = `user "${truncate(content, 60)}"`;
          }
        } else if (Array.isArray(content)) {
          const hasInterrupt = content.some(
            b => typeof b === 'string' && b.includes('interrupted by user'),
          );
          if (hasInterrupt) {
            summary = 'user [interrupted]';
          } else {
            const toolResults = content.filter(b => b.type === 'tool_result');
            if (toolResults.length > 0) {
              summary = `user tool_results(${toolResults.length})`;
            } else {
              const text = content.find(b => b.type === 'text');
              summary = text
                ? `user "${truncate(text.text || '', 60)}"`
                : `user [${content.map(b => b.type || '?').join(',')}]`;
            }
          }
        } else {
          summary = 'user [unknown]';
        }
      } else {
        summary = 'user [unknown]';
      }
    } else if (type === 'assistant') {
      const msg = obj.message || {};
      const content = msg.content;
      if (Array.isArray(content) && content.length > 0) {
        const last = content[content.length - 1];
        const blockType = last.type || '?';
        if (blockType === 'tool_use') {
          summary = `assistant tool_use(${last.name || '?'})`;
        } else if (blockType === 'text') {
          summary = `assistant text "${truncate(last.text || '', 60)}"`;
        } else {
          summary = `assistant ${blockType}`;
        }
      } else {
        summary = 'assistant [empty]';
      }
    } else if (type === 'progress') {
      const data = obj.data || {};
      const hookEvent = data.hookEvent || '?';
      const hookName = data.hookName || '?';
      summary = `progress ${hookEvent}:${hookName}`;
    } else {
      summary = `${type || '?'}`;
    }

    const sessionId = obj.sessionId || '?';
    results.push({
      epochMs: ms,
      source: 'transcript',
      loc: `${abbreviateUuid(sessionId)}:${lineNo}`,
      summary: stripAnsi(summary),
    });
  }
  return results;
}

// ── Electron log ────────────────────────────────────────────────────────────

function parseElectronEntries(filePath) {
  const results = [];
  // Electron log format: ISO8601  message text
  const TS_RE = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z?)\s{2}/;
  for (const { raw, file, lineNo } of readPlainLines(filePath)) {
    const m = raw.match(TS_RE);
    if (!m) continue;
    const ms = parseTimestamp(m[1]);
    if (Number.isNaN(ms)) continue;
    if (ms < fromMs || ms > toMs) continue;

    const message = raw.slice(m[0].length);
    results.push({
      epochMs: ms,
      source: 'electron',
      loc: `electron.log:${lineNo}`,
      summary: stripAnsi(truncate(message, 120)),
    });
  }
  return results;
}

// ── Auto-discovery ──────────────────────────────────────────────────────────

function autoDiscover(hookLogPath) {
  const entries = readJsonlFile(hookLogPath);
  let sessionId = null;
  let cwd = null;
  let transcriptPath = null;

  // Walk backwards to find the last SessionStart (or the one matching --session)
  for (let i = entries.length - 1; i >= 0; i--) {
    const obj = entries[i].obj;
    if (obj.hookType !== 'SessionStart') continue;
    const p = obj.payload || {};
    if (opts.session && p.session_id !== opts.session) continue;
    sessionId = p.session_id;
    cwd = p.cwd;
    transcriptPath = p.transcript_path;
    break;
  }

  return { sessionId, cwd, transcriptPath };
}

// ── Main ────────────────────────────────────────────────────────────────────

function main() {
  const decisionLogPath = path.join(spacetermDir, 'decision-logs', `${surfaceId}.jsonl`);
  const hookLogPath     = path.join(spacetermDir, 'hook-logs', `${surfaceId}.jsonl`);
  const electronLogPath = path.join(spacetermDir, 'electron.log');

  // Auto-discover session info from hook log
  let sessionId = opts.session || null;
  let sessionCwd = opts.cwd || null;
  let transcriptPath = opts.transcript || null;

  if (!transcriptPath && fs.existsSync(hookLogPath)) {
    const discovered = autoDiscover(hookLogPath);
    if (!sessionId && discovered.sessionId) sessionId = discovered.sessionId;
    if (!sessionCwd && discovered.cwd) sessionCwd = discovered.cwd;
    if (!transcriptPath && discovered.transcriptPath) transcriptPath = discovered.transcriptPath;
  }

  // If we still have no transcript path but have session + cwd, build it
  if (!transcriptPath && sessionId && sessionCwd) {
    const slug = sessionCwd.replace(/\//g, '-');
    transcriptPath = path.join(homeDir, '.claude', 'projects', slug, `${sessionId}.jsonl`);
  }

  // Collect all entries
  let allEntries = [];
  const counts = { decision: 0, hook: 0, transcript: 0, electron: 0 };

  if (enabledSources.has('decision')) {
    if (fs.existsSync(decisionLogPath)) {
      const entries = parseDecisionEntries(decisionLogPath);
      counts.decision = entries.length;
      allEntries.push(...entries);
    } else {
      process.stderr.write(`warn: decision log not found: ${decisionLogPath}\n`);
    }
  }

  if (enabledSources.has('hook')) {
    if (fs.existsSync(hookLogPath)) {
      const entries = parseHookEntries(hookLogPath, opts['skip-status-lines']);
      counts.hook = entries.length;
      allEntries.push(...entries);
    } else {
      process.stderr.write(`warn: hook log not found: ${hookLogPath}\n`);
    }
  }

  if (enabledSources.has('transcript')) {
    if (transcriptPath && fs.existsSync(transcriptPath)) {
      const entries = parseTranscriptEntries(transcriptPath);
      counts.transcript = entries.length;
      allEntries.push(...entries);
    } else if (transcriptPath) {
      process.stderr.write(`warn: transcript not found: ${transcriptPath}\n`);
    } else {
      process.stderr.write('warn: no transcript path discovered (use --transcript or --session + --cwd)\n');
    }
  }

  if (enabledSources.has('electron')) {
    if (!opts.from && !opts.to) {
      process.stderr.write('warn: electron log included without --from/--to; may be noisy\n');
    }
    if (fs.existsSync(electronLogPath)) {
      const entries = parseElectronEntries(electronLogPath);
      counts.electron = entries.length;
      allEntries.push(...entries);
    } else {
      process.stderr.write(`warn: electron log not found: ${electronLogPath}\n`);
    }
  }

  // Stable sort: by epochMs, then source priority, then original insertion order
  // (entries from each source are already in file order)
  allEntries.forEach((e, i) => { e._order = i; });
  allEntries.sort((a, b) =>
    (a.epochMs - b.epochMs) ||
    (SOURCE_PRIORITY[a.source] - SOURCE_PRIORITY[b.source]) ||
    (a._order - b._order)
  );

  // Header
  const dateStr = allEntries.length > 0
    ? new Date(allEntries[0].epochMs).toLocaleDateString()
    : 'n/a';

  process.stdout.write('\n');
  process.stdout.write(`Surface:    ${surfaceId}\n`);
  process.stdout.write(`Session:    ${sessionId || '(not discovered)'}\n`);
  process.stdout.write(`Date:       ${dateStr}\n`);
  process.stdout.write(`Entries:    ${allEntries.length}`);
  const parts = [];
  for (const [k, v] of Object.entries(counts)) {
    if (v > 0) parts.push(`${k}=${v}`);
  }
  if (parts.length > 0) process.stdout.write(` (${parts.join(', ')})`);
  process.stdout.write('\n');
  if (opts.from || opts.to) {
    process.stdout.write(`Filter:     ${opts.from || '*'} .. ${opts.to || '*'}\n`);
  }
  process.stdout.write('\n');

  if (allEntries.length === 0) {
    process.stdout.write('No entries found after filtering.\n');
    return;
  }

  // Output
  const srcPad = 12; // length of '[transcript]'
  for (const e of allEntries) {
    const ts = formatTs(e.epochMs);
    const srcTag = `[${e.source}]`.padEnd(srcPad);
    process.stdout.write(`${ts}  ${srcTag}  ${e.loc}  ${e.summary}\n`);
  }
}

main();
