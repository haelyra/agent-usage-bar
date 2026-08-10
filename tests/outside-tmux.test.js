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
});

test('the example ships in the npm package', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.ok(pkg.files.includes('examples/'), 'package.json files must include examples/');
});

if (failed > 0) {
  console.log(`\n${failed} failed, ${passed} passed`);
  process.exit(1);
}

console.log(`\n${passed} passed`);
