import { atom, read, update } from 'claude-code'
import type { CommandInfo, ElementTable, EngineInterface, On } from 'claude-code'

import type { PaneFilter, SkillEntry, SkillKind, Uses } from '../types'
import { openPane } from './pane.js'
import { LABEL_WIDTH, SECTION_GAP, cardFor, collapsedList, isActive, section } from './shared.js'
import type { View } from './shared.js'

type Chip = { name: string; label: string; isPinned: boolean }

const pins = atom({ plugin: 'clawd-watch', key: 'pins' } as const, [])
const uses = atom({ plugin: 'clawd-watch', key: 'uses' } as const, {})
const skills = atom({ plugin: 'clawd-watch', key: 'skills' } as const, [])
const isInline = atom({ plugin: 'clawd-watch', key: 'isInline' } as const, false)
const hidden = atom({ plugin: 'clawd-watch', key: 'hidden' } as const, [])
const filter = atom({ plugin: 'clawd-watch', key: 'filter' } as const, 'all')
const query = atom({ plugin: 'clawd-watch', key: 'query' } as const, '')
const confirming = atom({ plugin: 'clawd-watch', key: 'confirming' } as const, null)

const DOCK_LABEL = 'Favourite skills'
const STORE_PINS = 'pins'
const STORE_USES = 'uses'
const STORE_KNOWN = 'knownSkills'
const STORE_HIDDEN = 'hidden'

/** Where a removed skill goes, under the home folder, so it can be moved back. */
const REMOVED_DIR = '.claude/clawd-watch/removed-skills'
const REMOVED_NOTE = `Skills removed from Claude Code by Clawd Watch's skill dock.
To restore one, move it back and drop the date from its name:
a folder into ~/.claude/skills (or the project's .claude/skills),
a .md file into ~/.claude/commands. Then run /reload-skills.
`
/** What \`npx skills add\` records: installed everywhere, and in this project. */
const SKILL_LOCKS = { home: '.agents/.skill-lock.json', project: 'skills-lock.json' }
/**
 * A skill or command name, with \`:\` between folders, no part starting with a dot (so never \`..\`);
 * anything else is never looked up on disk, let alone moved.
 */
export const SAFE_NAME = /^[\w-][\w.-]*(:[\w-][\w.-]*)*$/
const KIND_LABEL: Record<SkillKind, string> = {
  builtin: 'Built-in',
  mine: 'Mine',
  installed: 'Installed',
}
/** Clawd Watch's own commands (/watch, /dock, /handoff, /queue) aren't skills; nor are the old mods'. */
const CLAWD_WATCH_MODS = ['clawd-watch', 'session-hud', 'message-queue', 'skill-dock']
const FILTERS: readonly PaneFilter[] = ['all', 'builtin', 'mine', 'installed', 'hidden']

const DAY = 86_400_000
/** A use counts half as much each week it ages. */
const HALF_LIFE = 7 * DAY
/** "Most used" counts the last WINDOW_DAYS days; older uses are forgotten after KEEP_DAYS. */
const WINDOW_DAYS = 30
const WINDOW = WINDOW_DAYS * DAY
const KEEP = 60 * DAY
const MAX_USES = 60
const DOCK_FREQUENT = 5
const PANE_FREQUENT = 10
const LONG_TOAST_MS = 8000

/** Cells a chip takes beyond its label (a terminal text chip, a drawn button). */
const CHIP_PADDING_TEXT = 2
const CHIP_PADDING_BUTTON = 5
/** Cells for the "│" between pinned and frequent chips. */
const SEPARATOR_CELLS = 3
/** Cells the chip row leaves free: the gap before "All skills" and the band's edge. */
const ROW_SLACK = 4
/** Gap after the label column. */
const LABEL_GAP = 2

/** Copies of the stored pins, uses and known built-in skills, for hooks that run often. */
const local: {
  pins: string[]
  uses: Uses
  known: string[]
  hidden: string[]
  /** Skills removed this session; the engine lists them until its skills reload. */
  removed: string[]
  monthCounts: Record<string, number>
  cwd?: string
  loaded?: Promise<void>
} = { pins: [], uses: {}, known: [], hidden: [], removed: [], monthCounts: {} }

export function score(times: readonly number[] = [], at: number): number {
  return times.reduce((sum, t) => sum + Math.pow(0.5, (at - t) / HALF_LIFE), 0)
}

export function recentCount(times: readonly number[] = [], at: number): number {
  return times.filter(t => at - t <= WINDOW).length
}

/** The most-used skills that are not pinned: most uses in the window first, recent use breaking ties. */
export function frequent(
  list: readonly SkillEntry[],
  pinned: readonly string[],
  used: Uses,
  at: number,
  limit: number,
): SkillEntry[] {
  return list
    .filter(s => !pinned.includes(s.name) && recentCount(used[s.name], at) > 0)
    .sort(
      (a, b) =>
        recentCount(used[b.name], at) - recentCount(used[a.name], at) ||
        score(used[b.name], at) - score(used[a.name], at),
    )
    .slice(0, limit)
}

/** The chips that fit in `room` cells, in order; the first unpinned one after a pinned one also pays for the separator. */
export function fitChips(chips: readonly Chip[], room: number, padding: number): Chip[] {
  const fitted: Chip[] = []
  let left = room

  for (const chip of chips) {
    const separator = !chip.isPinned && fitted.at(-1)?.isPinned ? SEPARATOR_CELLS : 0
    const width = chip.label.length + padding + separator
    if (width > left) continue
    fitted.push(chip)
    left -= width
  }

  return fitted
}

/** What kind of skill a command is, or undefined when it is not a skill. */
export function kindOf(
  info: CommandInfo,
  known: readonly string[],
): { kind: SkillKind; origin?: string } | undefined {
  if (info.plugin !== undefined && CLAWD_WATCH_MODS.includes(info.plugin)) return undefined
  if (info.source === 'user') return { kind: 'mine' }
  if (info.source === 'plugin') return { kind: 'installed', origin: info.plugin ?? 'a plugin' }
  if (!known.includes(info.name)) return undefined

  return info.source === 'mcp' ? { kind: 'installed', origin: 'MCP' } : { kind: 'builtin' }
}

/** The short tag a skill carries in the lists: Built-in, Mine, or where it was installed from. */
export function tagOf(s: SkillEntry): string {
  return s.kind === 'installed' ? (s.origin ?? KIND_LABEL.installed) : KIND_LABEL[s.kind]
}

/** Whether a skill shows under a filter and a search. */
export function matches(
  s: SkillEntry,
  view: { filter: PaneFilter; query: string; hidden: readonly string[] },
): boolean {
  const isHidden = view.hidden.includes(s.name)
  if (view.filter === 'hidden' ? !isHidden : isHidden) return false
  if (view.filter !== 'all' && view.filter !== 'hidden' && s.kind !== view.filter) return false
  const words = view.query.trim().toLowerCase()

  return (
    words === '' || [s.name, s.description, s.origin ?? ''].join(' ').toLowerCase().includes(words)
  )
}

/** The name without a plugin's namespace: `anthropic-skills:pdf` reads `pdf`. */
function short(name: string): string {
  return name.includes(':') ? name.slice(name.lastIndexOf(':') + 1) : name
}

function countRecent(used: Uses, at: number): Record<string, number> {
  return Object.fromEntries(
    Object.entries(used).map(([name, times]) => [name, recentCount(times, at)]),
  )
}

async function stored<T>($: EngineInterface, key: string, fallback: T): Promise<T> {
  const value = await $.store.get(key)

  return value === undefined || value === null ? fallback : (value as T)
}

/** Loads what was saved, once per load of the mod. */
function ensureLoaded($: EngineInterface): Promise<void> {
  local.loaded ??= loadSaved($)
  return local.loaded
}

async function loadSaved($: EngineInterface) {
  const [savedPins, savedUses, known, savedHidden, at] = await Promise.all([
    stored<string[]>($, STORE_PINS, []),
    stored<Uses>($, STORE_USES, {}),
    stored<string[]>($, STORE_KNOWN, []),
    stored<string[]>($, STORE_HIDDEN, []),
    $.clock.now(),
  ])
  Object.assign(local, {
    pins: savedPins,
    uses: savedUses,
    known,
    hidden: savedHidden,
    monthCounts: countRecent(savedUses, at),
  })
  await Promise.all([
    update($, pins, () => savedPins),
    update($, uses, () => savedUses),
    update($, hidden, () => savedHidden),
  ])
}

async function homeDir($: EngineInterface): Promise<string | undefined> {
  const home = await $.env.get('HOME').catch(() => undefined)

  return home ?? (await $.env.get('USERPROFILE').catch(() => undefined))
}

/** The skills \`npx skills add\` installed, by name, with the repository each came from. */
async function installedFrom($: EngineInterface, home?: string): Promise<Record<string, string>> {
  const files = [
    home && `${home}/${SKILL_LOCKS.home}`,
    local.cwd && `${local.cwd}/${SKILL_LOCKS.project}`,
  ].filter((path): path is string => Boolean(path))
  const from: Record<string, string> = {}
  for (const file of files) {
    const lock = await $.fs
      .read(file)
      .then(text => JSON.parse(text) as { skills?: Record<string, { source?: unknown }> })
      .catch(() => undefined)
    for (const [name, entry] of Object.entries(lock?.skills ?? {})) {
      if (typeof entry?.source === 'string') from[name] = entry.source
    }
  }

  return from
}

/** Where one of your skills lives: its folder, or a command's file; the project's first. */
async function locate($: EngineInterface, roots: readonly string[], name: string) {
  if (!SAFE_NAME.test(name)) return undefined
  for (const root of roots) {
    const folder = `${root}/skills/${name}`
    if (await $.fs.exists(`${folder}/SKILL.md`)) return folder
    const file = `${root}/commands/${name.split(':').join('/')}.md`
    if (await $.fs.exists(file)) return file
  }

  return undefined
}

async function refreshSkills($: EngineInterface) {
  const home = await homeDir($)
  const roots = [local.cwd && `${local.cwd}/.claude`, home && `${home}/.claude`].filter(
    (root): root is string => Boolean(root),
  )
  const [infos, lock] = await Promise.all([$.command.list(), installedFrom($, home)])
  const list: SkillEntry[] = []
  for (const info of infos) {
    const kind = kindOf(info, local.known)
    if (!kind || local.removed.includes(info.name)) continue
    const entry: SkillEntry = { name: info.name, description: info.description, ...kind }
    if (info.source === 'user') {
      const path = await locate($, roots, info.name).catch(() => undefined)
      if (path) entry.path = path
      if (lock[info.name]) Object.assign(entry, { kind: 'installed', origin: lock[info.name] })
    }
    list.push(entry)
  }

  await update($, skills, () => list)
}

async function recordUse($: EngineInterface, name: string) {
  await ensureLoaded($)
  const at = await $.clock.now()
  const next = await update($, uses, all => {
    const kept = (all[name] ?? []).filter(t => at - t <= KEEP)

    return { ...all, [name]: [...kept, at].slice(-MAX_USES) }
  })
  local.uses = next
  local.monthCounts = countRecent(next, at)

  // Built-in skills look like any other built-in command until they are used once.
  const isNewSkill = !local.known.includes(name)
  if (isNewSkill) local.known = [...local.known, name]
  await Promise.all([
    $.store.set(STORE_USES, next),
    isNewSkill ? $.store.set(STORE_KNOWN, local.known) : undefined,
  ])
  if (isNewSkill) await refreshSkills($)

  $.ui.invalidate('command.describe')
}

async function togglePin($: EngineInterface, name: string): Promise<boolean> {
  local.pins = await update($, pins, list =>
    list.includes(name) ? list.filter(n => n !== name) : [...list, name],
  )
  await $.store.set(STORE_PINS, local.pins)
  $.ui.invalidate('command.describe')

  return local.pins.includes(name)
}

/** Hides a skill from the dock and the pane, or shows it again; a hidden pin is unpinned. */
async function toggleHidden($: EngineInterface, name: string): Promise<boolean> {
  local.hidden = await update($, hidden, list =>
    list.includes(name) ? list.filter(n => n !== name) : [...list, name],
  )
  const isHidden = local.hidden.includes(name)
  await $.store.set(STORE_HIDDEN, local.hidden)
  if (isHidden && local.pins.includes(name)) await togglePin($, name)

  return isHidden
}

/** Moves one of your skills out of Claude Code, into a folder it can be restored from. */
async function removeSkill($: EngineInterface, s: SkillEntry) {
  await update($, confirming, () => null)
  const home = await homeDir($)
  if (!s.path || !home) {
    $.ui.toast(`Couldn't find where /${short(s.name)} lives, so it was left alone.`)
    return
  }

  const stamp = new Date(await $.clock.now()).toISOString().slice(0, 19).replace(/[:T]/g, '-')
  const folder = `${home}/${REMOVED_DIR}`
  const isFile = s.path.endsWith('.md')
  const target = `${folder}/${s.name.replace(/:/g, '-')}-${stamp}${isFile ? '.md' : ''}`
  await $.fs.write(`${folder}/README.txt`, REMOVED_NOTE)
  const isWindows = (await $.env.get('OS').catch(() => undefined)) === 'Windows_NT'
  const moved = await $.process
    .run(isWindows ? ['cmd', '/c', 'move', s.path, target] : ['mv', s.path, target])
    .catch((error: unknown) => ({ exitCode: 1, stderr: String(error) }))
  if (moved.exitCode !== 0) {
    $.ui.toast(`Couldn't remove /${short(s.name)}: ${moved.stderr.trim() || 'the move failed'}`)
    return
  }

  local.removed = [...local.removed, s.name]
  if (local.pins.includes(s.name)) await togglePin($, s.name)
  await update($, skills, list => list.filter(one => one.name !== s.name))
  $.ui.toast(
    `Removed /${short(s.name)}. It's in ~/${REMOVED_DIR} if you want it back; run /reload-skills to drop it from the / menu.`,
    { timeoutMs: LONG_TOAST_MS },
  )
}

async function insertSkill($: EngineInterface, name: string) {
  const draft = (await $.prompt.read()).text
  // Swap a slash command already at the front for this one, keep the rest of the draft.
  const rest = draft.replace(/^\/[\w:.-]+\s*/, '').trimStart()
  const filled = await $.prompt.fill({ text: `/${name} ${rest}`, mode: 'replace' })

  if (!filled.isFilled) $.ui.toast(`Type /${name} to use it; the prompt box is busy.`)
}

/** Opens Clawd Watch's pane on all skills; where no pane can be placed, the list opens inline. */
async function openAll($: EngineInterface) {
  await refreshSkills($)
  const isPlaced = await openPane($, 'skills')
  await update($, isInline, () => !isPlaced)
}

const FILTER_LABEL: Record<PaneFilter, string> = {
  all: 'All',
  builtin: KIND_LABEL.builtin,
  mine: KIND_LABEL.mine,
  installed: KIND_LABEL.installed,
  hidden: 'Hidden',
}

/** Everything the skill lists draw from, read together. */
async function listState($: EngineInterface) {
  const [pinned, used, list, hiddenList, filterBy, search, confirmingId, collapsed, at] =
    await Promise.all([
      read($, pins),
      read($, uses),
      read($, skills),
      read($, hidden),
      read($, filter),
      read($, query),
      read($, confirming),
      collapsedList($),
      $.clock.now(),
    ])

  return { pinned, used, list, hiddenList, filterBy, search, confirmingId, collapsed, at }
}

type ListState = Awaited<ReturnType<typeof listState>>

function skillRow(
  $: EngineInterface,
  t: ElementTable,
  list: string,
  s: SkillEntry,
  row: {
    isPinned: boolean
    isHidden: boolean
    isConfirming: boolean
    isText: boolean
    meta?: string
  },
) {
  const { Box, Text, Button } = t
  const plain = row.isText || undefined
  // Where there's a pointer, a row's action shows only while it's hovered.
  const reveal = row.isText ? {} : { display: 'none' as const, hover: { display: 'flex' as const } }
  const action = row.isHidden
    ? { label: 'Unhide', onPress: () => toggleHidden($, s.name) }
    : s.path
      ? { label: 'Remove', onPress: () => update($, confirming, () => `${list}:${s.name}`) }
      : {
          label: 'Hide',
          onPress: async () => {
            await toggleHidden($, s.name)
            $.ui.toast(`Hid /${short(s.name)}. It's under Hidden in the skills pane.`)
          },
        }

  return (
    <Box key={`${list}-row-${s.name}`} flexDirection="column">
      <Box flexDirection="row" gap={1} alignItems="center">
        {!row.isHidden && (
          <Button
            key={`${list}-star-${s.name}`}
            plain
            dimColor={!row.isPinned}
            label={row.isPinned ? '★' : '☆'}
            onPress={async () => {
              const nowPinned = await togglePin($, s.name)
              $.ui.toast(`${nowPinned ? 'Pinned' : 'Unpinned'} /${short(s.name)}`)
            }}
          />
        )}
        <Box flexGrow={1} flexShrink={1} minWidth={0}>
          <Button
            key={`${list}-use-${s.name}`}
            plain
            label={short(s.name)}
            onPress={() => insertSkill($, s.name)}
          />
        </Box>
        {row.meta !== undefined && <Text dimColor>{row.meta}</Text>}
        <Box flexShrink={1} minWidth={0}>
          <Text dimColor wrap="truncate-end">
            {tagOf(s)}
          </Text>
        </Box>
        <Box flexShrink={0} {...reveal}>
          <Button
            key={`${list}-act-${s.name}`}
            plain
            dimColor
            label={action.label}
            onPress={action.onPress}
          />
        </Box>
      </Box>
      {row.isConfirming && (
        <Box flexDirection="column" paddingLeft={2} marginTop={1} marginBottom={1}>
          <Text wrap="wrap">
            {`Remove /${short(s.name)} from Claude Code? It moves to ~/${REMOVED_DIR}, where you can restore it.`}
          </Text>
          <Box flexDirection="row" gap={1} marginTop={1}>
            <Button
              key={`${list}-remove-${s.name}`}
              plain={plain}
              variant="primary"
              label="Remove"
              onPress={() => removeSkill($, s)}
            />
            <Button
              key={`${list}-cancel-${s.name}`}
              plain={plain}
              role="dismiss"
              label="Cancel"
              onPress={() => update($, confirming, () => null)}
            />
          </Box>
        </Box>
      )}
    </Box>
  )
}

/**
 * The skills pane, or the list under the dock: a search, filters by kind, then pinned, most used
 * and every skill available here (or the hidden ones). The desktop pane draws each as a card.
 */
function skillList(
  $: EngineInterface,
  t: ElementTable,
  state: ListState,
  view: { isText: boolean; hasCards: boolean },
) {
  const { Box, Text, Button } = t
  const { list, pinned, used, at, hiddenList, filterBy, search, confirmingId, collapsed } = state
  const byName = new Map(list.map(s => [s.name, s]))
  const entry = (name: string): SkillEntry =>
    byName.get(name) ?? { name, description: '', kind: 'builtin' }
  const shows = (s: SkillEntry) =>
    matches(s, { filter: filterBy, query: search, hidden: hiddenList })
  const isNarrowed = filterBy !== 'all' || search.trim() !== ''
  const row = (listName: string, s: SkillEntry, meta?: string) =>
    skillRow($, t, listName, s, {
      isPinned: pinned.includes(s.name),
      isHidden: hiddenList.includes(s.name),
      isConfirming: confirmingId === `${listName}:${s.name}`,
      isText: view.isText,
      ...(meta === undefined ? {} : { meta }),
    })

  const counts: Record<PaneFilter, number> = {
    all: list.filter(s => !hiddenList.includes(s.name)).length,
    builtin: 0,
    mine: 0,
    installed: 0,
    hidden: list.filter(s => hiddenList.includes(s.name)).length,
  }
  for (const s of list) if (!hiddenList.includes(s.name)) counts[s.kind] += 1
  const filters = FILTERS.filter(f => f !== 'hidden' || counts.hidden > 0 || filterBy === 'hidden')

  const group = (name: string, detail: string, rows: JSX.Element[], emptyText: string) => {
    if (rows.length === 0 && isNarrowed) return null
    const body =
      rows.length > 0 ? (
        <Box flexDirection="column">{rows}</Box>
      ) : (
        <Text dimColor italic>
          {emptyText}
        </Text>
      )
    if (view.hasCards) {
      return section(t, name, body, {
        isStacked: true,
        aside: <Text dimColor>{detail}</Text>,
        card: cardFor($, { isText: false, collapsed }, name),
      })
    }

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between">
          <Text dimColor bold>
            {name.toUpperCase()}
          </Text>
          <Text dimColor>{detail}</Text>
        </Box>
        {body}
      </Box>
    )
  }

  const sorted = (entries: SkillEntry[]) =>
    [...entries].sort((a, b) => short(a.name).localeCompare(short(b.name)))
  const groups =
    filterBy === 'hidden'
      ? [
          group(
            'Hidden',
            `${counts.hidden}`,
            sorted(list.filter(shows)).map(s => row('hidden', s)),
            '',
          ),
        ]
      : [
          group(
            'Pinned',
            pinned.length ? `${pinned.length}` : '',
            pinned
              .map(entry)
              .filter(shows)
              .map(s => row('pinned', s)),
            'Click ☆ next to a skill to pin it.',
          ),
          group(
            'Most used',
            `last ${WINDOW_DAYS} days`,
            frequent(list.filter(shows), [], used, at, PANE_FREQUENT).map(s =>
              row('used', s, `${recentCount(used[s.name], at)}×`),
            ),
            'Skills you use will show up here.',
          ),
          group(
            'Available here',
            `${list.filter(shows).length}`,
            sorted(list.filter(shows)).map(s => row('all', s)),
            'No skills here yet.',
          ),
        ]
  const shown = groups.filter(Boolean)

  return (
    <Box flexDirection="column" gap={SECTION_GAP}>
      {'Input' in t && (
        <t.Input
          key="skills-search"
          placeholder="Search skills"
          value={search}
          onInput={value => void update($, query, () => value)}
          onSubmit={value => void update($, query, () => value)}
        />
      )}
      <Box flexDirection="row" flexWrap="wrap" gap={2}>
        {filters.map(f => (
          <Button
            key={`skills-filter-${f}`}
            plain
            dimColor={f !== filterBy}
            label={`${FILTER_LABEL[f]} ${counts[f]}`}
            onPress={() => update($, filter, () => f)}
          />
        ))}
      </Box>
      {shown}
      {shown.length === 0 && (
        <Text dimColor italic>
          No skills match.
        </Text>
      )}
    </Box>
  )
}

function chipRow($: EngineInterface, t: ElementTable, chips: Chip[], isText: boolean) {
  const { Text, Button } = t
  const row: JSX.Element[] = []

  chips.forEach((chip, index) => {
    // On the desktop the stars mark the pins; a bar there could wrap to the start of a row.
    if (isText && !chip.isPinned && chips[index - 1]?.isPinned) row.push(<Text dimColor>│</Text>)
    row.push(
      <Button
        key={`dock-${chip.isPinned ? 'pin' : 'freq'}-${chip.name}`}
        // In the terminal, chips are plain text spaced apart; brackets around each read as noise.
        // On the desktop only pins are chips, so they read apart from the skills used often.
        plain={isText || !chip.isPinned || undefined}
        dimColor={!chip.isPinned}
        label={chip.label}
        onPress={() => insertSkill($, chip.name)}
      />,
    )
  })

  return row
}

/** The hooks behind the Favourite skills section, the skills list and /dock. */
export function registerSkills(on: On, showIn: string) {
  on('skill.prompt', async ($, e, next) => {
    const result = await next(e)
    $.clock.after(0, () => void recordUse($, e.skill))

    return result
  })

  on('command.run', { command: 'dock' }, async ($, e) => {
    if (!(await isActive($, showIn))) {
      return { text: `Clawd Watch is set to show in the ${showIn} only. Change it under /config.` }
    }

    const [verb, name] = (e.args ?? '').trim().split(/\s+/)
    const skill = (name ?? '').replace(/^\//, '')
    if ((verb === 'pin' || verb === 'unpin') && skill) {
      if ((verb === 'pin') !== local.pins.includes(skill)) await togglePin($, skill)

      return { text: `${verb === 'pin' ? 'Pinned' : 'Unpinned'} /${skill}.` }
    }
    if ((verb === 'hide' || verb === 'unhide') && skill) {
      if ((verb === 'hide') !== local.hidden.includes(skill)) await toggleHidden($, skill)

      return { text: `${verb === 'hide' ? 'Hid' : 'Unhid'} /${skill}.` }
    }

    await openAll($)

    return { text: 'Opened your skills.' }
  })

  // Runs once per command the menu lists, so it reads the local copies rather than the store.
  on('command.describe', async ($, e, next) => {
    const result = await next(e)
    const isPinned = local.pins.includes(e.command)
    const count = local.monthCounts[e.command] ?? 0
    if ((!isPinned && count === 0) || !(await isActive($, showIn))) return result

    const note = isPinned ? '★ pinned' : `↻ ${count}× in ${WINDOW_DAYS} days`

    return { ...result, description: `${note} · ${result.description}` }
  })
}

/** The Favourite skills section: pinned and most-used skills, a click from the prompt. */
export async function skillsSections(
  $: EngineInterface,
  t: ElementTable,
  view: View,
): Promise<JSX.Element[]> {
  const [state, inline] = await Promise.all([listState($), read($, isInline)])
  const { pinned, used, list, hiddenList, at } = state
  const { Box, Text, Button } = t
  const { isText, isStacked } = view

  const allLabel = inline ? 'Close' : `All skills (${list.length - hiddenList.length}) ›`
  const shown = list.filter(s => !hiddenList.includes(s.name))
  const candidates = [
    ...pinned
      .filter(name => !hiddenList.includes(name))
      .map(name => ({ name, label: `★ ${short(name)}`, isPinned: true })),
    ...frequent(shown, pinned, used, at, DOCK_FREQUENT).map(s => ({
      name: s.name,
      label: short(s.name),
      isPinned: false,
    })),
  ]
  // The desktop app wraps the chips, so every pin shows. The terminal keeps one row of the
  // chips that fit; the rest are a click away in All skills.
  const room =
    view.columns - (isStacked ? 0 : LABEL_WIDTH + LABEL_GAP + allLabel.length) - ROW_SLACK
  const chips = isText ? fitChips(candidates, room, CHIP_PADDING_TEXT) : candidates
  const allButton = (
    <Button
      key="dock-all"
      plain
      dimColor
      label={allLabel}
      onPress={() => (inline ? update($, isInline, () => false) : openAll($))}
    />
  )

  return [
    section(
      t,
      DOCK_LABEL,
      <Box flexDirection="column">
        <Box
          flexDirection="row"
          flexWrap={isText ? 'nowrap' : 'wrap'}
          gap={isText ? 2 : 1}
          alignItems="center"
          overflow="hidden"
        >
          {chips.length === 0 && <Text dimColor>Pin or use a skill and it shows up here</Text>}
          {chipRow($, t, chips, isText)}
        </Box>
        {inline && (
          <Box flexDirection="column" marginTop={1}>
            {skillList($, t, state, { isText, hasCards: false })}
          </Box>
        )}
      </Box>,
      { isStacked, aside: allButton, isCentred: !inline, card: cardFor($, view, DOCK_LABEL) },
    ),
  ]
}

/** Every skill, searchable and filtered by kind: the pane's skills view. */
export async function allSkills($: EngineInterface, t: ElementTable, view: View) {
  return skillList($, t, await listState($), { isText: view.isText, hasCards: !view.isText })
}

/** At session start: /dock, what was saved, and the skills this session has. */
export async function startSkills($: EngineInterface, cwd: string) {
  local.cwd = cwd
  await Promise.all([
    $.command
      .register({
        name: 'dock',
        description: 'Show all your skills in Clawd Watch: search, pin, hide or remove them',
        argumentHint: '[pin | unpin | hide | unhide <skill>]',
      })
      .catch(() => undefined),
    ensureLoaded($),
  ])
  await refreshSkills($)
}
