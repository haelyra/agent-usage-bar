# agent-usage-bar

<img width="1001" height="299" alt="image" src="https://github.com/user-attachments/assets/c1d9ceec-7903-4324-b2d4-0024162dfe82" />

<img width="1001" height="375" alt="image" src="https://github.com/user-attachments/assets/9a996c2c-218a-4b30-bc15-cd9c39317798" />



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
so the wrapper gives the bar three rows of its own that Codex cannot scroll
over. Which mechanism does that depends on the terminal, and none of them need
tmux:

| Terminal | Where the bar goes |
|---|---|
| tmux | three lines of the session's status area |
| WezTerm | a three-row pane across the bottom of the window |
| Terminal.app and other VT100 terminals | the bottom three rows, reserved with DECSTBM margins |

All three appear when Codex starts and are given back when it exits. Plain
`codex [args...]` picks this up through a shell alias; arguments pass through
untouched.

```text
⚡ 7d ██░░░░░░ 25% ↻4d │ cache 97% │ chat Add usage titles…
```

The `chat` segment stays empty until the current Codex run writes its own
session, so a fresh chat never inherits the previous chat's label. It then
prefers the real Codex chat name set by `/rename`; for an unrenamed chat, it
derives a compact task label from the opening prompt without making a network
request. It is omitted when Codex's read-only local state is unavailable.

```bash
node ~/.agent-usage-bar/bin/codex-bar.js --full     # print the three lines
watch -c -n 30 "node ~/.agent-usage-bar/bin/codex-bar.js --full"
```

Codex's own `tui.status_line` widgets are deliberately left alone. They render
their own line under the composer covering the same model, context and
rate-limit ground, so configuring both stacks two status lines on top of each
other. To use the native widgets instead, set them in `~/.codex/config.toml`
and run with `USAGE_BAR=off`.

<details>
<summary>How each surface works</summary>

**tmux** gets a 4-line status bar for the session (line 0 keeps the normal
window list), restored on exit. The options are session-scoped, so nothing
persists in your `~/.tmux.conf`.

**WezTerm** gets a pane, because WezTerm's only status area is the tab bar: one
line, shared with the tab strip, which can neither hold three lines nor be
detached from the tabs. The pane spans the whole window (`--top-level`), hands
focus straight back, pins itself to three rows if a resize stretches it, and
watches the wrapper's process so a run killed with `SIGKILL` cannot leave it
behind.

**Plain terminals** get the bottom three rows reserved with DECSTBM scroll
margins of 1 to H-3, which stops Codex scrolling over them. This works only
because Codex draws inline rather than on the alternate screen. The margins are
re-asserted per repaint so a resize needs no `SIGWINCH` handling, wrapped in
DECSC/DECRC so Codex never sees its cursor move. Windows shorter than nine rows
are left alone.

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
  transcript (by modification time, so resumed sessions stay correct) and the
  matching name/title from Codex's read-only local thread state
- `bin/codex-wrapper` — runs Codex with the bar pinned around it
- `bin/codex-bar-pane` draws the three lines in WezTerm's bottom pane
- `lib/render.js` — colors, glyphs, bars, shared segments

Everything is read-only against files the agents already write. The only things
installed are one `statusLine` entry, one `[tui]` block, and one shell alias.

## License

MIT
