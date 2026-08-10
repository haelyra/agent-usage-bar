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
3. **Anywhere else** — the wrapper mirrors the bar into the window title, and
   into an OSC 1337 user var that WezTerm and iTerm2 can pin in their status bar.

Plain `codex [args...]` picks all this up through a shell alias; arguments pass
through untouched.

```bash
node ~/.agent-usage-bar/bin/codex-bar.js --full     # print the three lines
watch -c -n 30 "node ~/.agent-usage-bar/bin/codex-bar.js --full"
```

<details>
<summary>WezTerm: pin the bar in the tab bar</summary>

```lua
wezterm.on('update-status', function(window, pane)
  local ok, vars = pcall(function() return pane:get_user_vars() end)
  local bar = ok and vars.usage_bar or nil
  if not bar or #bar == 0 then window:set_right_status('') return end
  window:set_right_status(wezterm.format {
    { Foreground = { Color = '#F59E0B' } },
    { Text = bar .. '  ' },
  })
end)
```

</details>

## Options

| Variable | Effect |
|---|---|
| `USAGE_BAR=off` | Run `codex` with no bar |
| `USAGE_BAR_INTERVAL=15` | Refresh seconds for the Codex bar |
| `USAGE_BAR_GLYPHS=ascii\|unicode` | Force the glyph set |

Block glyphs need a UTF-8 locale — without one, tmux renders them as
underscores. The installer sets one if yours is not UTF-8, and the bar falls
back to an ASCII set (`| 7d ||____ 25%`) if that is not possible.

## How it works

- `bin/claude-statusline.js` — reads Claude Code's statusline JSON on stdin
- `bin/codex-bar.js` — reads the newest `~/.codex/sessions/**/rollout-*.jsonl`
  transcript (by modification time, so resumed sessions stay correct)
- `bin/codex-wrapper` — runs Codex with the bar pinned around it
- `lib/render.js` — colors, glyphs, bars, shared segments

Everything is read-only against files the agents already write. The only things
installed are one `statusLine` entry, one `[tui]` block, and one shell alias.

## License

MIT
