#!/usr/bin/env node
'use strict';

/**
 * Codex CLI usage bar.
 *
 * Codex has no custom status-line API, so the bar is rendered outside its TUI
 * and pinned by the wrapper (tmux status area, terminal title, or `watch`).
 * Everything comes from the newest session transcript Codex writes anyway.
 *
 *   codex-bar.js              one compact line
 *   codex-bar.js --full       three lines, matching the Claude statusline
 *   codex-bar.js --line N     just line N (used for tmux status-format)
 *   codex-bar.js --tmux       tmux #[fg=...] coloring
 *   codex-bar.js --plain      no color at all
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
  compactTokens,
} = require('../lib/render');

const TAIL_BYTES = 256 * 1024;

/**
 * Most recently *written* rollout transcript. Modification time beats filename
 * order: resuming an old session appends to its original file.
 */
function findNewestSession(codexHome) {
  const sessionsDir = path.join(codexHome, 'sessions');
  const newest = (dir, limit) => fs.readdirSync(dir).sort().reverse().slice(0, limit);
  try {
    const dayDirs = [];
    for (const year of newest(sessionsDir, 2)) {
      for (const month of newest(path.join(sessionsDir, year), 2)) {
        for (const day of newest(path.join(sessionsDir, year, month), 3)) {
          dayDirs.push(path.join(sessionsDir, year, month, day));
        }
      }
    }
    let best = null;
    for (const dir of dayDirs.slice(0, 6)) {
      for (const name of fs.readdirSync(dir)) {
        if (!name.startsWith('rollout-') || !name.endsWith('.jsonl')) continue;
        const file = path.join(dir, name);
        const mtime = fs.statSync(file).mtimeMs;
        if (!best || mtime > best.mtime) best = { file, mtime };
      }
    }
    return best ? best.file : null;
  } catch {
    return null;
  }
}

/** Last token_count event, read from the tail so huge transcripts stay cheap. */
function readLastTokenCount(sessionFile) {
  try {
    const stat = fs.statSync(sessionFile);
    const start = Math.max(0, stat.size - TAIL_BYTES);
    const fd = fs.openSync(sessionFile, 'r');
    const buffer = Buffer.alloc(stat.size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    fs.closeSync(fd);
    const lines = buffer.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"token_count"')) continue;
      try {
        const event = JSON.parse(lines[i]);
        if (event?.payload?.type === 'token_count') return event.payload;
      } catch { /* torn line at the tail boundary */ }
    }
    return null;
  } catch {
    return null;
  }
}

/** "5h" / "7d" / "12h" from a window length in minutes. */
function windowLabel(minutes) {
  if (!minutes) return '';
  if (minutes % 10080 === 0) return `${(minutes / 10080) * 7}d`;
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  return `${Math.round(minutes / 60)}h`;
}

function readConfigValue(codexHome, pattern) {
  try {
    return fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8').match(pattern)?.[1] || '';
  } catch {
    return '';
  }
}

/** Enabled Codex plugins (Codex records no versions). */
function readCodexPlugins(codexHome) {
  try {
    const toml = fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8');
    const plugins = [];
    const table = /\[plugins\."([^"]+)"\]([^[]*)/g;
    let match;
    while ((match = table.exec(toml)) !== null) {
      if (/^\s*enabled\s*=\s*true/m.test(match[2])) {
        plugins.push({ name: match[1].split('@')[0], version: '' });
      }
    }
    return plugins.sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

/** Hooks Codex has reviewed and trusted, for a "hooks N" chip. */
function countCodexHooks(codexHome) {
  try {
    const toml = fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8');
    return (toml.match(/^\[hooks\.state\."[^"]+"\]/gm) || []).length;
  } catch {
    return 0;
  }
}

function toWindow(limit) {
  if (!limit || typeof limit.used_percent !== 'number') return null;
  return { used: limit.used_percent, resetsAt: limit.resets_at };
}

/**
 * Three lines mirroring the Claude statusline.
 * @param {'ansi'|'tmux'|'plain'} mode
 * @returns {string[]}
 */
function buildLines(tokenCount, codexHome, mode = 'ansi') {
  const p = palette(mode);
  const sep = separator(p);
  const info = tokenCount?.info || {};
  const limits = tokenCount?.rate_limits || {};
  const last = info.last_token_usage;

  const cachePct = last?.input_tokens > 0
    ? Math.round(((last.cached_input_tokens || 0) / last.input_tokens) * 100)
    : undefined;
  const line1 = buildUsageLine({
    primary: toWindow(limits.primary),
    primaryLabel: windowLabel(limits.primary?.window_minutes) || '5h',
    secondary: toWindow(limits.secondary),
    secondaryLabel: windowLabel(limits.secondary?.window_minutes) || '7d',
  }, cachePct, p) || p.dim(`${G.bolt} no session data yet`);

  const line2Parts = [
    p.amber(`${G.star} ${readConfigValue(codexHome, /^model\s*=\s*"([^"]+)"/m) || 'codex'}`),
  ];
  const used = last?.total_tokens ?? info.total_token_usage?.total_tokens;
  if (used && info.model_context_window) {
    const pct = Math.min(100, Math.round((used / info.model_context_window) * 100));
    const paint = pct >= 90 ? p.crit : pct >= 75 ? p.warn : p.ok;
    const size = `${Math.round(info.model_context_window / 1000)}K`;
    line2Parts.push(`${p.dim('ctx')} ${paint(`${buildBar(pct, 10)} ${pct}%`)} ${p.dim(size)}`);
  }
  const total = compactTokens(info.total_token_usage?.total_tokens);
  if (total) line2Parts.push(p.dim(`${total} tok`));

  const hooks = countCodexHooks(codexHome);
  const line3 = buildConfigLine({
    plugins: readCodexPlugins(codexHome),
    chips: [hooks > 0 ? `hooks ${hooks}` : ''],
    dirname: path.basename(process.cwd()),
  }, p);

  return [line1, line2Parts.join(sep), line3].filter(Boolean);
}

function main() {
  const argv = process.argv.slice(2);
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const mode = argv.includes('--plain') ? 'plain' : argv.includes('--tmux') ? 'tmux' : 'ansi';
  const sessionFile = findNewestSession(codexHome);
  const lines = buildLines(
    sessionFile ? readLastTokenCount(sessionFile) : null,
    codexHome,
    mode
  );

  const lineFlag = argv.indexOf('--line');
  if (lineFlag !== -1) {
    process.stdout.write(`${lines[Number(argv[lineFlag + 1]) - 1] || ''}\n`);
    return;
  }
  if (argv.includes('--full')) {
    process.stdout.write(`${lines.join('\n')}\n`);
    return;
  }
  // Compact single line: usage plus the model/context summary.
  process.stdout.write(`${lines.slice(0, 2).join(separator(palette(mode)))}\n`);
}

module.exports = {
  findNewestSession,
  readLastTokenCount,
  windowLabel,
  readCodexPlugins,
  countCodexHooks,
  buildLines,
};

if (require.main === module) main();
