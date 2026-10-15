# Installing Clawd Watch

These steps are written so an AI coding agent such as Claude Code can install Clawd Watch for someone, start to finish. People can follow them too.

**To install with Claude**, paste this into Claude Code:

```
Install Clawd Watch for me: clone https://github.com/Vansitha/clawd-watch into ~/.claude/mods/clawd-watch and follow the INSTALL.md inside it.
```

## Rules for the agent

- **Settings files:** never replace `~/.claude/settings.json` or `~/.claude/keybindings.json` wholesale. Read them first and change only what these steps name. Keep every other key.
- **Errors:** if a step fails, stop and show the person the exact output. Don't work around it by hand-editing files the installer refused to touch, such as a `settings.json` that isn't valid JSON.
- **Permissions:** don't use `sudo`. Everything lives in the person's home folder.
- **Before installing:** ask where Clawd Watch should run: the desktop app and the terminal, the desktop app only, or the terminal only. Pass the answer to the installer as `--only both`, `--only desktop` or `--only terminal`.
- **Optional step:** ask before step 5 (the Cmd+Enter key). It adds a key binding.
- **Reporting:** when you're done, say what was installed, where, and what the person needs to do next (step 4).

## 1. Check what's there

Run each command and note the result:

```sh
uname -s            # Darwin or Linux: use step 3a. Anything else (Windows): use step 3b.
git --version       # needed to clone and update
claude --version    # Clawd Watch was built against Claude Code 2.1.288
node --version || python3 --version   # the installer needs one of them (macOS and Linux only)
```

If `git` is missing, ask the person to install it and stop.

`claude` may not be on the PATH, for example when someone only uses the desktop app. That's fine: Clawd Watch still loads. Step 4 explains how to check it later.

## 2. Get the code

If `~/.claude/mods/clawd-watch` already exists, update it:

```sh
git -C ~/.claude/mods/clawd-watch pull --ff-only
```

Otherwise clone it:

```sh
git clone https://github.com/Vansitha/clawd-watch.git ~/.claude/mods/clawd-watch
```

On Windows the folder is `%USERPROFILE%\.claude\mods\clawd-watch`.

## 3a. Install on macOS or Linux

Use the person's answer from the rules above:

```sh
~/.claude/mods/clawd-watch/install.sh --only both       # or: --only desktop, --only terminal
```

Always pass `--only` when you run it. Without it, the installer asks the question itself, but only when someone is typing at a terminal.

The installer:

1. Adds the clone (which is the plugin) to `env.CLAUDE_CODE_PLUGIN_DIRS` in `~/.claude/settings.json`, replacing any older copy and the three mods Clawd Watch used to be (session-hud, message-queue, skill-dock). It keeps every other setting and never adds a path twice.
2. Saves the previous file as `~/.claude/settings.json.bak`.
3. Sets Clawd Watch's **Show in** setting (`pluginConfigs.clawd-watch.options.show_in` in `settings.json`) to the `--only` choice, and removes the old mods' entries.
4. Checks the plugin with `claude plugin validate`, if `claude` is on the PATH.

Run from inside the clone, it also pulls the latest version first, unless the clone has local changes.

A successful run ends like this:

```
✓ Clawd Watch is valid
Done. Start a new Claude Code session (quit and reopen the desktop app) to load Clawd Watch.
```

If it exits with an error, show the person the output. The usual causes:

| Output | What to do |
| --- | --- |
| `settings.json is not valid JSON, so it was left alone` | Ask the person to fix or move that file, then run the installer again. |
| `✗ Clawd Watch did not validate` | Their Claude Code is likely older than Clawd Watch. Ask them to update it, then run the installer again. |
| `Neither node nor python3 is installed` | Do step 3b by hand, separating paths with `:` instead of `;`. |

## 3b. Install on Windows

`install.sh` doesn't run on Windows. Do the same thing by hand:

1. Read `%USERPROFILE%\.claude\settings.json`. If it doesn't exist, start from `{}`. Save a copy as `settings.json.bak` first.
2. Set `env.CLAUDE_CODE_PLUGIN_DIRS` to include this absolute path; paths in that variable are separated by `;` (Windows' path-list separator):

   ```
   %USERPROFILE%\.claude\mods\clawd-watch
   ```

   Write the real expanded path (`C:\Users\<name>\...`), not `%USERPROFILE%`. If the variable already has paths, keep them and add this after a `;`, but drop any path ending in `session-hud`, `message-queue` or `skill-dock`: those are the old mods Clawd Watch replaces. Keep every other key in the file.
3. If the person chose the desktop app only or the terminal only, set Clawd Watch's **Show in** setting, merging it into any `pluginConfigs` already there, and remove `session-hud`, `message-queue` and `skill-dock` from `pluginConfigs` if they're present:

   ```json
   "pluginConfigs": {
     "clawd-watch": { "options": { "show_in": "desktop" } }
   }
   ```

   Use `"terminal"` for the terminal only. Leave it out for both.
4. If `claude` is on the PATH, check the plugin: `claude plugin validate <path>`.

## 4. Load and check

Clawd Watch loads when Claude Code starts, so the person needs to:

- **Desktop app:** quit it completely and reopen it, then start a new session in the Code tab.
- **Terminal:** start a new `claude` session.

To check it worked, type `/` in the prompt. `/watch`, `/dock`, `/queue` and `/handoff` should be in the list.

In the desktop app the Clawd Watch panel opens in the sidebar; `/watch` opens or closes it. In the terminal its sections show above the prompt once there's something to show: subagents running, a queued message, a handoff ready, or a pinned or used skill.

## 5. Optional: queue with Cmd+Enter

Ask first. This makes Cmd+Enter queue a message. Shift+Enter keeps starting a new line.

If they want it, read `~/.claude/keybindings.json`. If it doesn't exist, create it with:

```json
{
  "$schema": "https://www.schemastore.org/claude-code-keybindings.json",
  "$docs": "https://code.claude.com/docs/en/keybindings",
  "bindings": [
    { "context": "Chat", "bindings": { "cmd+enter": "chat:queueSubmit" } }
  ]
}
```

If it exists, add `"cmd+enter": "chat:queueSubmit"` to the `Chat` context's `bindings`, adding that context if it's missing. Keep everything else.

If the person added `"shift+enter"` or `"shift+cmd+enter"` for `chat:queueSubmit` with an earlier version of these steps, remove it. Shift+Enter should start a new line.

The terminal only sees Cmd if it reports it (kitty and Ghostty do; Terminal.app and many others don't). Where it doesn't, `ctrl+x enter` (the default) and `/queue <message>` do the same job.

## Changing where it runs

Run `~/.claude/mods/clawd-watch/install.sh --only desktop` (or `terminal`, `both`), then start a new session. People can also change **Show in** under `/config` in Claude Code.

## Coming from the separate mods, claude-mods or Overwatch

Clawd Watch used to be three separate mods (session-hud, message-queue, skill-dock), and was called claude-mods, then Overwatch. Install it as above: the installer replaces the old paths in `settings.json` and keeps the person's **Show in** choice, and on its first start Clawd Watch takes over what the old mods saved (pinned skills, skill history, hidden skills, subagent timings). If `~/.claude/mods/claude-mods` or `~/.claude/mods/overwatch` exists, it can go: `rm -rf ~/.claude/mods/claude-mods ~/.claude/mods/overwatch`.

## Updating

Run `~/.claude/mods/clawd-watch/install.sh` again. It keeps the person's choice of where Clawd Watch runs. It pulls the latest version first, unless the clone has local changes. Then start a new session.

## Uninstalling

```sh
~/.claude/mods/clawd-watch/install.sh --uninstall   # removes Clawd Watch and its settings from settings.json
rm -rf ~/.claude/mods/clawd-watch                   # optional: deletes the files
```

On Windows, remove the path from `env.CLAUDE_CODE_PLUGIN_DIRS` and the `clawd-watch` entry from `pluginConfigs` by hand, then delete the folder.

If the person added the Cmd+Enter key, remove `"cmd+enter": "chat:queueSubmit"` from `~/.claude/keybindings.json` too.
