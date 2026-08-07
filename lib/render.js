'use strict';

/**
 * Shared rendering: colors, glyphs, bars, and the segment builders used by
 * both the Claude Code statusline and the Codex bar.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const C = {
  amber: '\x1b[38;5;214m',
  rose: '\x1b[38;5;173m',
  yellow: '\x1b[38;5;220m',
  orange: '\x1b[38;5;208m',
  red: '\x1b[1;38;5;196m',
  green: '\x1b[38;5;114m',
  blue: '\x1b[38;5;117m',
  dim: '\x1b[2m',
  reset: '\x1b[0m',
};

const UNICODE_GLYPHS = {
  full: '█', empty: '░', sep: '│', bolt: '⚡', star: '✳', gear: '⬢', reset: '↻', dot: '·',
};
const ASCII_GLYPHS = {
  full: '|', empty: '_', sep: '|', bolt: '*', star: '*', gear: '#', reset: '~', dot: '-',
};

/**
 * Block glyphs need a UTF-8 locale: without one tmux and some terminals
 * mangle them into underscores. Override with USAGE_BAR_GLYPHS=ascii|unicode.
 */
function glyphSet(env = process.env) {
  const forced = String(env.USAGE_BAR_GLYPHS || '').trim().toLowerCase();
  if (forced === 'ascii') return ASCII_GLYPHS;
  if (forced === 'unicode') return UNICODE_GLYPHS;
  const locale = `${env.LC_ALL || ''} ${env.LC_CTYPE || ''} ${env.LANG || ''}`;
  return /utf-?8/i.test(locale) ? UNICODE_GLYPHS : ASCII_GLYPHS;
}

const G = glyphSet();

/** Color for a used-percentage: calm until it matters, then escalating. */
function pctColor(pct, base = C.amber) {
  if (pct >= 90) return C.red;
  if (pct >= 80) return C.orange;
  if (pct >= 60) return C.yellow;
  return base;
}

function buildBar(pct, width = 8) {
  const clamped = Math.max(0, Math.min(100, Math.round(pct)));
  const filled = Math.round((clamped / 100) * width);
  return G.full.repeat(filled) + G.empty.repeat(width - filled);
}

/** Countdown to a unix-seconds timestamp: "42m", "1h20m", "3d". */
function formatCountdown(epochSecs) {
  if (!epochSecs || typeof epochSecs !== 'number') return '';
  const secs = Math.floor(epochSecs - Date.now() / 1000);
  if (secs <= 0) return '';
  const mins = Math.ceil(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) {
    const rem = mins % 60;
    return rem > 0 ? `${hours}h${rem}m` : `${hours}h`;
  }
  return `${Math.round(hours / 24)}d`;
}

/** Duration from milliseconds: "30s", "5m", "3h11m". */
function formatMs(ms) {
  if (!ms || ms < 0) return '';
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem > 0 ? `${hours}h${rem}m` : `${hours}h`;
}

function compactTokens(total) {
  if (!total) return '';
  return total >= 1000000 ? `${(total / 1000000).toFixed(1)}M` : `${Math.round(total / 1000)}K`;
}

/** Painters for ANSI terminals, tmux status-format, or no color at all. */
function palette(mode = 'ansi') {
  if (mode === 'plain') {
    const id = t => t;
    return { amber: id, rose: id, blue: id, warn: id, crit: id, ok: id, dim: id };
  }
  if (mode === 'tmux') {
    const wrap = code => t => `#[fg=${code}]${t}#[default]`;
    return {
      amber: wrap('colour214'),
      rose: wrap('colour173'),
      blue: wrap('colour117'),
      warn: wrap('colour208'),
      crit: wrap('colour196,bold'),
      ok: wrap('colour114'),
      dim: wrap('colour245'),
    };
  }
  const wrap = code => t => `${code}${t}${C.reset}`;
  return {
    amber: wrap(C.amber),
    rose: wrap(C.rose),
    blue: wrap(C.blue),
    warn: wrap(C.orange),
    crit: wrap(C.red),
    ok: wrap(C.green),
    dim: wrap(C.dim),
  };
}

function separator(p) {
  return ` ${p.dim(G.sep)} `;
}

/**
 * A usage window segment: "5h ███░░░░░ 38% ↻2h10m".
 * @param {{used: number, resetsAt?: number}} window
 */
function usageSegment(label, window, p, base) {
  if (!window || typeof window.used !== 'number' || window.used < 0) return '';
  const pct = Math.round(window.used);
  const paint = pct >= 90 ? p.crit : pct >= 60 ? p.warn : base;
  const countdown = formatCountdown(window.resetsAt);
  const tail = countdown ? ` ${p.dim(`${G.reset}${countdown}`)}` : '';
  return `${base(label)} ${paint(`${buildBar(pct)} ${pct}%`)}${tail}`;
}

/** Line 1: usage windows plus optional prompt-cache hit rate. */
function buildUsageLine(windows, cachePct, p) {
  const parts = [];
  const primary = usageSegment(windows.primaryLabel || '5h', windows.primary, p, p.amber);
  const secondary = usageSegment(windows.secondaryLabel || '7d', windows.secondary, p, p.rose);
  if (primary) parts.push(primary);
  if (secondary) parts.push(secondary);
  if (typeof cachePct === 'number' && parts.length > 0) {
    parts.push(`${p.dim('cache')} ${cachePct >= 50 ? p.ok(`${cachePct}%`) : p.dim(`${cachePct}%`)}`);
  }
  if (parts.length === 0) return '';
  return `${p.amber(G.bolt)} ${parts.join(separator(p))}`;
}

/**
 * Line 3: what is actually enabled — plugins with versions, extra config
 * chips, then the directory. Returns '' when there is nothing to say.
 */
function buildConfigLine(info, p) {
  const parts = [];
  if (Array.isArray(info.plugins) && info.plugins.length > 0) {
    const shown = info.plugins.slice(0, 4)
      .map(x => `${x.name}${x.version ? ` ${p.dim(x.version)}` : ''}`);
    const more = info.plugins.length > 4 ? ` ${p.dim(`+${info.plugins.length - 4}`)}` : '';
    parts.push(`${p.rose(G.gear)} ${shown.join(` ${p.dim(G.dot)} `)}${more}`);
  }
  for (const chip of info.chips || []) {
    if (chip) parts.push(p.dim(chip));
  }
  if (info.dirname) parts.push(p.dim(info.dirname));
  return parts.join(separator(p));
}

/** Enabled Claude Code plugins with versions, from the plugin state files. */
function readClaudePlugins(configDir) {
  try {
    const dir = configDir || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
    const installed = JSON.parse(
      fs.readFileSync(path.join(dir, 'plugins', 'installed_plugins.json'), 'utf8')
    );
    let enabled = null;
    try {
      const settings = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
      if (settings.enabledPlugins && typeof settings.enabledPlugins === 'object') {
        enabled = settings.enabledPlugins;
      }
    } catch { /* show everything installed */ }

    const plugins = [];
    for (const [id, entries] of Object.entries(installed?.plugins || {})) {
      if (enabled && enabled[id] === false) continue;
      const entry = Array.isArray(entries) ? entries[0] : entries;
      plugins.push({ name: id.split('@')[0], version: entry?.version || '' });
    }
    return plugins.sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

/** Configured Claude Code hook events, for a "hooks N" chip. */
function countClaudeHooks(configDir) {
  try {
    const dir = configDir || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
    const settings = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
    const hooks = settings.hooks;
    if (!hooks || typeof hooks !== 'object') return 0;
    return Object.values(hooks)
      .reduce((total, matchers) => total + (Array.isArray(matchers) ? matchers.length : 0), 0);
  } catch {
    return 0;
  }
}

module.exports = {
  C,
  G,
  UNICODE_GLYPHS,
  ASCII_GLYPHS,
  glyphSet,
  pctColor,
  buildBar,
  formatCountdown,
  formatMs,
  compactTokens,
  palette,
  separator,
  usageSegment,
  buildUsageLine,
  buildConfigLine,
  readClaudePlugins,
  countClaudeHooks,
};
