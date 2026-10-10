# claude-mods

Mods for Claude Code: plugins of function hooks that draw UI and react to events inside a session.

## session-hud

A small heads-up display above the prompt box.

```
Subagents  2 running  ·  1 done  ·  ~1m 20s left  ·  done ≈ 3:42 PM
⠹ Find auth handlers  Explore                          0:42  ·  ~45s left
  ━━━━━━━━━━──────────  48%   Searching "login"
✓ Design the schema  Plan                                    done in 1:05

✦ Build the login page  next task is separate   [Start fresh session] [Copy] [Dismiss]

5-hour limit  ━━━━━━──────────────  34%  ·  resets 4:20 PM
```

In the desktop app the bars are drawn as rounded bars and the sections are spaced apart.
- **5-hour usage meter**: a subtle horizontal bar showing the five-hour rate-limit window, its percentage and when it resets. It turns yellow at 70% and red at 90%. It updates with every model response, and shows only on a Claude subscription login (an API key has no five-hour window).
- **Subagent panel**: while subagents run, one row each with its task, type, a progress bar, elapsed time, time left and what it is doing right now, plus a header with the estimated finish time for the whole batch. Claude Code does not report real progress for subagents, so progress and ETAs are estimates from elapsed time, steps taken and how long past subagents of the same type took. The mod remembers past runs across sessions, so estimates improve with use.
- **Handoff pill**: one click on **Start fresh session** clears the conversation and submits a starter prompt for the next piece of work. You type nothing. The prompt is also copied to your clipboard.
  - `/handoff` writes the starter prompt on demand. Add a focus if you like: `/handoff the payments refactor`.
  - Every few turns (sooner once the context passes 30%) the mod asks Claude whether the next work would go better in a fresh session. When it would, the pill appears on its own, marked `✦` with the reason. An unused suggestion clears itself after 3 more turns, as it goes stale.
  - `/handoff auto off` and `/handoff auto on` turn the automatic suggestions off or on.

In the fullscreen terminal the pill's buttons are clickable. Otherwise focus the band with `ctrl+x tab`, then press `s` (start), `c` (copy) or `x` (dismiss).

## skill-dock

Your pinned and most-used skills in one row above the prompt, so you don't have to remember their names.

```
★ code-review  ★ pdf  ↻ simplify 18×  ↻ xlsx 11×  ↻ dataviz 9×        ⌕ All skills (31)
```

- **Click a skill** to put `/skill-name` at the front of the prompt box, keeping anything you'd already typed. Add details and press Enter.
- **★ Pinned** skills come first, in the order you pinned them. **↻** marks your 5 most-used skills. Recent use counts most: a use a week ago is worth half a use today, so skills you've stopped using drift out.
- A use counts whether you typed `/name` or Claude loaded the skill on its own. Pins and usage are saved across sessions and projects.
- **All skills** (or `/dock`) opens a pane on the right with a filter box and three sections: pinned, frequently used, and every skill grouped by where it comes from. Click ☆ to pin. Press Enter in the filter to insert the first match. Where the app can't show a side pane, the list opens inside the dock instead.
- `/dock pin <skill>` and `/dock unpin <skill>` pin from the prompt.
- In the `/` menu, pinned skills say `★ pinned` and used ones say how often you used them this month. Claude Code doesn't let a mod reorder that menu, only add to its text.
- Built-in skills such as `simplify` look like ordinary built-in commands until you use them once. After that they show up in the list.

skill-dock and session-hud work together: the dock row sits above the subagent rows and the usage meter.

## Install

On macOS or Linux, run:

```sh
git clone https://github.com/Vansitha/claude-mods.git ~/.claude/mods/claude-mods
~/.claude/mods/claude-mods/install.sh
```

Then quit and reopen the desktop app, or start a new `claude` session. The installer adds both mods to `CLAUDE_CODE_PLUGIN_DIRS` in `~/.claude/settings.json`, keeping everything else there, and saves the old file as `settings.json.bak`. Run `install.sh` again to update.

To load them for one session only instead:

```sh
claude --plugin-dir ~/.claude/mods/claude-mods/session-hud --plugin-dir ~/.claude/mods/claude-mods/skill-dock
```

### Where it works

- **Terminal** (`claude` in any terminal): everything.
- **Desktop app, Code tab** (local sessions): everything. The buttons are native and clickable. The desktop app can't take `--plugin-dir`, so load it through `CLAUDE_CODE_PLUGIN_DIRS` in `~/.claude/settings.json` as above, then start a new session.
- **VS Code extension and mobile**: not supported. Claude Code doesn't draw the band above the prompt there, so nothing shows. The `/handoff` command still runs, but its pill can't appear.
- **Cloud sessions** run on a remote machine, so the mod has to be loaded in that environment, not on your computer.

### Develop

```sh
claude plugin validate session-hud && claude plugin test session-hud
claude plugin validate skill-dock && claude plugin test skill-dock
```
