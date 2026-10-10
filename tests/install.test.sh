#!/usr/bin/env bash
# Runs install.sh against a set of settings.json files with each settings editor (node and
# python3) and checks both give the same, expected result. Usage: bash tests/install.test.sh
set -uo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# A copy of the repo that isn't a git clone, so install.sh never tries to pull.
clone="$work/overwatch"
mkdir -p "$clone"
cp "$repo/install.sh" "$clone/"
for mod in session-hud message-queue skill-dock; do
  mkdir -p "$clone/$mod/.claude-plugin"
  cp "$repo/$mod/.claude-plugin/plugin.json" "$clone/$mod/.claude-plugin/"
done

# Only node, python3 and the basics on PATH: without claude, the validation step is skipped.
bin="$work/bin"
mkdir -p "$bin"
for tool in node python3 git; do
  ln -s "$(command -v "$tool")" "$bin/$tool"
done

failures=0
check() {
  if [ "$2" = "$3" ]; then
    echo "  ok    $1"
  else
    echo "  FAIL  $1"
    echo "        expected: $3"
    echo "        got:      $2"
    failures=$((failures + 1))
  fi
}

canonical() {
  python3 -c 'import json,sys; print(json.dumps(json.load(open(sys.argv[1])), sort_keys=True))' "$1" 2>/dev/null ||
    cat "$1"
}

# run <editor> <home> <args...>: prints the exit code.
run() {
  local editor="$1" home="$2"
  shift 2
  HOME="$home" PATH="$bin:/usr/bin:/bin" OVERWATCH_EDITOR="$editor" bash "$clone/install.sh" "$@" \
    </dev/null >/dev/null 2>&1
  echo $?
}

# case <name> <settings or MISSING> <expected exit> <args...>
case_() {
  local name="$1" fixture="$2" expected_exit="$3"
  shift 3
  echo "$name"
  local results=()
  for editor in node python3; do
    local home="$work/$editor-$RANDOM"
    mkdir -p "$home/.claude"
    [ "$fixture" = MISSING ] || printf '%s' "$fixture" >"$home/.claude/settings.json"
    check "$editor exits $expected_exit" "$(run "$editor" "$home" "$@")" "$expected_exit"
    results+=("$(canonical "$home/.claude/settings.json")")
  done
  check "node and python3 agree" "${results[0]}" "${results[1]}"
  last="${results[0]}"
}

dirs_of() {
  python3 -c 'import json,sys; print(json.loads(sys.argv[1]).get("env",{}).get("CLAUDE_CODE_PLUGIN_DIRS",""))' "$1"
}
show_in_of() {
  python3 -c 'import json,sys; c=json.loads(sys.argv[1]).get("pluginConfigs",{}); print(" ".join(c.get(m,{}).get("options",{}).get("show_in","-") for m in ["session-hud","message-queue","skill-dock"]))' "$1"
}

ours="$clone/session-hud:$clone/message-queue:$clone/skill-dock"

case_ "no settings.json yet" MISSING 0 --only both
check "adds the three mods" "$(dirs_of "$last")" "$ours"
check "sets Show in" "$(show_in_of "$last")" "both both both"

case_ "an empty settings.json" "" 0 --only desktop
check "adds the three mods" "$(dirs_of "$last")" "$ours"

case_ "old copies and other settings" \
  '{"model":"opus","env":{"FOO":"1","CLAUDE_CODE_PLUGIN_DIRS":"/a/mod:/old/session-hud/:/code/overwatch/skill-dock:/x/skill-dockyard"},"pluginConfigs":{"other":{"options":{"x":1}},"skill-dock":{"options":{"keep":true}}}}' \
  0 --only terminal
check "replaces old copies, keeps the rest" "$(dirs_of "$last")" "/a/mod:/x/skill-dockyard:$ours"
check "sets Show in, keeping other options" "$(python3 -c 'import json,sys; print(json.dumps(json.loads(sys.argv[1])["pluginConfigs"]["skill-dock"], sort_keys=True))' "$last")" '{"options": {"keep": true, "show_in": "terminal"}}'

case_ "null env and plugin entries" '{"env":null,"pluginConfigs":{"skill-dock":null}}' 0 --only both
check "installs anyway" "$(show_in_of "$last")" "both both both"

case_ "a JSON array" '[]' 1 --only both
check "left alone" "$last" "[]"

case_ "broken JSON" '{ nope' 1 --only both
check "left alone" "$last" "{ nope"

case_ "running again without --only" \
  "{\"env\":{\"CLAUDE_CODE_PLUGIN_DIRS\":\"$ours\"},\"pluginConfigs\":{\"session-hud\":{\"options\":{\"show_in\":\"desktop\"}}}}" \
  0
check "adds nothing twice" "$(dirs_of "$last")" "$ours"
check "keeps the earlier choice" "$(show_in_of "$last")" "desktop - -"

case_ "uninstall" \
  "{\"env\":{\"CLAUDE_CODE_PLUGIN_DIRS\":\"/a/mod:$ours:/other/clone/message-queue\"},\"pluginConfigs\":{\"session-hud\":{\"options\":{\"show_in\":\"desktop\"}},\"other\":{}}}" \
  0 --uninstall
check "removes every copy, keeps the rest" "$last" '{"env": {"CLAUDE_CODE_PLUGIN_DIRS": "/a/mod"}, "pluginConfigs": {"other": {}}}'

echo "--only with no value"
check "exits 2" "$(run node "$work/none" --only)" "2"

echo
if [ "$failures" = 0 ]; then
  echo "All install checks passed."
else
  echo "$failures install check(s) failed."
  exit 1
fi
