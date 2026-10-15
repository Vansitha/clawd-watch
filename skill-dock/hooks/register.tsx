import { atom, read, update } from 'claude-code'
import type {
  CommandInfo,
  ElementTable,
  EngineInterface,
  Register,
  RenderSurface,
} from 'claude-code'

import type { PaneFilter, Panel, SkillEntry, SkillKind, Uses } from '../types'

type Chip = { name: string; label: string; isPinned: boolean }

const pins = atom({ plugin: 'skill-dock', key: 'pins' } as const, [])
const uses = atom({ plugin: 'skill-dock', key: 'uses' } as const, {})
const skills = atom({ plugin: 'skill-dock', key: 'skills' } as const, [])
const isInline = atom({ plugin: 'skill-dock', key: 'isInline' } as const, false)
const hidden = atom({ plugin: 'skill-dock', key: 'hidden' } as const, [])
const filter = atom({ plugin: 'skill-dock', key: 'filter' } as const, 'all')
const query = atom({ plugin: 'skill-dock', key: 'query' } as const, '')
const confirming = atom({ plugin: 'skill-dock', key: 'confirming' } as const, null)

// Shared by every Clawd Watch mod; keep these identical across them.
const LABEL_WIDTH = 17
const NARROW_COLUMNS = 72
const HINT_KEY = 'clawd-watch-hint'
const HINT_TEXT = 'ctrl+x tab'
/** The desktop app's cards: the prompt box's own border colour, and their inner spacing. */
const CARD_BORDER = 'promptBorder'
const CARD_PADDING = { x: 2, y: 1 }
/** Rows between sections, and between cards. */
const SECTION_GAP = 1
const PANEL_KEY = 'clawd-watch-panel'
const PANEL_NAME = 'Clawd Watch'
const STORE_PANEL = 'panel'
/** Each mod keeps its own copy of whether the panel is folded; the latest change wins. */
const HUD_PANEL = atom({ plugin: 'session-hud', key: 'panel' } as const, null)
const QUEUE_PANEL = atom({ plugin: 'message-queue', key: 'panel' } as const, null)
const DOCK_PANEL = atom({ plugin: 'skill-dock', key: 'panel' } as const, null)
/** What the folded panel sums up, read from the mods that own it. */
const SUBAGENTS = atom({ plugin: 'session-hud', key: 'agents' } as const, [])
const NEXT_SESSION = atom({ plugin: 'session-hud', key: 'handoff' } as const, null)
const QUEUED = atom({ plugin: 'message-queue', key: 'messages' } as const, [])
/** This mod's own copy, the one it writes. */
const OWN_PANEL = atom({ plugin: 'skill-dock', key: 'panel' } as const, null)
const OWN_CARDS = atom({ plugin: 'skill-dock', key: 'collapsedCards' } as const, [])
const STORE_CARDS = 'collapsedCards'

const PANE = 'skill-dock'
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
/** Clawd Watch's own commands (/dock, /handoff, /queue) aren't skills. */
const CLAWD_WATCH_MODS = ['session-hud', 'message-queue', 'skill-dock']
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

/** Whether a drawn tree already holds an element with this key. */
function hasKey(node: unknown, key: string): boolean {
  if (!node || typeof node !== 'object') return false
  const element = node as { props?: { key?: unknown }; children?: unknown[] }

  return element.props?.key === key || (element.children ?? []).some(c => hasKey(c, key))
}

/** Whether another mod drew anything above this one. */
function hasContent(tree: unknown): boolean {
  return ((tree as { children?: unknown[] }).children?.length ?? 0) > 0
}

/** Whether the panel is folded: the most recent choice made in any Clawd Watch mod. */
async function isFolded($: EngineInterface): Promise<boolean> {
  const choices = await Promise.all([read($, HUD_PANEL), read($, QUEUE_PANEL), read($, DOCK_PANEL)])
  const latest = choices.reduce<Panel | null>(
    (best, one) => (one && (!best || one.at > best.at) ? one : best),
    null,
  )

  return latest?.isFolded ?? false
}

async function setFolded($: EngineInterface, isFolded: boolean) {
  const choice = { isFolded, at: await $.clock.now() }
  await Promise.all([update($, OWN_PANEL, () => choice), $.store.set(STORE_PANEL, choice)])
}

/** Restores the panel's last fold, kept across sessions. */
async function loadFolded($: EngineInterface) {
  const stored = (await $.store.get(STORE_PANEL)) as Panel | undefined
  if (typeof stored?.isFolded === 'boolean' && typeof stored.at === 'number') {
    await update($, OWN_PANEL, () => stored)
  }
}

/** Collapses a card, or opens it again, and keeps that for later sessions. */
async function toggleCard($: EngineInterface, name: string) {
  const list = await update($, OWN_CARDS, all =>
    all.includes(name) ? all.filter(one => one !== name) : [...all, name],
  )
  await $.store.set(STORE_CARDS, list)
}

async function loadCards($: EngineInterface) {
  const stored = await $.store.get(STORE_CARDS)
  if (Array.isArray(stored)) {
    await update($, OWN_CARDS, () => stored.filter((one): one is string => typeof one === 'string'))
  }
}

/** A section's card in the desktop app, collapsed as it was left; the terminal draws no cards. */
function cardFor(
  $: EngineInterface,
  isText: boolean,
  collapsed: readonly string[],
  name: string,
): Card | undefined {
  if (isText) return undefined

  return {
    key: `card-${name.toLowerCase().replace(/\W+/g, '-')}`,
    isCollapsed: collapsed.includes(name),
    onToggle: () => toggleCard($, name),
  }
}

/** The folded panel's one line: what is running, queued or ready. */
async function foldedSummary($: EngineInterface): Promise<string> {
  const [agents, next, queued] = await Promise.all([
    read($, SUBAGENTS),
    read($, NEXT_SESSION),
    read($, QUEUED),
  ])
  const running = agents.filter(run => run.status === 'running').length
  const parts = [
    running > 0 ? `${running} subagent${running === 1 ? '' : 's'} running` : '',
    queued.length > 0 ? `${queued.length} queued` : '',
    next?.phase === 'ready' ? 'next session ready' : '',
  ]

  return parts.filter(part => part !== '').join('  ·  ')
}

/** The panel's top row: its name, which folds or unfolds it, and when folded, the summary. */
function panelBar($: EngineInterface, t: ElementTable, isFolded: boolean, summary: string) {
  const { Box, Text, Button } = t

  return (
    <Box key={PANEL_KEY} flexDirection="row" gap={2} alignItems="center">
      <Button
        key="clawd-watch-fold"
        plain
        dimColor
        hotkey="h"
        label={`${isFolded ? '▸' : '▾'} ${PANEL_NAME}`}
        onPress={() => setFolded($, !isFolded)}
      />
      {summary !== '' && (
        <Box flexShrink={1} minWidth={0}>
          <Text dimColor wrap="truncate-end">
            {summary}
          </Text>
        </Box>
      )}
    </Box>
  )
}

/**
 * Places this mod's sections in the panel. The first mod to draw adds the panel's top row; folded,
 * that row is all there is, and the other mods add nothing.
 */
async function inPanel(
  $: EngineInterface,
  t: ElementTable,
  above: JSX.Element,
  content: JSX.Element,
) {
  const { Box } = t
  const isFirst = !hasKey(above, PANEL_KEY)
  const gap = hasContent(above) ? SECTION_GAP : 0
  const folded = await isFolded($)
  if (folded && !isFirst) return above

  return (
    <Box flexDirection="column">
      {above}
      {isFirst && (
        <Box flexDirection="column" marginTop={gap}>
          {panelBar($, t, folded, folded ? await foldedSummary($) : '')}
        </Box>
      )}
      {!folded && (
        <Box flexDirection="column" marginTop={isFirst ? 1 : gap}>
          {content}
        </Box>
      )}
    </Box>
  )
}

/** Whether the "Show in" setting (both, desktop or terminal) includes a surface. */
export function runsOn(showIn: string, surface: RenderSurface): boolean {
  if (showIn === 'desktop') return surface !== 'terminal'
  if (showIn === 'terminal') return surface === 'terminal'

  return true
}

/** Whether the mod runs in this session, judged by the surfaces drawing it right now. */
async function isActive($: EngineInterface, showIn: string): Promise<boolean> {
  if (showIn === 'both') return true
  const surfaces = await $.session.surfaces()

  // Until a client attaches (the desktop app, the SDK) nothing rules the mod out.
  return surfaces.length === 0 || surfaces.some(surface => runsOn(showIn, surface))
}

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

async function openAll($: EngineInterface) {
  await refreshSkills($)
  const opened = await $.ui.open({ id: PANE, title: 'Skills' })

  // Where no pane can be placed, the list opens inside the dock instead.
  await update($, isInline, () => !opened.isPlaced)
}

/** A collapsible card's state and toggle, as the desktop app draws sections. */
type Card = { key: string; isCollapsed: boolean; onToggle: () => unknown }

/**
 * A band section. In the desktop app it is a card, as the app's own sidebar draws them: a title
 * whose chevron collapses it, `aside` at the right, the content below. In the terminal its name
 * sits in the shared left column (above the content when narrow), the content beside it and
 * `aside` at the far right.
 */
function section(
  t: ElementTable,
  label: string,
  content: JSX.Element,
  layout: {
    isStacked: boolean
    aside?: JSX.Element
    hasHint?: boolean
    isCentred?: boolean
    card?: Card
  },
) {
  const { Box, Text, Button } = t
  const { isStacked, aside, hasHint = false, isCentred = false, card } = layout
  const hint = hasHint && (
    <Box key={HINT_KEY}>
      <Text dimColor italic>
        {HINT_TEXT}
      </Text>
    </Box>
  )

  if (card) {
    return (
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={CARD_BORDER}
        paddingX={CARD_PADDING.x}
        paddingY={CARD_PADDING.y}
      >
        <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap={2}>
          <Button
            key={card.key}
            plain
            label={`${label}  ${card.isCollapsed ? '›' : '⌄'}`}
            onPress={() => void card.onToggle()}
          />
          {aside}
        </Box>
        {!card.isCollapsed && (
          <Box flexDirection="column" marginTop={1}>
            {content}
          </Box>
        )}
      </Box>
    )
  }

  if (isStacked) {
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap={2}>
          <Box flexDirection="row" gap={2} flexShrink={0}>
            <Text dimColor>{label}</Text>
            {hint}
          </Box>
          {aside}
        </Box>
        {content}
      </Box>
    )
  }

  return (
    <Box flexDirection="row" gap={2} alignItems={isCentred && !hasHint ? 'center' : 'flex-start'}>
      <Box flexDirection="column" flexShrink={0} width={LABEL_WIDTH}>
        <Text dimColor>{label}</Text>
        {hint}
      </Box>
      <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0}>
        {content}
      </Box>
      {aside && <Box flexShrink={0}>{aside}</Box>}
    </Box>
  )
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
      read($, OWN_CARDS),
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
        card: cardFor($, false, collapsed, name),
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

export const register: Register = (on, options) => {
  const showIn = String(options.show_in ?? 'both')

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    local.cwd = e.cwd
    await Promise.all([loadFolded($), loadCards($)]).catch(() => undefined)
    await Promise.all([
      $.command
        .register({
          name: 'dock',
          description: 'Show all your skills; pin favourites to the dock above the prompt',
          argumentHint: '[pin | unpin | hide | unhide <skill>]',
        })
        .catch(() => undefined),
      ensureLoaded($),
    ])
    await refreshSkills($)

    return result
  })

  on('skill.prompt', async ($, e, next) => {
    const result = await next(e)
    $.clock.after(0, () => void recordUse($, e.skill))

    return result
  })

  on('command.run', { command: 'dock' }, async ($, e) => {
    if (!(await isActive($, showIn))) {
      return { text: `skill-dock is set to show in the ${showIn} only. Change it under /config.` }
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

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // Other mods' sections come first; this one follows, nearer the prompt.
    const above = await next(e)
    if (e.props.hasSurvey || !runsOn(showIn, e.surface)) return above

    const [state, inline] = await Promise.all([listState($), read($, isInline)])
    const { pinned, used, list, hiddenList, collapsed, at } = state
    const t = $.ui.resolve(e)
    const { Box, Text, Button } = t
    const isText = e.surface === 'terminal'
    const isStacked = !isText || e.props.bodyColumns < NARROW_COLUMNS
    // The terminal takes no clicks outside fullscreen: say how to reach the buttons.
    const hasHint = isText && e.viewport?.isFullscreen !== true && !hasKey(above, HINT_KEY)

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
      e.props.bodyColumns - (isStacked ? 0 : LABEL_WIDTH + LABEL_GAP + allLabel.length) - ROW_SLACK
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

    return inPanel(
      $,
      t,
      above,
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
        {
          isStacked,
          aside: allButton,
          hasHint,
          isCentred: !inline,
          card: cardFor($, isText, collapsed, DOCK_LABEL),
        },
      ),
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    if (!runsOn(showIn, e.surface)) return next(e)

    const isText = e.surface === 'terminal'

    return skillList($, $.ui.resolve(e), await listState($), { isText, hasCards: !isText })
  })
}
