# agent-usage-bar

An always-on usage bar for **Claude Code** and **Codex CLI**: how much quota
you have left, what the session is costing, and what you actually have enabled.

```text
⚡ 5h ███████░ 84% ↻1h54m │ 7d █░░░░░░░ 14% ↻4d │ cache 100%
✳ Opus 5 xhigh │ ctx █░░░░░░░░░ 13% 1M │ $7.85 +49/-49 36m │ Fixing auth bug
⬢ swift-lsp 1.0.0 · my-plugin 0.4.2 │ hooks 6 │ myproject
```

Line 1 is quota, line 2 is the session, line 3 is your setup (enabled plugins
with versions, then chips for anything else worth knowing). Nothing to show on
line 3? It disappears.

> Inspired by [leeguooooo/claude-code-usage-bar](https://github.com/leeguooooo/claude-code-usage-bar)
> (MIT), which pioneered the always-on rate-limit bar for Claude Code only. The
> prompt-cache widget idea comes from [@marcwimmer](https://github.com/marcwimmer).
> This is an independent, dependency-free reimplementation that also covers Codex.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/haelyra/agent-usage-bar/main/install.sh | bash
```

Node.js and git are the only requirements. The installer sets up whichever
agents it finds and **never overwrites config you already wrote** — an
existing Claude `statusLine`, an existing Codex `tui.status_line`, or your own
`codex` alias are all left alone.

```bash
… | bash -s -- --claude-only     # just Claude Code
… | bash -s -- --codex-only      # just Codex
bash ~/.agent-usage-bar/install.sh --uninstall
```

Restart Claude Code (or open a new shell for Codex) to see it.

## Claude Code

Registered as a `statusLine` command, so it is simply always there. Everything
comes from the session snapshot Claude Code pipes in, plus your local plugin
files — no background daemon, no network calls, no dependencies.

| Segment | Meaning |
|---|---|
| `5h` / `7d` | Rate-limit windows with reset countdowns (subscription plans) |
| `cache` | Prompt-cache hit rate for the last request |
| `ctx` | Context used, rescaled so 100% is where auto-compact actually starts |
| `$…  +N/-N` | Session cost and lines changed |
| line 3 | Enabled plugins with versions, `hooks N`, output style, directory |

## Codex CLI

Codex has no custom status-line API ([openai/codex#14043](https://github.com/openai/codex/issues/14043)),
so the bar lives in three places, and the installer sets up all of them:

1. **Under the input** — Codex's own `tui.status_line` widgets (model, context,
   git branch), with colors on. Rate-limit widgets are left out because the bar
   shows those windows properly.
2. **In tmux** — run `codex` and the wrapper pins the full three-line bar in the
   tmux status area for the lifetime of the run, then restores your previous
   status bar on exit. Nothing persists in your `~/.tmux.conf`.
3. **In WezTerm** — run `codex` outside tmux and the wrapper opens a three-line
   pane across the bottom of the window for the lifetime of the run, then closes
   it on exit. Nothing to configure.
4. **Any other terminal** — the wrapper reserves the bottom three rows of the
   window and paints the bar there, right under Codex's composer, releasing them
   on exit. Works in Terminal.app.
5. **Everywhere** — the bar is also mirrored into the window title and into an
   OSC 1337 user var that WezTerm and iTerm2 can pin in their status bar.

Plain `codex [args...]` picks all this up through a shell alias; arguments pass
through untouched.

```bash
node ~/.agent-usage-bar/bin/codex-bar.js --full     # print the three lines
watch -c -n 30 "node ~/.agent-usage-bar/bin/codex-bar.js --full"
```

Only step 2 needs tmux. Every terminal gets the same three lines one way or
another: tmux's status area, a WezTerm pane, or reserved rows at the bottom of
the window.

Reserved rows work because Codex draws inline rather than on the alternate
screen. Setting the DECSTBM scroll margins to rows 1 to H-3 stops Codex
scrolling over the bar, and the margins are re-asserted on each repaint so a
window resize needs no `SIGWINCH` handling. Windows shorter than nine rows are
left alone.

<details>
<summary>WezTerm: pin the bar in the tab bar</summary>

Nothing is required: the wrapper already opens a three-line pane across the
bottom of the window. A pane is necessary because WezTerm's only status area is
the tab bar, which holds one line and cannot be detached from the tab strip.

The pane spans the whole window (`--top-level`, so it does not subdivide the
pane Codex runs in), hands focus straight back, and watches the wrapper's
process so a Codex run killed with `SIGKILL` cannot leave it behind.

Prefer a compact one-liner in the tab bar over spending three rows? Set
`USAGE_BAR_PANE=off`, then copy
[`examples/wezterm-usage-bar.lua`](examples/wezterm-usage-bar.lua) next to your
`wezterm.lua` and require it:

```lua
require("wezterm-usage-bar").apply()
```

It colors each segment and reads the user var on WezTerm's own `update-status`
tick, so nothing polls. Override the palette with
`apply({ colors = { dim = "#...", five_hour = "#...", seven_day = "#...", critical = "#..." } })`.

Set `tab_bar_at_bottom = true` to put the bar along the bottom edge. WezTerm
draws the right status inside the tab bar and cannot separate the two, so the
tab strip moves down with it.

If you inline the logic instead, split the bar with a plain `find`, never a Lua
character class. `[^│]` matches *bytes*, and `│` (`e2 94 82`) shares its leading
`e2` with `⬢`, `█`, `░` and `↻`, so a class-based split cuts those glyphs in
half and emits invalid UTF-8.

</details>

<details>
<summary>iTerm2: pin the bar in the status bar</summary>

Enable the status bar under Settings, Profiles, Session, then Configure Status
Bar, and drag in an **Interpolated String** component with:

```text
\(user.usage_bar)
```

iTerm2 exposes any OSC 1337 user var as `user.<name>`, so the bar appears when
Codex starts and clears when it exits.

</details>

## Options

| Variable | Effect |
|---|---|
| `USAGE_BAR=off` | Run `codex` with no bar |
| `USAGE_BAR_INTERVAL=15` | Refresh seconds for the Codex bar |
| `USAGE_BAR_GLYPHS=ascii\|unicode` | Force the glyph set |
| `USAGE_BAR_PANE=off` | No WezTerm bottom pane, use reserved rows instead |
| `USAGE_BAR_REGION=off` | No reserved bottom rows, title and user var only |

Block glyphs need a UTF-8 locale — without one, tmux renders them as
underscores. The installer sets one if yours is not UTF-8, and the bar falls
back to an ASCII set (`| 7d ||____ 25%`) if that is not possible.

## How it works

- `bin/claude-statusline.js` — reads Claude Code's statusline JSON on stdin
- `bin/codex-bar.js` — reads the newest `~/.codex/sessions/**/rollout-*.jsonl`
  transcript (by modification time, so resumed sessions stay correct)
- `bin/codex-wrapper` — runs Codex with the bar pinned around it
- `bin/codex-bar-pane` draws the three lines in WezTerm's bottom pane
- `lib/render.js` — colors, glyphs, bars, shared segments
- `examples/wezterm-usage-bar.lua` pins the bar in WezTerm's tab bar

Everything is read-only against files the agents already write. The only things
installed are one `statusLine` entry, one `[tui]` block, and one shell alias.

## License

MIT
