'use strict';

/**
 * Tests for lib/render.js and both bars. Run with: npm test
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const render = require('../lib/render');
const claude = require('../bin/claude-statusline');
const codex = require('../bin/codex-bar');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ok  ${name}`);
    passed += 1;
  } catch (err) {
    console.log(`  FAIL  ${name}\n        ${err.message}`);
    failed += 1;
  }
}

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-usage-bar-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

console.log('\nrender');
test('bar fills proportionally and clamps', () => {
  assert.strictEqual(render.buildBar(50, 8).length, 8);
  assert.strictEqual(render.buildBar(0, 4), render.G.empty.repeat(4));
  assert.strictEqual(render.buildBar(100, 4), render.G.full.repeat(4));
  assert.strictEqual(render.buildBar(999, 4), render.G.full.repeat(4));
});

test('glyphs fall back to ASCII without a UTF-8 locale', () => {
  assert.strictEqual(render.glyphSet({ LANG: 'C' }), render.ASCII_GLYPHS);
  assert.strictEqual(render.glyphSet({ LANG: 'en_US.UTF-8' }), render.UNICODE_GLYPHS);
  assert.strictEqual(
    render.glyphSet({ LANG: 'en_US.UTF-8', USAGE_BAR_GLYPHS: 'ascii' }),
    render.ASCII_GLYPHS
  );
});

test('countdowns and durations use compact units', () => {
  assert.strictEqual(render.formatCountdown(Date.now() / 1000 - 10), '');
  assert.ok(/^\d+m$/.test(render.formatCountdown(Date.now() / 1000 + 600)));
  assert.strictEqual(render.formatMs(30 * 1000), '30s');
  assert.strictEqual(render.formatMs((3 * 60 + 11) * 60 * 1000), '3h11m');
});

test('config line is empty when there is nothing to report', () => {
  const p = render.palette('plain');
  assert.strictEqual(render.buildConfigLine({ plugins: [], chips: [] }, p), '');
  const line = render.buildConfigLine({
    plugins: [{ name: 'swift-lsp', version: '1.0.0' }],
    chips: ['hooks 3'],
    dirname: 'myproject',
  }, p);
  assert.ok(line.includes('swift-lsp 1.0.0') && line.includes('hooks 3') && line.includes('myproject'));
});

console.log('\nclaude statusline');
test('renders all three lines from a session snapshot', () => {
  const lines = claude.buildLines({
    model: { display_name: 'Opus 5' },
    effort: { level: 'xhigh' },
    workspace: { current_dir: '/tmp/myproject' },
    context_window: {
      remaining_percentage: 82,
      context_window_size: 1000000,
      current_usage: { input_tokens: 10, cache_read_input_tokens: 90 },
    },
    cost: { total_cost_usd: 7.85, total_lines_added: 49, total_lines_removed: 4, total_duration_ms: 2160000 },
    rate_limits: {
      five_hour: { used_percentage: 84, resets_at: Date.now() / 1000 + 6840 },
      seven_day: { used_percentage: 14, resets_at: Date.now() / 1000 + 345600 },
    },
  }, 'plain');
  assert.strictEqual(lines.length, 3);
  assert.ok(lines[0].includes('5h') && lines[0].includes('84%') && lines[0].includes('cache 90%'));
  assert.ok(lines[1].includes('Opus 5') && lines[1].includes('xhigh') && lines[1].includes('$7.85'));
  assert.ok(lines[2].includes('myproject'));
});

test('the usage line disappears without rate limits', () => {
  const lines = claude.buildLines({ model: { display_name: 'Opus 5' } }, 'plain');
  assert.ok(!lines.some(l => l.includes('5h')), 'no quota line on API-key billing');
});

console.log('\ncodex bar');
test('picks the most recently modified transcript', () => {
  withTempDir(dir => {
    const day = path.join(dir, 'sessions', '2026', '08', '07');
    fs.mkdirSync(day, { recursive: true });
    const event = pct => `${JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: { total_token_usage: { total_tokens: 1000 }, model_context_window: 258000 },
        rate_limits: { primary: { used_percent: pct, window_minutes: 10080 } },
      },
    })}\n`;
    // The lexicographically last name is deliberately the stale one.
    fs.writeFileSync(path.join(day, 'rollout-2026-08-07T23-00-00-zzz.jsonl'), event(5));
    const active = path.join(day, 'rollout-2026-08-07T01-00-00-aaa.jsonl');
    fs.writeFileSync(active, event(42));
    const future = new Date(Date.now() + 60000);
    fs.utimesSync(active, future, future);

    assert.strictEqual(codex.findNewestSession(dir), active);
    assert.strictEqual(codex.readLastTokenCount(active).rate_limits.primary.used_percent, 42);
  });
});

test('window labels map minutes to human units', () => {
  assert.strictEqual(codex.windowLabel(10080), '7d');
  assert.strictEqual(codex.windowLabel(300), '5h');
  assert.strictEqual(codex.windowLabel(undefined), '');
});

test('reads the session id and formats a bounded single-line title', () => {
  withTempDir(dir => {
    const session = path.join(dir, 'rollout-test-019ff263-bfe1-77e3-b7ad-ce4bc6fac389.jsonl');
    fs.writeFileSync(session, `${JSON.stringify({ type: 'session_meta', payload: { id: '019ff263-bfe1-77e3-b7ad-ce4bc6fac389' } })}\n`);
    assert.strictEqual(codex.readSessionId(session), '019ff263-bfe1-77e3-b7ad-ce4bc6fac389');
    assert.strictEqual(codex.formatConversationTitle('  First line\n second   line  ', 24), 'First line second line');
    assert.strictEqual(codex.formatConversationTitle('A deliberately long conversation title for the status bar', 32), 'A deliberately long…');
  });
});

test('prefers the Codex thread name over its fallback title', () => {
  withTempDir(dir => {
    fs.writeFileSync(path.join(dir, 'state_5.sqlite'), 'fixture');
    const session = path.join(dir, 'rollout-test-019ff263-bfe1-77e3-b7ad-ce4bc6fac389.jsonl');
    fs.writeFileSync(session, `${JSON.stringify({ type: 'session_meta', payload: { id: '019ff263-bfe1-77e3-b7ad-ce4bc6fac389' } })}\n`);
    const queried = [];
    const title = codex.readConversationTitle(dir, session, (_database, _id, field) => {
      queried.push(field);
      return field === 'name' ? 'Usage bar title work' : 'Fallback prompt';
    });
    assert.strictEqual(title, 'Usage bar title work');
    assert.deepStrictEqual(queried, ['name']);
  });
});

test('reads enabled plugins and trusted hooks from config.toml', () => {
  withTempDir(dir => {
    fs.writeFileSync(path.join(dir, 'config.toml'), [
      'model = "gpt-5.6"',
      '[plugins."alpha@market"]',
      'enabled = true',
      '[plugins."beta@market"]',
      'enabled = false',
      '[hooks.state."alpha@market:hooks/x.json:session_start:0:0"]',
      'trusted_hash = "sha256:abc"',
    ].join('\n'));
    assert.deepStrictEqual(codex.readCodexPlugins(dir), [{ name: 'alpha', version: '' }]);
    assert.strictEqual(codex.countCodexHooks(dir), 1);
  });
});

test('tmux mode emits the conversation title, tmux colors, and no raw ANSI', () => {
  withTempDir(dir => {
    const lines = codex.buildLines({
      info: {
        total_token_usage: { total_tokens: 2000000 },
        last_token_usage: { total_tokens: 50000, input_tokens: 40000, cached_input_tokens: 30000 },
        model_context_window: 258000,
      },
      rate_limits: { primary: { used_percent: 42, window_minutes: 10080 } },
    }, dir, 'tmux', 'Show the Codex conversation title');
    assert.strictEqual(lines.length, 3);
    assert.ok(lines[1].includes('chat') && lines[1].includes('Show the Codex conversation title'));
    assert.ok(lines.join('').includes('#[fg=colour214]'));
    assert.ok(!lines.join('').includes('\x1b['));
  });
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
