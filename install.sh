#!/usr/bin/env bash
# Installs the claude-mods mods for every Claude Code session (terminal and desktop app):
# keeps a clone of this repo and lists each mod in CLAUDE_CODE_PLUGIN_DIRS in ~/.claude/settings.json.
#
#   ./install.sh                  install, or update an existing install
#   ./install.sh --only desktop   run the mods in the Claude desktop app only
#   ./install.sh --only terminal  run the mods in the terminal only
#   ./install.sh --only both      run them in both (the default)
#   ./install.sh --uninstall      remove the mods from settings.json (the clone stays)
#
# Without --only, a person running it is asked; otherwise the last choice is kept.
# Set CLAUDE_MODS_DIR to keep the clone somewhere other than ~/.claude/mods/claude-mods.
# Safe to run again: it never adds a path twice and backs settings.json up first.
set -euo pipefail

REPO_URL="https://github.com/Vansitha/claude-mods.git"
MODS="session-hud message-queue skill-dock"
SETTINGS="$HOME/.claude/settings.json"

mode="install"
show_in=""
while [ $# -gt 0 ]; do
  case "$1" in
    --uninstall) mode="uninstall" ;;
    --only)
      show_in="${2:-}"
      shift
      ;;
    --only=*) show_in="${1#--only=}" ;;
    -h | --help)
      sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "Unknown option: $1 (see --help)" >&2
      exit 2
      ;;
  esac
  shift
done
case "$show_in" in
  "" | both | desktop | terminal) ;;
  *)
    echo "--only takes desktop, terminal or both, not '$show_in'" >&2
    exit 2
    ;;
esac

fail() {
  echo "✗ $*" >&2
  exit 1
}

# Use the clone this script is in; otherwise clone (or update) the default one.
here="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)"
if [ -n "$here" ] && [ -f "$here/session-hud/.claude-plugin/plugin.json" ]; then
  dir="$here"
else
  dir="${CLAUDE_MODS_DIR:-$HOME/.claude/mods/claude-mods}"
fi

if [ "$mode" = "install" ]; then
  if [ "$dir" != "$here" ]; then
    command -v git >/dev/null 2>&1 || fail "git is not installed. Install git, then run this again."
    if [ -d "$dir/.git" ]; then
      echo "Updating $dir"
      git -C "$dir" pull --ff-only --quiet || fail "Could not update $dir. Check 'git -C $dir status'."
    else
      echo "Cloning into $dir"
      mkdir -p "$(dirname "$dir")"
      git clone --quiet "$REPO_URL" "$dir" || fail "Could not clone $REPO_URL."
    fi
  else
    echo "Using this clone: $dir"
    # Bring it up to date too, unless it has local changes or no upstream (a working copy).
    if command -v git >/dev/null 2>&1 && [ -d "$dir/.git" ] &&
      git -C "$dir" rev-parse --abbrev-ref '@{upstream}' >/dev/null 2>&1 &&
      [ -z "$(git -C "$dir" status --porcelain)" ]; then
      git -C "$dir" pull --ff-only --quiet ||
        echo "! Could not update $dir; installing the version that's there."
    fi
  fi
fi

# Ask a person where the mods should run; an agent or script passes --only instead.
if [ "$mode" = "install" ] && [ -z "$show_in" ] && [ -t 0 ] && [ -t 1 ]; then
  echo
  echo "Where should the mods run?"
  echo "  1) The desktop app and the terminal (default)"
  echo "  2) The desktop app only"
  echo "  3) The terminal only"
  printf "Choose 1, 2 or 3 [1]: "
  read -r answer || answer=""
  case "$answer" in
    2) show_in="desktop" ;;
    3) show_in="terminal" ;;
    *) show_in="both" ;;
  esac
fi

paths=""
for mod in $MODS; do
  paths="${paths:+$paths:}$dir/$mod"
done

# Adds the paths to, or removes them from, env.CLAUDE_CODE_PLUGIN_DIRS; everything else is kept.
edit_js='
const fs = require("fs");
const [file, mode, given, showIn, names] = process.argv.slice(1);
let settings = {};
try {
  settings = JSON.parse(fs.readFileSync(file, "utf8"));
} catch (e) {
  if (e.code !== "ENOENT") { console.error(file + " is not valid JSON, so it was left alone."); process.exit(3); }
}
settings.env = settings.env || {};
let list = (settings.env.CLAUDE_CODE_PLUGIN_DIRS || "").split(":").filter(Boolean);
const paths = given.split(":");
list = mode === "install" ? [...list, ...paths.filter(p => !list.includes(p))] : list.filter(p => !paths.includes(p));
if (list.length) settings.env.CLAUDE_CODE_PLUGIN_DIRS = list.join(":");
else delete settings.env.CLAUDE_CODE_PLUGIN_DIRS;
if (!Object.keys(settings.env).length) delete settings.env;
// The "Show in" setting of each mod (userConfig field show_in), the same row /config edits.
for (const name of names.split(" ")) {
  const configs = settings.pluginConfigs || {};
  if (mode === "uninstall") delete configs[name];
  else if (showIn) configs[name] = { ...configs[name], options: { ...(configs[name] || {}).options, show_in: showIn } };
  if (Object.keys(configs).length) settings.pluginConfigs = configs;
  else delete settings.pluginConfigs;
}
fs.writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
'
edit_py='
import json, os, sys
file, mode, given, show_in, names = sys.argv[1:6]
settings = {}
if os.path.exists(file) and os.path.getsize(file):
    try:
        settings = json.load(open(file))
    except ValueError:
        print(file + " is not valid JSON, so it was left alone.", file=sys.stderr)
        sys.exit(3)
env = settings.setdefault("env", {})
items = [p for p in env.get("CLAUDE_CODE_PLUGIN_DIRS", "").split(":") if p]
paths = given.split(":")
items = items + [p for p in paths if p not in items] if mode == "install" else [p for p in items if p not in paths]
if items:
    env["CLAUDE_CODE_PLUGIN_DIRS"] = ":".join(items)
else:
    env.pop("CLAUDE_CODE_PLUGIN_DIRS", None)
if not env:
    settings.pop("env")
# The "Show in" setting of each mod (userConfig field show_in), the same row /config edits.
configs = settings.get("pluginConfigs", {})
for name in names.split():
    if mode == "uninstall":
        configs.pop(name, None)
    elif show_in:
        entry = configs.setdefault(name, {})
        entry.setdefault("options", {})["show_in"] = show_in
if configs:
    settings["pluginConfigs"] = configs
else:
    settings.pop("pluginConfigs", None)
open(file, "w").write(json.dumps(settings, indent=2) + "\n")
'

mkdir -p "$(dirname "$SETTINGS")"
[ -f "$SETTINGS" ] && cp "$SETTINGS" "$SETTINGS.bak"

if command -v node >/dev/null 2>&1; then
  node -e "$edit_js" "$SETTINGS" "$mode" "$paths" "$show_in" "$MODS" || fail "settings.json was not changed."
elif command -v python3 >/dev/null 2>&1; then
  python3 -c "$edit_py" "$SETTINGS" "$mode" "$paths" "$show_in" "$MODS" || fail "settings.json was not changed."
else
  echo "Neither node nor python3 is installed, so settings.json was not changed."
  echo "Add these paths to env.CLAUDE_CODE_PLUGIN_DIRS in $SETTINGS yourself, separated by ':'"
  echo "  $paths"
  exit 1
fi

if [ "$mode" = "uninstall" ]; then
  echo "✓ Removed the mods from $SETTINGS (old copy: $SETTINGS.bak)."
  echo "  Start a new Claude Code session to unload them. To delete the files too: rm -rf $dir"
  exit 0
fi

echo "✓ Added to $SETTINGS (old copy: $SETTINGS.bak):"
for mod in $MODS; do
  echo "    $dir/$mod"
done
case "$show_in" in
  desktop) echo "✓ The mods run in the desktop app only." ;;
  terminal) echo "✓ The mods run in the terminal only." ;;
  both) echo "✓ The mods run in the desktop app and the terminal." ;;
  *) echo "✓ Kept where the mods run as it was (the desktop app and the terminal unless you chose otherwise)." ;;
esac
echo "  Change it any time: run this again with --only, or open /config in Claude Code (\"Show in\")."


# Check each mod the way Claude Code will load it.
if command -v claude >/dev/null 2>&1; then
  failed=0
  for mod in $MODS; do
    if claude plugin validate "$dir/$mod" >/dev/null 2>&1; then
      echo "✓ $mod is valid"
    else
      echo "✗ $mod did not validate: run 'claude plugin validate $dir/$mod' to see why"
      failed=1
    fi
  done
  if [ "$failed" = 1 ]; then
    echo "Some mods did not validate. This Claude Code ($(claude --version 2>/dev/null | head -1)) may be too old: update it and run this again."
    exit 1
  fi
else
  echo "! The claude command isn't on your PATH, so the mods weren't checked. They load the next time Claude Code starts."
fi

echo "Done. Start a new Claude Code session (quit and reopen the desktop app) to load the mods."
