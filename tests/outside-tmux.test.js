'use strict';

/**
 * The bar must stay usable without tmux. Run with: npm test
 *
 * tmux only adds the three-line status variant. The window title and the
 * `usage_bar` user var are what a plain terminal gets, so these tests pin the
 * two things that quietly break that path:
 *
 *  1. the wrapper emitting OSC sequences only when running inside tmux
 *  2. consumers splitting the bar with a Lua character class, which matches
 *     BYTES: `│` is e2 94 82 and shares its leading e2 with ⬢, █, ░ and ↻, so
 *     `[^│]+` cuts those glyphs in half and emits invalid UTF-8
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');

const WRAPPER = 'bin/codex-wrapper';
const README = 'README.md';
const PANE = 'bin/codex-bar-pane';
const SEP = '│';

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

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

/** Every ```lua fenced block in a markdown document. */
function luaBlocks(markdown) {
  return [...markdown.matchAll(/```lua\n([\s\S]*?)```/g)].map(match => match[1]);
}

/**
 * Drop `--` line comments so the assertions judge executable Lua only. The
 * example deliberately names the byte-class antipattern in a comment to
 * explain why it is wrong.
 */
function stripLuaComments(source) {
  return source.replace(/--.*$/gm, '');
}

console.log('\nOutside tmux');

test('README gives every terminal a home for the three lines', () => {
  const readme = read(README);

  assert.ok(readme.includes('none of them need'), 'README must say tmux is optional');
  for (const row of [
    /\| tmux \| three lines of the session's status area \|/,
    /\| WezTerm \| a three-row pane across the bottom of the window \|/,
    /\| Terminal\.app and other VT100 terminals \| the bottom three rows/,
  ]) {
    assert.ok(row.test(readme), `the surface table is missing a row: ${row}`);
  }
  assert.ok(readme.includes('USAGE_BAR_REGION=off'), 'README must document the region opt-out');
  assert.ok(readme.includes('USAGE_BAR_PANE=off'), 'README must document the pane opt-out');
});

test('the redundant surfaces are gone, not merely undocumented', () => {
  const wrapper = read(WRAPPER);

  // The bar now owns three rows everywhere, so the title and user-var copies
  // were duplicate information, and the tab-bar Lua example duplicated them again.
  assert.ok(!wrapper.includes('SetUserVar'), 'the user-var mirror must be gone');
  assert.ok(!/\\033\]2;/.test(wrapper), 'the window-title mirror must be gone');
  assert.ok(
    !fs.existsSync(path.join(repoRoot, 'examples/wezterm-usage-bar.lua')),
    'the tab-bar Lua example must be gone'
  );
  // The installer must not stack a second status line under the composer.
  assert.ok(
    !/status_line = \[/.test(read('install.sh')),
    'install.sh must not configure Codex native status_line widgets'
  );
});

test('WezTerm gets the three-line bar in a pane of its own', () => {
  const wrapper = read(WRAPPER);
  const pane = read(PANE);

  assert.ok(wrapper.includes('wezterm_bar_on'), 'wrapper must open the bar pane');
  const cleanup = wrapper.slice(wrapper.indexOf('cleanup() {'), wrapper.indexOf('trap cleanup'));
  assert.ok(
    cleanup.includes('wezterm_bar_off'),
    'cleanup must close the bar pane or it outlives Codex'
  );

  assert.ok(wrapper.includes('--top-level'), 'the pane must span the whole window');
  assert.ok(wrapper.includes('--cells 3'), 'the pane must be three lines tall');
  assert.ok(wrapper.includes('activate-pane'), 'focus must return to Codex after the split');
  assert.ok(
    /\[ -z "\$\{TMUX:-\}" \]/.test(wrapper),
    'the pane must not open inside tmux, which already draws the bar'
  );

  // A wrapper killed with SIGKILL never runs its trap, so the pane has to be
  // able to close itself.
  assert.ok(
    pane.includes('kill -0 "$WATCH_PID"'),
    'the pane must exit when the process it was opened for goes away'
  );
  assert.ok(pane.includes('--full'), 'the pane must render all three lines');
});

test('plain terminals get the three lines in reserved bottom rows', () => {
  const wrapper = read(WRAPPER);

  assert.ok(
    /\\033\[1;%dr/.test(wrapper),
    'the wrapper must set DECSTBM scroll margins to reserve the rows'
  );
  assert.ok(wrapper.includes('\\033[r'), 'the margins must be released on exit');
  assert.ok(
    wrapper.includes('\\0337') && wrapper.includes('\\0338'),
    'repaints must save and restore the cursor'
  );
  assert.ok(
    wrapper.includes('stty size'),
    'height must come from the tty, not $LINES'
  );

  const guard = wrapper.slice(wrapper.indexOf('in_plain_terminal() {'));
  assert.ok(
    guard.includes('[ -z "${TMUX:-}" ]') && guard.includes('[ -z "$WEZTERM_BAR_PANE" ]'),
    'the reserved region must yield to tmux and to the WezTerm pane'
  );

  // Codex resets the scroll margins when it starts. The reservation only
  // survives because it is re-asserted on a one second cadence, not once per
  // refresh interval, which left the bar missing for up to 15 seconds.
  const loop = wrapper.slice(wrapper.indexOf('if [ "$REGION_ACTIVE" = 1 ]; then'));
  assert.ok(/\n      sleep 1\n/.test(loop), 'the region must repaint every second');
  assert.ok(
    loop.includes('tick % INTERVAL'),
    'rendering must stay on the slow interval so node is not spawned every second'
  );

  const cleanup = wrapper.slice(wrapper.indexOf('cleanup() {'), wrapper.indexOf('trap cleanup'));
  assert.ok(cleanup.includes('region_off'), 'cleanup must release the reserved rows');
});

test('the bar pane never scrolls itself', () => {
  const pane = read(PANE);

  assert.ok(
    !/printf '%s\\033\[K\\n'/.test(pane),
    'the pane must not end its rows with a newline'
  );
  assert.ok(/\\033\[1;1H/.test(pane), 'the pane must address rows absolutely');
  assert.ok(
    pane.includes('\\033[?1049h'),
    'the pane should use the alternate screen so nothing reaches scrollback'
  );
  assert.ok(pane.includes('stty size'), 'pane height must come from the tty');
});

if (failed > 0) {
  console.log(`\n${failed} failed, ${passed} passed`);
  process.exit(1);
}

console.log(`\n${passed} passed`);
