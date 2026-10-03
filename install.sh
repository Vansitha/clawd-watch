#!/usr/bin/env bash
# Installs the claude-mods mods for every Claude Code session (terminal and desktop app):
# keeps a clone of this repo and lists each mod in CLAUDE_CODE_PLUGIN_DIRS in ~/.claude/settings.json.
# Run it again to update. Set CLAUDE_MODS_DIR to keep the clone somewhere else.
set -euo pipefail

REPO_URL="https://github.com/Vansitha/claude-mods.git"
MODS="session-hud"
SETTINGS="$HOME/.claude/settings.json"

here="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)"
if [ -n "$here" ] && [ -f "$here/session-hud/.claude-plugin/plugin.json" ]; then
  dir="$here"
  echo "Using this clone: $dir"
else
  dir="${CLAUDE_MODS_DIR:-$HOME/.claude/mods/claude-mods}"
  if [ -d "$dir/.git" ]; then
    echo "Updating $dir"
    git -C "$dir" pull --ff-only --quiet
  else
    echo "Cloning into $dir"
    mkdir -p "$(dirname "$dir")"
    git clone --quiet "$REPO_URL" "$dir"
  fi
fi

paths=""
for mod in $MODS; do
  paths="${paths:+$paths:}$dir/$mod"
done

mkdir -p "$(dirname "$SETTINGS")"
[ -f "$SETTINGS" ] && cp "$SETTINGS" "$SETTINGS.bak"

merge_js='
const fs = require("fs");
const [file, add] = process.argv.slice(1);
let settings = {};
try { settings = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { if (e.code !== "ENOENT") throw e; }
settings.env = settings.env || {};
const list = (settings.env.CLAUDE_CODE_PLUGIN_DIRS || "").split(":").filter(Boolean);
for (const p of add.split(":")) if (!list.includes(p)) list.push(p);
settings.env.CLAUDE_CODE_PLUGIN_DIRS = list.join(":");
fs.writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
'
merge_py='
import json, os, sys
file, add = sys.argv[1], sys.argv[2]
settings = json.load(open(file)) if os.path.exists(file) and os.path.getsize(file) else {}
env = settings.setdefault("env", {})
items = [p for p in env.get("CLAUDE_CODE_PLUGIN_DIRS", "").split(":") if p]
items += [p for p in add.split(":") if p not in items]
env["CLAUDE_CODE_PLUGIN_DIRS"] = ":".join(items)
open(file, "w").write(json.dumps(settings, indent=2) + "\n")
'

if command -v node >/dev/null 2>&1; then
  node -e "$merge_js" "$SETTINGS" "$paths"
elif command -v python3 >/dev/null 2>&1; then
  python3 -c "$merge_py" "$SETTINGS" "$paths"
else
  echo "Neither node nor python3 is installed, so settings.json was not changed."
  echo "Add this to $SETTINGS yourself:"
  echo "  { \"env\": { \"CLAUDE_CODE_PLUGIN_DIRS\": \"$paths\" } }"
  exit 1
fi

echo "Added to $SETTINGS: $paths"
echo "Done. Start a new Claude Code session (quit and reopen the desktop app) to load it."
