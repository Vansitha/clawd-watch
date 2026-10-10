# claude-mods

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Three small mods that make Claude Code easier to work with: see when your subagents will finish, queue messages for after Claude is done, and keep your favourite skills one click away.

![claude-mods in the Claude desktop app](docs/preview.png)

| Mod | What it adds |
| --- | --- |
| [session-hud](#session-hud) | When your subagents will finish, and a one-click handoff to a fresh session |
| [message-queue](#message-queue) | Messages that wait until Claude finishes, instead of steering the current task |
| [skill-dock](#skill-dock) | Your pinned and most-used skills above the prompt |

Each mod adds a section to the panel above the prompt. The sections share one layout, so together they read as a single panel.

## Install

**Requirements:** a Claude Code build with mods (plugins of function hooks). These were built against Claude Code 2.1.288. The mods API is in early access and may change between releases.

### With Claude

Paste this into Claude Code:

```
Install claude-mods for me: clone https://github.com/Vansitha/claude-mods into ~/.claude/mods/claude-mods and follow the INSTALL.md inside it.
```

Claude clones the repo, runs the installer (or does the same by hand on Windows), checks each mod, and tells you what to do next. It asks before changing any keys. The steps it follows are in [INSTALL.md](INSTALL.md).

### By hand (macOS or Linux)

```sh
git clone https://github.com/Vansitha/claude-mods.git ~/.claude/mods/claude-mods
~/.claude/mods/claude-mods/install.sh
```

Then quit and reopen the Claude desktop app, or start a new `claude` session. Type `/` in the prompt: `/dock`, `/queue` and `/handoff` should be in the list.

The installer adds the three mods to `CLAUDE_CODE_PLUGIN_DIRS` in `~/.claude/settings.json` and keeps everything else there. It saves the old file as `settings.json.bak`, then checks each mod. Run it again any time to update.

| To | Run |
| --- | --- |
| Update | `~/.claude/mods/claude-mods/install.sh` (it pulls the latest version first) |
| Uninstall | `~/.claude/mods/claude-mods/install.sh --uninstall` |
| Try them in one terminal session without changing your settings | `cd ~/.claude/mods/claude-mods && claude --plugin-dir session-hud --plugin-dir message-queue --plugin-dir skill-dock` |

On Windows, follow [INSTALL.md](INSTALL.md) step 3b, or ask Claude to.

## session-hud

```
Subagents     All done by ~5:59 PM  ·  in ~4m 46s
              ● Build rooms: crew and seats            done by ~5:57 PM  ·  ~3m 36s
                ━━━━━━━──────────  Reading crew-tokens.ts
              ● Remove the hands overlay               done by ~5:59 PM  ·  ~4m 46s
                ━━━──────────────  Editing Hand.tsx
Next session  Build the upgrades screen         [Start fresh session] [Copy] [Dismiss]
```

**Subagents.** While subagents run, the header says when they'll all be done. Each agent shows when it will be done, a progress bar, and what it's doing right now.

Claude Code doesn't report real progress for subagents, so these are estimates. They're based on elapsed time, steps taken, and how long past subagents of the same type took. The mod remembers past runs across sessions, so estimates improve the more you use it.

**Handoff to a fresh session.** **Start fresh session** clears the conversation and sends a starter prompt for the next piece of work, so you don't have to write one. The prompt is also copied to your clipboard.

- `/handoff` writes the starter prompt on demand. Add a focus if you like: `/handoff the payments refactor`.
- Every few turns, sooner once the context passes 30%, the mod asks Claude whether the next piece of work would go better in a fresh session. When it would, the section appears on its own as **Suggested**, with the reason. If you don't use it, it clears itself after 3 more turns.
- `/handoff auto off` and `/handoff auto on` turn the automatic suggestions off or on.

## message-queue

```
Queued (2)    1  Then add tests for the rooms screen and run them                   ✕
              2  Update the README with the new crew and seats flow               ↑ ✕
                 Sent one at a time, each after Claude finishes.
```

Queue a message for Claude to read **after** it finishes what it's doing, instead of steering the task it's on.

- **Enter** works as always: a message typed while Claude works steers the current task.
- **The queue key** holds the message instead, and Claude reads it once the current task ends. This is Claude Code's `chat:queueSubmit`, `ctrl+x enter` by default.
- **`/queue <message>`** does the same from the prompt, and works everywhere, the desktop app included. `/queue clear` empties the queue.
- Queued messages go one at a time, in order, each after the previous task finishes. **↑** moves one up and **✕** removes it.
- If you stop Claude with Esc, the queue pauses so it doesn't start the next task without you. Press **Send next** when you're ready.
- Messages with images can't be queued, so they're sent right away.

### Queue with Shift+Enter

Add this to `~/.claude/keybindings.json`, merging it with anything already there:

```json
{
  "$schema": "https://www.schemastore.org/claude-code-keybindings.json",
  "$docs": "https://code.claude.com/docs/en/keybindings",
  "bindings": [
    { "context": "Chat", "bindings": { "shift+enter": "chat:queueSubmit" } }
  ]
}
```

Shift+Enter then queues instead of starting a new line; `ctrl+j` still adds one. Some terminals send Shift+Enter as a plain Enter. If yours does, run `/terminal-setup` once.

## skill-dock

```
Skills        [★ code-review] [★ pdf] [★ deep-research]  │  [simplify] [xlsx]   All skills (12) ›
```

Your pinned skills and your most-used ones, one click away.

- **Click a skill** to put `/skill-name` at the front of the prompt box, keeping anything you'd already typed. Add details and press Enter.
- **★ Pinned skills** come first, then your most-used ones, as many as fit the width. "Most used" counts how often you used each skill in the last 30 days, whether you typed `/name` or Claude loaded it.
- **All skills ›** (or `/dock`) opens a side pane with three lists:
  - **Pinned**
  - **Most used:** your top 10
  - **Available here:** every skill you can use in this project, A to Z

  Click ☆ to pin a skill, or click a name to use it. Where the app can't show a side pane, the lists open inside the panel instead.
- `/dock pin <skill>` and `/dock unpin <skill>` pin from the prompt.
- In the `/` menu, pinned skills say `★ pinned` and used ones say how often you used them this month.

Built-in skills such as `simplify` look like ordinary commands until you use them once. After that they show up in the lists.

## Where it works

In the terminal the same panel is drawn in text, with `[ buttons ]` and block progress bars:

![claude-mods in the terminal](docs/terminal.png)

- **Claude desktop app, Code tab** (local sessions): everything, with native buttons and rounded progress bars.
- **Terminal** (`claude`): everything, drawn in text. In the fullscreen layout you can click the buttons; otherwise press `ctrl+x tab` to focus the panel.
- **VS Code extension and mobile:** Claude Code doesn't draw the panel above the prompt there, so nothing shows. The slash commands still work.
- **Cloud sessions** run on a remote machine, so the mods would need to be installed there, not on your computer.

## Develop

Each mod is a folder with a manifest (`.claude-plugin/plugin.json`), a hooks module (`hooks/register.tsx`), a state contract (`types/index.d.ts`) and tests (`tests/`).

```sh
for mod in session-hud message-queue skill-dock; do
  claude plugin validate $mod && claude plugin test $mod
done
```

Load a mod with `claude --plugin-dir <folder>` while you work on it: it reloads whenever you save.

Issues and pull requests are welcome.

## License

[MIT](LICENSE)
