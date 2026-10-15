#!/usr/bin/env bash
# Installs Clawd Watch for every Claude Code session (terminal and desktop app): keeps a clone
# of this repo, which is the plugin, and lists it in CLAUDE_CODE_PLUGIN_DIRS in ~/.claude/settings.json.
#
#   ./install.sh                  install, or update an existing install
#   ./install.sh --only desktop   run Clawd Watch in the Claude desktop app only
#   ./install.sh --only terminal  run it in the terminal only
#   ./install.sh --only both      run it in both (the default)
#   ./install.sh --uninstall      remove it from settings.json (the clone stays)
#
# Without --only, a person running it is asked; otherwise the last choice is kept.
# Set CLAWD_WATCH_DIR to keep the clone somewhere other than ~/.claude/mods/clawd-watch.
# Safe to run again: it never adds a path twice and backs settings.json up first.
set -euo pipefail

REPO_URL="https://github.com/Vansitha/clawd-watch.git"
PLUGIN="clawd-watch"
# The mods Clawd Watch was split into before: an install replaces them.
OLD_MODS="session-hud message-queue skill-dock"
SETTINGS="$HOME/.claude/settings.json"
ONLY_USAGE="--only takes desktop, terminal or both"

fail() {
  echo "✗ $*" >&2
  exit 1
}

usage_error() {
  echo "$*" >&2
  exit 2
}

mode="install"
show_in=""
while [ $# -gt 0 ]; do
  case "$1" in
    --uninstall) mode="uninstall" ;;
    --only)
      [ $# -ge 2 ] || usage_error "$ONLY_USAGE"
      show_in="$2"
      shift
      ;;
    --only=*) show_in="${1#--only=}" ;;
    -h | --help)
      # The header comment, from line 2 to the first line that isn't one.
      sed -n '2,/^[^#]/{/^#/s/^# \{0,1\}//p;}' "$0"
      exit 0
      ;;
    *) usage_error "Unknown option: $1 (see --help)" ;;
  esac
  shift
done
case "$show_in" in
  "" | both | desktop | terminal) ;;
  *) usage_error "$ONLY_USAGE, not '$show_in'" ;;
esac

# Use the clone this script is in; otherwise clone (or update) the default one.
here="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)"
if [ -n "$here" ] && grep -qs "\"name\": \"$PLUGIN\"" "$here/.claude-plugin/plugin.json"; then
  dir="$here"
else
  dir="${CLAWD_WATCH_DIR:-$HOME/.claude/mods/clawd-watch}"
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

# Ask a person where Clawd Watch should run; an agent or script passes --only instead.
if [ "$mode" = "install" ] && [ -z "$show_in" ] && [ -t 0 ] && [ -t 1 ]; then
  echo
  echo "Where should Clawd Watch run?"
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

# The settings.json edit, written twice because either node or python3 may be all there is.
# Both take: <file> <install|uninstall> <clone dir> <show_in or ""> <plugin> <old mods, space-separated>.
# - Any copy of Clawd Watch or of the old mods in env.CLAUDE_CODE_PLUGIN_DIRS (this clone, another
#   one, an install from before a rename) is removed; install then adds this clone, so it loads once.
# - Install sets pluginConfigs.<plugin>.options.show_in, the row /config edits: to the show_in given,
#   or else to what an old mod had, if Clawd Watch has none yet. The old mods' entries go.
# - Uninstall removes the plugin's and the old mods' pluginConfigs entries.
# - Everything else in the file is kept. A file that isn't a JSON object is left alone (exit 3).
EDIT_JS=$(
  cat <<'JS'
const fs = require("fs");
const [file, mode, dir, showIn, plugin, oldList] = process.argv.slice(1);
const old = oldList.split(" ");
const names = [plugin, ...old];
const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
const refuse = why => { console.error(`${file} ${why}, so it was left alone.`); process.exit(3); };

let text = "";
try {
  text = fs.readFileSync(file, "utf8");
} catch (e) {
  if (e.code !== "ENOENT") refuse(`could not be read (${e.code})`);
}
let settings = {};
if (text.trim()) {
  try { settings = JSON.parse(text); } catch { refuse("is not valid JSON"); }
  if (!isObject(settings)) refuse("is not a JSON object");
}

const env = isObject(settings.env) ? settings.env : {};
const trim = path => path.replace(/\/+$/, "");
const isCopy = path => trim(path) === trim(dir) || names.includes(trim(path).split("/").pop());
const dirs = (env.CLAUDE_CODE_PLUGIN_DIRS || "").split(":").filter(p => p && !isCopy(p));
if (mode === "install") dirs.push(dir);
if (dirs.length) env.CLAUDE_CODE_PLUGIN_DIRS = dirs.join(":");
else delete env.CLAUDE_CODE_PLUGIN_DIRS;
if (Object.keys(env).length) settings.env = env;
else delete settings.env;

const configs = isObject(settings.pluginConfigs) ? settings.pluginConfigs : {};
const optionsOf = name =>
  isObject(configs[name]) && isObject(configs[name].options) ? configs[name].options : {};
if (mode === "install") {
  const carried = old.map(name => optionsOf(name).show_in).find(value => typeof value === "string");
  const chosen = showIn || optionsOf(plugin).show_in || carried;
  const entry = isObject(configs[plugin]) ? configs[plugin] : {};
  if (chosen) configs[plugin] = { ...entry, options: { ...optionsOf(plugin), show_in: chosen } };
} else {
  delete configs[plugin];
}
for (const name of old) delete configs[name];
if (Object.keys(configs).length) settings.pluginConfigs = configs;
else delete settings.pluginConfigs;

fs.writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
JS
)
EDIT_PY=$(
  cat <<'PY'
import json, sys
file, mode, dir, show_in, plugin, old_list = sys.argv[1:7]
old = old_list.split()
names = [plugin, *old]

def refuse(why):
    print(f"{file} {why}, so it was left alone.", file=sys.stderr)
    sys.exit(3)

text = ""
try:
    with open(file) as f:
        text = f.read()
except FileNotFoundError:
    pass
except OSError as e:
    refuse(f"could not be read ({e.strerror})")
settings = {}
if text.strip():
    try:
        settings = json.loads(text)
    except ValueError:
        refuse("is not valid JSON")
    if not isinstance(settings, dict):
        refuse("is not a JSON object")

env = settings.get("env") if isinstance(settings.get("env"), dict) else {}
is_copy = lambda path: path.rstrip("/") == dir.rstrip("/") or path.rstrip("/").split("/")[-1] in names
dirs = [p for p in (env.get("CLAUDE_CODE_PLUGIN_DIRS") or "").split(":") if p and not is_copy(p)]
if mode == "install":
    dirs.append(dir)
if dirs:
    env["CLAUDE_CODE_PLUGIN_DIRS"] = ":".join(dirs)
else:
    env.pop("CLAUDE_CODE_PLUGIN_DIRS", None)
if env:
    settings["env"] = env
else:
    settings.pop("env", None)

configs = settings.get("pluginConfigs") if isinstance(settings.get("pluginConfigs"), dict) else {}
def options_of(name):
    entry = configs.get(name)
    return entry["options"] if isinstance(entry, dict) and isinstance(entry.get("options"), dict) else {}
if mode == "install":
    carried = next((options_of(n)["show_in"] for n in old if isinstance(options_of(n).get("show_in"), str)), None)
    chosen = show_in or options_of(plugin).get("show_in") or carried
    entry = configs.get(plugin) if isinstance(configs.get(plugin), dict) else {}
    if chosen:
        configs[plugin] = {**entry, "options": {**options_of(plugin), "show_in": chosen}}
else:
    configs.pop(plugin, None)
for name in old:
    configs.pop(name, None)
if configs:
    settings["pluginConfigs"] = configs
else:
    settings.pop("pluginConfigs", None)

with open(file, "w") as f:
    f.write(json.dumps(settings, indent=2, ensure_ascii=False) + "\n")
PY
)

# CLAWD_WATCH_EDITOR picks one (node or python3); the tests use it to check both agree.
editor="${CLAWD_WATCH_EDITOR:-}"
if [ -z "$editor" ]; then
  if command -v node >/dev/null 2>&1; then
    editor="node"
  elif command -v python3 >/dev/null 2>&1; then
    editor="python3"
  fi
fi

mkdir -p "$(dirname "$SETTINGS")"
# settings.json can hold secrets (API keys in env): the backup keeps its permissions, and an
# older backup is replaced rather than overwritten in place, which would keep the old file's.
if [ -f "$SETTINGS" ]; then
  rm -f "$SETTINGS.bak"
  cp -p "$SETTINGS" "$SETTINGS.bak"
fi

case "$editor" in
  node) node -e "$EDIT_JS" "$SETTINGS" "$mode" "$dir" "$show_in" "$PLUGIN" "$OLD_MODS" ;;
  python3) python3 -c "$EDIT_PY" "$SETTINGS" "$mode" "$dir" "$show_in" "$PLUGIN" "$OLD_MODS" ;;
  *)
    echo "Neither node nor python3 is installed, so settings.json was not changed."
    echo "Add this path to env.CLAUDE_CODE_PLUGIN_DIRS in $SETTINGS yourself, separated by ':'"
    echo "  $dir"
    exit 1
    ;;
esac || fail "settings.json was not changed."

if [ "$mode" = "uninstall" ]; then
  echo "✓ Removed Clawd Watch from $SETTINGS (old copy: $SETTINGS.bak)."
  echo "  Start a new Claude Code session to unload it. To delete the files too: rm -rf $dir"
  exit 0
fi

echo "✓ Added to $SETTINGS (old copy: $SETTINGS.bak):"
echo "    $dir"
case "$show_in" in
  desktop) echo "✓ Clawd Watch runs in the desktop app only." ;;
  terminal) echo "✓ Clawd Watch runs in the terminal only." ;;
  both) echo "✓ Clawd Watch runs in the desktop app and the terminal." ;;
  *) echo "✓ Kept where Clawd Watch runs as it was (the desktop app and the terminal unless you chose otherwise)." ;;
esac
echo "  Change it any time: run this again with --only, or open /config in Claude Code (\"Show in\")."

# Check the plugin the way Claude Code will load it.
if command -v claude >/dev/null 2>&1; then
  if claude plugin validate "$dir" >/dev/null 2>&1; then
    echo "✓ Clawd Watch is valid"
  else
    echo "✗ Clawd Watch did not validate: run 'claude plugin validate $dir' to see why"
    echo "  This Claude Code ($(claude --version 2>/dev/null | head -1)) may be too old: update it and run this again."
    exit 1
  fi
else
  echo "! The claude command isn't on your PATH, so Clawd Watch wasn't checked. It loads the next time Claude Code starts."
fi

echo "Done. Start a new Claude Code session (quit and reopen the desktop app) to load Clawd Watch."
