#!/usr/bin/env bash
# agent-usage-bar installer.
#
#   curl -fsSL https://raw.githubusercontent.com/haelyra/agent-usage-bar/main/install.sh | bash
#
# Installs the bar for whichever agents you have, and never overwrites config
# you already wrote: an existing Claude statusLine, an existing Codex
# or your own `codex` alias are all left alone. Codex's tui.status_line is
# never touched in either direction.
#
# Flags: --claude-only  --codex-only  --uninstall  --dir <path>

set -euo pipefail

REPO_URL="${AGENT_USAGE_BAR_REPO:-https://github.com/haelyra/agent-usage-bar.git}"
INSTALL_DIR="${AGENT_USAGE_BAR_DIR:-$HOME/.agent-usage-bar}"
BEGIN_MARKER="# >>> agent-usage-bar >>>"
END_MARKER="# <<< agent-usage-bar <<<"
DO_CLAUDE=1
DO_CODEX=1
UNINSTALL=0

while [ $# -gt 0 ]; do
  case "$1" in
    --claude-only) DO_CODEX=0 ;;
    --codex-only) DO_CLAUDE=0 ;;
    --uninstall) UNINSTALL=1 ;;
    --dir) INSTALL_DIR="$2"; shift ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

say() { printf '  %s\n' "$1"; }
CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
CODEX_DIR="${CODEX_HOME:-$HOME/.codex}"

strip_block() {
  # Delete our managed block from a shell rc, leaving everything else intact.
  local file="$1"
  [ -f "$file" ] || return 0
  node -e '
    const fs = require("fs");
    const [file, begin, end] = process.argv.slice(1);
    let text = fs.readFileSync(file, "utf8");
    const start = text.indexOf(begin);
    const stop = text.indexOf(end);
    if (start === -1 || stop === -1) process.exit(0);
    let tail = text.slice(stop + end.length);
    if (tail.startsWith("\n")) tail = tail.slice(1);
    let head = text.slice(0, start);
    if (head.endsWith("\n\n")) head = head.slice(0, -1);
    fs.writeFileSync(file, head + tail);
  ' "$file" "$BEGIN_MARKER" "$END_MARKER"
}

if [ "$UNINSTALL" = "1" ]; then
  echo "Removing agent-usage-bar..."
  for rc in "$HOME/.zshrc" "$HOME/.bashrc"; do
    strip_block "$rc" && say "cleaned $rc"
  done
  if [ -f "$CLAUDE_DIR/settings.json" ]; then
    node -e '
      const fs = require("fs");
      const file = process.argv[1];
      const settings = JSON.parse(fs.readFileSync(file, "utf8"));
      const command = settings.statusLine && settings.statusLine.command;
      if (command && command.includes("claude-statusline.js")) {
        delete settings.statusLine;
        fs.writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
        console.log("  removed Claude statusLine");
      }
    ' "$CLAUDE_DIR/settings.json"
  fi
  rm -rf "$INSTALL_DIR"
  say "removed $INSTALL_DIR"
  echo "Done. Codex tui.status_line is untouched; edit ~/.codex/config.toml to set it."
  exit 0
fi

command -v node >/dev/null 2>&1 || { echo "Node.js is required (https://nodejs.org)." >&2; exit 1; }
command -v git >/dev/null 2>&1 || { echo "git is required." >&2; exit 1; }

echo "Installing agent-usage-bar to $INSTALL_DIR"
if [ -d "$INSTALL_DIR/.git" ]; then
  git -C "$INSTALL_DIR" pull --quiet --ff-only && say "updated"
else
  rm -rf "$INSTALL_DIR"
  git clone --quiet --depth 1 "$REPO_URL" "$INSTALL_DIR" && say "cloned"
fi
chmod +x "$INSTALL_DIR/bin/codex-wrapper" "$INSTALL_DIR/bin/codex-bar-pane" "$INSTALL_DIR"/bin/*.js 2>/dev/null || true

# --- Claude Code -----------------------------------------------------------
if [ "$DO_CLAUDE" = "1" ] && [ -d "$CLAUDE_DIR" ]; then
  node -e '
    const fs = require("fs");
    const path = require("path");
    const [dir, installDir] = process.argv.slice(1);
    const file = path.join(dir, "settings.json");
    let settings = {};
    try { settings = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
    if (settings.statusLine) {
      console.log("  Claude: kept your existing statusLine");
    } else {
      settings.statusLine = {
        type: "command",
        command: `node "${path.join(installDir, "bin", "claude-statusline.js")}"`,
      };
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
      console.log("  Claude: statusLine configured (restart Claude Code to see it)");
    }
  ' "$CLAUDE_DIR" "$INSTALL_DIR"
elif [ "$DO_CLAUDE" = "1" ]; then
  say "Claude: ~/.claude not found, skipped"
fi

# --- Codex -----------------------------------------------------------------
if [ "$DO_CODEX" = "1" ] && command -v codex >/dev/null 2>&1; then
  # Codex's own tui.status_line is deliberately not configured. It renders a
  # line directly under the composer covering the same model, context and
  # rate-limit ground as the bar, so setting both stacks two status lines.

  # Shell alias so plain `codex` picks up the wrapper. Args pass through, and
  # aliases do not expand inside scripts, so the wrapper's own `codex` is safe.
  UTF8_LOCALE="$(locale -a 2>/dev/null | grep -iE 'utf-?8$' \
    | grep -iE '^(C\.utf-?8|en_US\.utf-?8)$' | head -1)"
  [ -z "$UTF8_LOCALE" ] && UTF8_LOCALE="$(locale -a 2>/dev/null | grep -iE 'utf-?8$' | head -1)"

  case "${SHELL:-}" in
    */bash) RC="$HOME/.bashrc" ;;
    *) RC="$HOME/.zshrc" ;;
  esac

  if grep -qE '^[[:space:]]*(alias[[:space:]]+codex[[:space:]=]|(function[[:space:]]+)?codex[[:space:]]*\(\))' \
      "$RC" 2>/dev/null && ! grep -q "$BEGIN_MARKER" "$RC" 2>/dev/null; then
    say "Codex: you already alias codex, left alone (point it at $INSTALL_DIR/bin/codex-wrapper to combine)"
  else
    strip_block "$RC"
    {
      echo ""
      echo "$BEGIN_MARKER"
      echo "# Plain \`codex\` runs through the usage bar wrapper."
      echo "# Opt out: export USAGE_BAR=off   Remove: bash $INSTALL_DIR/install.sh --uninstall"
      if [ -n "$UTF8_LOCALE" ]; then
        echo "# Block glyphs need a UTF-8 locale."
        echo 'case "${LC_ALL:-${LC_CTYPE:-${LANG:-}}}" in'
        echo '  *[Uu][Tt][Ff]*) ;;'
        echo "  *) export LANG=\"$UTF8_LOCALE\" ;;"
        echo 'esac'
      fi
      echo "if [ -f \"$INSTALL_DIR/bin/codex-wrapper\" ]; then"
      echo "  alias codex='bash \"$INSTALL_DIR/bin/codex-wrapper\"'"
      echo "fi"
      echo "$END_MARKER"
    } >> "$RC"
    say "Codex: alias added to $RC (open a new shell)"
  fi
elif [ "$DO_CODEX" = "1" ]; then
  say "Codex: codex not on PATH, skipped"
fi

echo ""
echo "Done. Preview the Codex bar with:"
echo "  node \"$INSTALL_DIR/bin/codex-bar.js\" --full"
