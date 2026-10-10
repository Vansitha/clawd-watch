import { atom, read, update } from 'claude-code'
import type {
  CommandInfo,
  ElementTable,
  EngineInterface,
  Register,
  RenderSurface,
} from 'claude-code'

import type { SkillEntry, Uses } from '../types'

type Chip = { name: string; label: string; isPinned: boolean }

const pins = atom({ plugin: 'skill-dock', key: 'pins' } as const, [])
const uses = atom({ plugin: 'skill-dock', key: 'uses' } as const, {})
const skills = atom({ plugin: 'skill-dock', key: 'skills' } as const, [])
const isInline = atom({ plugin: 'skill-dock', key: 'isInline' } as const, false)

// Shared by every Clawd Watch mod; keep these identical across them.
const LABEL_WIDTH = 13
const NARROW_COLUMNS = 72
const HINT_KEY = 'clawd-watch-hint'
const HINT_TEXT = 'ctrl+x tab'

const PANE = 'skill-dock'
const STORE_PINS = 'pins'
const STORE_USES = 'uses'
const STORE_KNOWN = 'knownSkills'

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

/** Cells a chip takes beyond its label (a terminal text chip, a drawn button). */
const CHIP_PADDING_TEXT = 2
const CHIP_PADDING_BUTTON = 5
/** Cells for the "│" between pinned and frequent chips. */
const SEPARATOR_CELLS = 3
/** Cells the chip row leaves free: the gap before "All skills" and the band's edge. */
const ROW_SLACK = 4
/** Gap after the label column, or the indent under a narrow section's name. */
const LABEL_GAP = 2

/** Copies of the stored pins, uses and known built-in skills, for hooks that run often. */
const local: {
  pins: string[]
  uses: Uses
  known: string[]
  monthCounts: Record<string, number>
  loaded?: Promise<void>
} = { pins: [], uses: {}, known: [], monthCounts: {} }

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

/** Which group of the list a command belongs to, or undefined when it is not a skill. */
export function groupOf(info: CommandInfo, known: readonly string[]): string | undefined {
  if (info.plugin === 'skill-dock') return undefined
  if (info.source === 'user') return 'Yours & this project'
  if (info.source === 'plugin') return `Plugins · ${info.plugin ?? 'other'}`
  if (!known.includes(info.name)) return undefined

  return info.source === 'mcp' ? 'MCP' : 'Built-in'
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
  const [savedPins, savedUses, known, at] = await Promise.all([
    stored<string[]>($, STORE_PINS, []),
    stored<Uses>($, STORE_USES, {}),
    stored<string[]>($, STORE_KNOWN, []),
    $.clock.now(),
  ])
  Object.assign(local, {
    pins: savedPins,
    uses: savedUses,
    known,
    monthCounts: countRecent(savedUses, at),
  })
  await Promise.all([update($, pins, () => savedPins), update($, uses, () => savedUses)])
}

async function refreshSkills($: EngineInterface) {
  const list: SkillEntry[] = []
  for (const info of await $.command.list()) {
    const group = groupOf(info, local.known)
    if (group) list.push({ name: info.name, description: info.description, group })
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

/** A band section: its name in the shared left column (above it when narrow), content beside. */
function section(
  t: ElementTable,
  label: string,
  content: JSX.Element,
  layout: { isNarrow: boolean; hasHint?: boolean; isCentred?: boolean },
) {
  const { Box, Text } = t
  const { isNarrow, hasHint = false, isCentred = false } = layout

  return (
    <Box
      flexDirection={isNarrow ? 'column' : 'row'}
      gap={isNarrow ? 0 : 2}
      alignItems={isCentred && !hasHint && !isNarrow ? 'center' : 'flex-start'}
    >
      <Box flexDirection="column" flexShrink={0} {...(isNarrow ? {} : { width: LABEL_WIDTH })}>
        <Text dimColor>{label}</Text>
        {hasHint && (
          <Box key={HINT_KEY}>
            <Text dimColor italic>
              {HINT_TEXT}
            </Text>
          </Box>
        )}
      </Box>
      <Box
        flexDirection="column"
        flexGrow={1}
        flexShrink={1}
        minWidth={0}
        paddingLeft={isNarrow ? 2 : 0}
      >
        {content}
      </Box>
    </Box>
  )
}

function skillRow(
  $: EngineInterface,
  t: ElementTable,
  list: string,
  s: SkillEntry,
  isPinned: boolean,
  meta = '',
) {
  const { Box, Text, Button } = t

  return (
    <Box flexDirection="row" gap={1} alignItems="center">
      <Button
        key={`${list}-star-${s.name}`}
        plain
        dimColor={!isPinned}
        label={isPinned ? '★' : '☆'}
        onPress={async () => {
          const nowPinned = await togglePin($, s.name)
          $.ui.toast(`${nowPinned ? 'Pinned' : 'Unpinned'} /${short(s.name)}`)
        }}
      />
      <Box flexGrow={1} flexShrink={1} minWidth={0}>
        <Button
          key={`${list}-use-${s.name}`}
          plain
          label={short(s.name)}
          onPress={() => insertSkill($, s.name)}
        />
      </Box>
      {meta !== '' && <Text dimColor>{meta}</Text>}
    </Box>
  )
}

/** Pinned, most used and every skill available here: the pane, or the list under the dock. */
function skillList(
  $: EngineInterface,
  t: ElementTable,
  state: { list: SkillEntry[]; pinned: string[]; used: Uses; at: number },
) {
  const { Box, Text } = t
  const { list, pinned, used, at } = state
  const byName = new Map(list.map(s => [s.name, s]))
  const entry = (name: string): SkillEntry =>
    byName.get(name) ?? { name, description: '', group: 'Built-in' }
  const mostUsed = frequent(list, [], used, at, PANE_FREQUENT)
  const available = [...list].sort((a, b) => short(a.name).localeCompare(short(b.name)))
  const row = (listName: string, s: SkillEntry, meta?: string) =>
    skillRow($, t, listName, s, pinned.includes(s.name), meta)

  const heading = (name: string, detail: string, isFirst = false) => (
    <Box flexDirection="row" justifyContent="space-between" marginTop={isFirst ? 0 : 1}>
      <Text dimColor bold>
        {name.toUpperCase()}
      </Text>
      <Text dimColor>{detail}</Text>
    </Box>
  )
  const empty = (text: string) => (
    <Text dimColor italic>
      {text}
    </Text>
  )

  return (
    <Box flexDirection="column">
      {heading('Pinned', pinned.length ? `${pinned.length}` : '', true)}
      {pinned.length === 0 && empty('Click ☆ next to a skill to pin it.')}
      {pinned.map(name => row('pinned', entry(name)))}
      {heading('Most used', `last ${WINDOW_DAYS} days`)}
      {mostUsed.length === 0 && empty('Skills you use will show up here.')}
      {mostUsed.map(s => row('used', s, `${recentCount(used[s.name], at)}×`))}
      {heading('Available here', `${available.length}`)}
      {available.map(s => row('all', s))}
    </Box>
  )
}

/** The pinned and frequent chips that fit the dock, with the separator between the two kinds. */
function chipRow($: EngineInterface, t: ElementTable, chips: Chip[], isText: boolean) {
  const { Text, Button } = t
  const row: JSX.Element[] = []

  chips.forEach((chip, index) => {
    if (!chip.isPinned && chips[index - 1]?.isPinned) row.push(<Text dimColor>│</Text>)
    row.push(
      <Button
        key={`dock-${chip.isPinned ? 'pin' : 'freq'}-${chip.name}`}
        // In the terminal, chips are plain text spaced apart; brackets around each read as noise.
        plain={isText || undefined}
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
    await Promise.all([
      $.command
        .register({
          name: 'dock',
          description: 'Show all your skills; pin favourites to the dock above the prompt',
          argumentHint: '[pin <skill> | unpin <skill>]',
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
    if ((verb === 'pin' || verb === 'unpin') && name) {
      const skill = name.replace(/^\//, '')
      if ((verb === 'pin') !== local.pins.includes(skill)) await togglePin($, skill)

      return { text: `${verb === 'pin' ? 'Pinned' : 'Unpinned'} /${skill}.` }
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

    const [pinned, used, list, inline, at] = await Promise.all([
      read($, pins),
      read($, uses),
      read($, skills),
      read($, isInline),
      $.clock.now(),
    ])
    const t = $.ui.resolve(e)
    const { Box, Text, Button } = t
    const isText = e.surface === 'terminal'
    const isNarrow = e.props.bodyColumns < NARROW_COLUMNS
    // The terminal takes no clicks outside fullscreen: say how to reach the buttons.
    const hasHint = isText && e.viewport?.isFullscreen !== true && !hasKey(above, HINT_KEY)

    // As many chips as the row holds; the rest are a click away in All skills.
    const allLabel = inline ? 'Close' : `All skills (${list.length}) ›`
    const room =
      e.props.bodyColumns -
      (isNarrow ? LABEL_GAP : LABEL_WIDTH + LABEL_GAP) -
      allLabel.length -
      ROW_SLACK
    const chips = fitChips(
      [
        ...pinned.map(name => ({ name, label: `★ ${short(name)}`, isPinned: true })),
        ...frequent(list, pinned, used, at, DOCK_FREQUENT).map(s => ({
          name: s.name,
          label: short(s.name),
          isPinned: false,
        })),
      ],
      room,
      isText ? CHIP_PADDING_TEXT : CHIP_PADDING_BUTTON,
    )

    return (
      <Box flexDirection="column">
        {above}
        <Box flexDirection="column" marginTop={hasContent(above) ? 1 : 0}>
          {section(
            t,
            'Skills',
            <Box flexDirection="column">
              <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap={2}>
                <Box
                  flexDirection="row"
                  gap={isText ? 2 : 1}
                  alignItems="center"
                  flexShrink={1}
                  overflow="hidden"
                >
                  {chips.length === 0 && (
                    <Text dimColor>Pin or use a skill and it shows up here</Text>
                  )}
                  {chipRow($, t, chips, isText)}
                </Box>
                <Box flexShrink={0}>
                  <Button
                    key="dock-all"
                    plain
                    dimColor
                    label={allLabel}
                    onPress={() => (inline ? update($, isInline, () => false) : openAll($))}
                  />
                </Box>
              </Box>
              {inline && (
                <Box flexDirection="column" marginTop={1}>
                  {skillList($, t, { list, pinned, used, at })}
                </Box>
              )}
            </Box>,
            { isNarrow, hasHint, isCentred: !inline },
          )}
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    if (!runsOn(showIn, e.surface)) return next(e)

    const [pinned, used, list, at] = await Promise.all([
      read($, pins),
      read($, uses),
      read($, skills),
      $.clock.now(),
    ])

    return skillList($, $.ui.resolve(e), { list, pinned, used, at })
  })
}
