# Installing claude-mods

These steps are written so an AI coding agent such as Claude Code can install claude-mods for someone, start to finish. People can follow them too.

**To install with Claude**, paste this into Claude Code:

```
Install claude-mods for me: clone https://github.com/Vansitha/claude-mods into ~/.claude/mods/claude-mods and follow the INSTALL.md inside it.
```

## Rules for the agent

- **Settings files:** never replace `~/.claude/settings.json` or `~/.claude/keybindings.json` wholesale. Read them first and change only what these steps name. Keep every other key.
- **Errors:** if a step fails, stop and show the person the exact output. Don't work around it by hand-editing files the installer refused to touch, such as a `settings.json` that isn't valid JSON.
- **Permissions:** don't use `sudo`. Everything lives in the person's home folder.
- **Before installing:** ask where the mods should run: the desktop app and the terminal, the desktop app only, or the terminal only. Pass the answer to the installer as `--only both`, `--only desktop` or `--only terminal`.
- **Optional step:** ask before step 5 (the Shift+Enter key). It changes what a key does.
- **Reporting:** when you're done, say what was installed, where, and what the person needs to do next (step 4).

## 1. Check what's there

Run each command and note the result:

```sh
uname -s            # Darwin or Linux: use step 3a. Anything else (Windows): use step 3b.
git --version       # needed to clone and update
claude --version    # these mods were built against Claude Code 2.1.288
node --version || python3 --version   # the installer needs one of them (macOS and Linux only)
```

If `git` is missing, ask the person to install it and stop.

`claude` may not be on the PATH, for example when someone only uses the desktop app. That's fine: the mods still load. Step 4 explains how to check them later.

## 2. Get the code

If `~/.claude/mods/claude-mods` already exists, update it:

```sh
git -C ~/.claude/mods/claude-mods pull --ff-only
```

Otherwise clone it:

```sh
git clone https://github.com/Vansitha/claude-mods.git ~/.claude/mods/claude-mods
```

On Windows the folder is `%USERPROFILE%\.claude\mods\claude-mods`.

## 3a. Install on macOS or Linux

Use the person's answer from the rules above:

```sh
~/.claude/mods/claude-mods/install.sh --only both       # or: --only desktop, --only terminal
```

Always pass `--only` when you run it. Without it, the installer asks the question itself, but only when someone is typing at a terminal.

The installer:

1. Adds the three mod folders to `env.CLAUDE_CODE_PLUGIN_DIRS` in `~/.claude/settings.json`. It keeps every other setting and never adds a path twice.
2. Saves the previous file as `~/.claude/settings.json.bak`.
3. Sets each mod's **Show in** setting (`pluginConfigs.<mod>.options.show_in` in `settings.json`) to the `--only` choice.
4. Checks each mod with `claude plugin validate`, if `claude` is on the PATH.

Run from inside the clone, it also pulls the latest version first, unless the clone has local changes.

A successful run ends like this:

```
✓ session-hud is valid
✓ message-queue is valid
✓ skill-dock is valid
Done. Start a new Claude Code session (quit and reopen the desktop app) to load the mods.
```

If it exits with an error, show the person the output. The usual causes:

| Output | What to do |
| --- | --- |
| `settings.json is not valid JSON, so it was left alone` | Ask the person to fix or move that file, then run the installer again. |
| `✗ <mod> did not validate` | Their Claude Code is likely older than these mods. Ask them to update it, then run the installer again. |
| `Neither node nor python3 is installed` | Do step 3b by hand, separating the paths with `:` instead of `;`. |

## 3b. Install on Windows

`install.sh` doesn't run on Windows. Do the same thing by hand:

1. Read `%USERPROFILE%\.claude\settings.json`. If it doesn't exist, start from `{}`. Save a copy as `settings.json.bak` first.
2. Set `env.CLAUDE_CODE_PLUGIN_DIRS` to include these three absolute paths, separated by `;` (Windows' path-list separator):

   ```
   %USERPROFILE%\.claude\mods\claude-mods\session-hud
   %USERPROFILE%\.claude\mods\claude-mods\message-queue
   %USERPROFILE%\.claude\mods\claude-mods\skill-dock
   ```

   Write the real expanded paths (`C:\Users\<name>\...`), not `%USERPROFILE%`. If the variable already has paths, keep them and add these after a `;`. Keep every other key in the file.
3. If the person chose the desktop app only or the terminal only, set each mod's **Show in** setting. Merge it into any `pluginConfigs` already there:

   ```json
   "pluginConfigs": {
     "session-hud": { "options": { "show_in": "desktop" } },
     "message-queue": { "options": { "show_in": "desktop" } },
     "skill-dock": { "options": { "show_in": "desktop" } }
   }
   ```

   Use `"terminal"` for the terminal only. Leave it out for both.
4. If `claude` is on the PATH, check each mod: `claude plugin validate <path>`.

## 4. Load and check

The mods load when Claude Code starts, so the person needs to:

- **Desktop app:** quit it completely and reopen it, then start a new session in the Code tab.
- **Terminal:** start a new `claude` session.

To check it worked, type `/` in the prompt. `/dock`, `/queue` and `/handoff` should be in the list.

The panel above the prompt stays empty until there's something to show. That's when subagents run, a message is queued, a handoff is ready, or once they've pinned or used a skill.

## 5. Optional: queue with Shift+Enter

Ask first. This makes Shift+Enter queue a message instead of starting a new line (`ctrl+j` still adds one).

If they want it, read `~/.claude/keybindings.json`. If it doesn't exist, create it with:

```json
{
  "$schema": "https://www.schemastore.org/claude-code-keybindings.json",
  "$docs": "https://code.claude.com/docs/en/keybindings",
  "bindings": [
    { "context": "Chat", "bindings": { "shift+enter": "chat:queueSubmit" } }
  ]
}
```

If it exists, add `"shift+enter": "chat:queueSubmit"` to the `Chat` context's `bindings`, adding that context if it's missing. Keep everything else.

Some terminals send Shift+Enter as a plain Enter. If it doesn't work there, suggest running `/terminal-setup` once. Without the key, `/queue <message>` does the same job everywhere.

## Changing where the mods run

Run `~/.claude/mods/claude-mods/install.sh --only desktop` (or `terminal`, `both`), then start a new session. People can also change **Show in** for each mod under `/config` in Claude Code.

## Updating

Run `~/.claude/mods/claude-mods/install.sh` again. It keeps the person's choice of where the mods run. It pulls the latest version first, unless the clone has local changes. Then start a new session.

## Uninstalling

```sh
~/.claude/mods/claude-mods/install.sh --uninstall   # removes the mods and their settings from settings.json
rm -rf ~/.claude/mods/claude-mods                   # optional: deletes the files
```

On Windows, remove the three paths from `env.CLAUDE_CODE_PLUGIN_DIRS` and the three mods' entries from `pluginConfigs` by hand, then delete the folder.

If the person added the Shift+Enter key, remove `"shift+enter": "chat:queueSubmit"` from `~/.claude/keybindings.json` too.
