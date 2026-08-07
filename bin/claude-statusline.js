#!/usr/bin/env node
'use strict';

/**
 * Claude Code statusLine command.
 *
 * Renders three lines under the input box:
 *   1. 5h / 7d rate-limit bars with reset countdowns + prompt-cache hit rate
 *   2. model, context bar, session cost, lines changed, duration, current task
 *   3. enabled plugins with versions, config chips, directory
 *
 * Claude Code pipes a JSON snapshot of the session on stdin; everything here
 * is derived from that plus the local plugin/settings files.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  G,
  palette,
  separator,
  buildBar,
  buildUsageLine,
  buildConfigLine,
  formatMs,
  readClaudePlugins,
  countClaudeHooks,
} = require('../lib/render');

// Claude Code auto-compacts before the window is truly full; rescale so the
// bar reaches 100% at the point compaction actually kicks in.
const AUTO_COMPACT_BUFFER_PCT = 16.5;
const MAX_STDIN = 1024 * 1024;

/** Context bar rescaled to the usable window, with severity coloring. */
function buildContextSegment(remaining, windowSize, p) {
  if (remaining === null || remaining === undefined) return '';
  const usable = Math.max(0, ((remaining - AUTO_COMPACT_BUFFER_PCT) / (100 - AUTO_COMPACT_BUFFER_PCT)) * 100);
  const used = Math.max(0, Math.min(100, Math.round(100 - usable)));
  const paint = used >= 80 ? p.crit : used >= 50 ? p.warn : p.ok;
  const size = windowSize >= 1000000
    ? '1M'
    : windowSize ? `${Math.round(windowSize / 1000)}K` : '';
  return `${p.dim('ctx')} ${paint(`${buildBar(used, 10)} ${used}%`)}${size ? ` ${p.dim(size)}` : ''}`;
}

/** The in-progress todo for this session, when Claude Code is tracking one. */
function readCurrentTask(sessionId) {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(sessionId || '')) return '';
    const dir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
    const todosDir = path.join(dir, 'todos');
    if (!fs.existsSync(todosDir)) return '';
    const files = fs.readdirSync(todosDir)
      .filter(f => f.startsWith(sessionId) && f.endsWith('.json'))
      .map(f => ({ f, mtime: fs.statSync(path.join(todosDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    if (files.length === 0) return '';
    const todos = JSON.parse(fs.readFileSync(path.join(todosDir, files[0].f), 'utf8'));
    return todos.find(t => t.status === 'in_progress')?.activeForm || '';
  } catch {
    return '';
  }
}

function cacheHitPct(usage) {
  if (!usage) return undefined;
  const read = usage.cache_read_input_tokens || 0;
  const write = usage.cache_creation_input_tokens || 0;
  const fresh = usage.input_tokens || 0;
  const total = read + write + fresh;
  return total > 0 ? Math.round((read / total) * 100) : undefined;
}

/** @returns {string[]} the non-empty lines to print */
function buildLines(data, mode = 'ansi') {
  const p = palette(mode);
  const sep = separator(p);
  const ctx = data.context_window || {};
  const cost = data.cost || {};
  const limits = data.rate_limits || {};

  const line1 = buildUsageLine({
    primary: limits.five_hour ? {
      used: limits.five_hour.used_percentage,
      resetsAt: limits.five_hour.resets_at,
    } : null,
    secondary: limits.seven_day ? {
      used: limits.seven_day.used_percentage,
      resetsAt: limits.seven_day.resets_at,
    } : null,
  }, cacheHitPct(ctx.current_usage), p);

  const line2Parts = [];
  const badges = [];
  if (data.effort?.level && data.effort.level !== 'high') badges.push(data.effort.level);
  if (data.fast_mode) badges.push('fast');
  line2Parts.push(
    `${p.amber(`${G.star} ${data.model?.display_name || 'Claude'}`)}`
    + (badges.length > 0 ? ` ${p.dim(badges.join(' '))}` : '')
  );
  const ctxSegment = buildContextSegment(ctx.remaining_percentage, ctx.context_window_size, p);
  if (ctxSegment) line2Parts.push(ctxSegment);

  const metrics = [];
  if (cost.total_cost_usd > 0) metrics.push(`$${cost.total_cost_usd.toFixed(2)}`);
  if (cost.total_lines_added > 0 || cost.total_lines_removed > 0) {
    metrics.push(`+${cost.total_lines_added || 0}/-${cost.total_lines_removed || 0}`);
  }
  const duration = formatMs(cost.total_duration_ms);
  if (duration) metrics.push(duration);
  if (metrics.length > 0) line2Parts.push(p.blue(metrics.join(' ')));

  const task = readCurrentTask(data.session_id);
  if (task) line2Parts.push(`\x1b[1;97m${task}\x1b[0m`);

  const hookCount = countClaudeHooks();
  const line3 = buildConfigLine({
    plugins: readClaudePlugins(),
    chips: [
      hookCount > 0 ? `hooks ${hookCount}` : '',
      data.output_style?.name && data.output_style.name !== 'default'
        ? data.output_style.name
        : '',
    ],
    dirname: path.basename(data.workspace?.current_dir || process.cwd()),
  }, p);

  return [line1, line2Parts.join(sep), line3].filter(Boolean);
}

function main() {
  let input = '';
  const timeout = setTimeout(() => process.exit(0), 3000);
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    if (input.length < MAX_STDIN) input += chunk.slice(0, MAX_STDIN - input.length);
  });
  process.stdin.on('end', () => {
    clearTimeout(timeout);
    try {
      process.stdout.write(buildLines(JSON.parse(input)).join('\n'));
    } catch {
      // A statusline must never print a stack trace into the user's UI.
    }
  });
}

module.exports = { buildLines, buildContextSegment, readCurrentTask, cacheHitPct };

if (require.main === module) main();
