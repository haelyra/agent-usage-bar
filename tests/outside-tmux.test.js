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
const EXAMPLE = 'examples/wezterm-usage-bar.lua';
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

test('wrapper emits OSC sequences outside tmux, not only inside it', () => {
  const wrapper = read(WRAPPER);

  assert.ok(
    wrapper.includes(`printf '%s' "$1" > /dev/tty`),
    'emit() lost its plain (non-tmux) branch'
  );
  assert.ok(wrapper.includes('\\033Ptmux;'), 'emit() lost the tmux passthrough branch');
});

test('title and user var are mirrored regardless of tmux', () => {
  const wrapper = read(WRAPPER);

  assert.ok(wrapper.includes('\\033]2;%s\\007'), 'missing OSC 2 title mirror');
  assert.ok(
    wrapper.includes('SetUserVar=usage_bar=%s'),
    'missing OSC 1337 user var mirror'
  );

  // The mirror must not be reachable only from the tmux setup path.
  const tmuxOn = wrapper.slice(
    wrapper.indexOf('tmux_bar_on() {'),
    wrapper.indexOf('tmux_bar_off() {')
  );
  assert.ok(
    !tmuxOn.includes('update_title'),
    'the terminal mirror must not be gated behind the tmux path'
  );
});

test('the WezTerm example ships and splits the bar safely', () => {
  const example = read(EXAMPLE);

  assert.ok(
    !stripLuaComments(example).includes(`[^${SEP}]`),
    'the example uses a byte-wise character class to split the bar'
  );
  assert.ok(
    example.includes('find(SEP, 1, true)') && example.includes('find(SEP, pos, true)'),
    'the example must split with a plain find so multibyte glyphs survive'
  );
  assert.ok(example.includes('vars.usage_bar'), 'the example must read the user var');
  assert.ok(example.includes('function M.apply'), 'the example must expose apply()');
});

test('no Lua snippet in the README splits the bar with a character class', () => {
  for (const block of luaBlocks(read(README))) {
    assert.ok(
      !stripLuaComments(block).includes(`[^${SEP}]`),
      `a Lua snippet still splits on [^${SEP}], which mangles the block glyphs`
    );
  }
});

test('README documents WezTerm, iTerm2, and that tmux is optional', () => {
  const readme = read(README);

  assert.ok(readme.includes(EXAMPLE), 'README must link the shipped WezTerm example');
  assert.ok(
    readme.includes('require("wezterm-usage-bar").apply()'),
    'README must show how to load the example'
  );
  assert.ok(
    readme.includes('\\(user.usage_bar)'),
    'README must show the iTerm2 interpolated string'
  );
  assert.ok(
    readme.includes('tab_bar_at_bottom'),
    'README must explain how to move the bar to the bottom'
  );
  assert.ok(
    readme.includes('Only step 2 needs tmux'),
    'README must state that tmux is optional'
  );
  assert.ok(
    readme.includes('USAGE_BAR_REGION=off'),
    'README must document the reserved-rows opt-out'
  );
  assert.ok(
    readme.includes('USAGE_BAR_PANE=off'),
    'README must document how to opt out of the WezTerm pane'
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

test('the example ships in the npm package', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.ok(pkg.files.includes('examples/'), 'package.json files must include examples/');
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
