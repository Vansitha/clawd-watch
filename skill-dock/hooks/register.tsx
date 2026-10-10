import { atom, read, update } from 'claude-code'
import type {
  CommandInfo,
  ElementTable,
  EngineInterface,
  Register,
  RenderSurface,
} from 'claude-code'

import type { SkillEntry, Uses } from '../types'

const pins = atom({ plugin: 'skill-dock', key: 'pins' } as const, [])
const uses = atom({ plugin: 'skill-dock', key: 'uses' } as const, {})
const skills = atom({ plugin: 'skill-dock', key: 'skills' } as const, [])
const isInline = atom({ plugin: 'skill-dock', key: 'isInline' } as const, false)

const PANE = 'skill-dock'
// The width of the section-name column every Overwatch mod shares, in cells.
const LABEL_WIDTH = 13
// Narrower than this, a section's name goes on its own line above its content.
const NARROW_COLUMNS = 72
// The "ctrl+x tab" hint's key: the first mod in the band to draw it shows it, the rest see it.
const HINT_KEY = 'overwatch-hint'

/** Whether a drawn tree already holds an element with this key. */
function hasKey(node: unknown, key: string): boolean {
  if (!node || typeof node !== 'object') return false
  const element = node as { props?: { key?: unknown }; children?: unknown[] }

  return element.props?.key === key || (element.children ?? []).some(c => hasKey(c, key))
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
const DAY = 86_400_000
// A use counts half as much each week it ages.
const HALF_LIFE = 7 * DAY
// "Frequently used" looks at the last 30 days; older uses are forgotten after 60.
const WINDOW = 30 * DAY
const KEEP = 60 * DAY
const MAX_USES = 60
const DOCK_FREQUENT = 5
const PANE_FREQUENT = 10

export function score(times: readonly number[] = [], at: number): number {
  return times.reduce((sum, t) => sum + Math.pow(0.5, (at - t) / HALF_LIFE), 0)
}

export function recentCount(times: readonly number[] = [], at: number): number {
  return times.filter(t => at - t <= WINDOW).length
}

/** The most-used skills that are not pinned, most uses first. */
export function frequent(
  list: readonly SkillEntry[],
  pinned: readonly string[],
  used: Uses,
  at: number,
  limit: number,
): SkillEntry[] {
  return (
    list
      .filter(s => !pinned.includes(s.name) && recentCount(used[s.name], at) > 0)
      // Most uses in the last 30 days first; recent use breaks ties.
      .sort(
        (a, b) =>
          recentCount(used[b.name], at) - recentCount(used[a.name], at) ||
          score(used[b.name], at) - score(used[a.name], at),
      )
      .slice(0, limit)
  )
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

async function stored<T>($: EngineInterface, key: string, fallback: T): Promise<T> {
  const value = await $.store.get(key)

  return value === undefined || value === null ? fallback : (value as T)
}

async function loadSaved($: EngineInterface) {
  const savedPins = await stored<string[]>($, 'pins', [])
  const savedUses = await stored<Uses>($, 'uses', {})
  await update($, pins, () => savedPins)
  await update($, uses, () => savedUses)
}

async function refreshSkills($: EngineInterface) {
  const known = await stored<string[]>($, 'knownSkills', [])
  const list: SkillEntry[] = []

  for (const info of await $.command.list()) {
    const group = groupOf(info, known)
    if (group) list.push({ name: info.name, description: info.description, group })
  }

  await update($, skills, () => list)
}

async function recordUse($: EngineInterface, name: string) {
  const at = await $.clock.now()
  const next = await update($, uses, all => {
    const kept = (all[name] ?? []).filter(t => at - t <= KEEP)

    return { ...all, [name]: [...kept, at].slice(-MAX_USES) }
  })
  await $.store.set('uses', next)

  // Built-in skills look like any other built-in command until they are used once.
  const known = await stored<string[]>($, 'knownSkills', [])
  if (!known.includes(name)) {
    await $.store.set('knownSkills', [...known, name])
    await refreshSkills($)
  }

  $.ui.invalidate('command.describe')
}

async function togglePin($: EngineInterface, name: string): Promise<boolean> {
  const next = await update($, pins, list =>
    list.includes(name) ? list.filter(n => n !== name) : [...list, name],
  )
  await $.store.set('pins', next)
  $.ui.invalidate('command.describe')

  return next.includes(name)
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

/** Pinned, most used and every skill available here: the pane, or the list under the dock. */
function skillList(
  $: EngineInterface,
  t: ElementTable,
  state: { list: SkillEntry[]; pinned: string[]; used: Uses; at: number },
) {
  const { Box, Text, Button } = t
  const { list, pinned, used, at } = state
  const byName = new Map(list.map(s => [s.name, s]))
  const entry = (name: string): SkillEntry =>
    byName.get(name) ?? { name, description: '', group: 'Built-in' }
  const mostUsed = frequent(list, [], used, at, PANE_FREQUENT)
  const available = [...list].sort((a, b) => short(a.name).localeCompare(short(b.name)))

  const row = (section: string, s: SkillEntry, meta = '') => {
    const isPinned = pinned.includes(s.name)

    return (
      <Box flexDirection="row" gap={1} alignItems="center">
        <Button
          key={`${section}-star-${s.name}`}
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
            key={`${section}-use-${s.name}`}
            plain
            label={short(s.name)}
            onPress={() => insertSkill($, s.name)}
          />
        </Box>
        {meta !== '' && <Text dimColor>{meta}</Text>}
      </Box>
    )
  }

  const section = (name: string, count: string, first = false) => (
    <Box flexDirection="row" justifyContent="space-between" marginTop={first ? 0 : 1}>
      <Text dimColor bold>
        {name.toUpperCase()}
      </Text>
      <Text dimColor>{count}</Text>
    </Box>
  )

  const empty = (text: string) => (
    <Text dimColor italic>
      {text}
    </Text>
  )

  return (
    <Box flexDirection="column">
      {section('Pinned', pinned.length ? `${pinned.length}` : '', true)}
      {pinned.length === 0 && empty('Click ☆ next to a skill to pin it.')}
      {pinned.map(name => row('pinned', entry(name)))}
      {section('Most used', 'last 30 days')}
      {mostUsed.length === 0 && empty('Skills you use will show up here.')}
      {mostUsed.map(s => row('used', s, `${recentCount(used[s.name], at)}×`))}
      {section('Available here', `${available.length}`)}
      {available.map(s => row('all', s))}
    </Box>
  )
}

export const register: Register = (on, options) => {
  const showIn = String(options.show_in ?? 'both')

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await $.command
      .register({
        name: 'dock',
        description: 'Show all your skills; pin favourites to the dock above the prompt',
        argumentHint: '[pin <skill> | unpin <skill>]',
      })
      .catch(() => undefined)
    await loadSaved($)
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
      const isPinned = (await read($, pins)).includes(skill)
      if ((verb === 'pin') !== isPinned) await togglePin($, skill)

      return { text: `${verb === 'pin' ? 'Pinned' : 'Unpinned'} /${skill}.` }
    }

    await openAll($)

    return { text: 'Opened your skills.' }
  })

  on('command.describe', async ($, e, next) => {
    const result = await next(e)
    if (!(await isActive($, showIn))) return result
    const at = await $.clock.now()
    const count = recentCount((await read($, uses))[e.command], at)

    if ((await read($, pins)).includes(e.command)) {
      return { ...result, description: `★ pinned · ${result.description}` }
    }
    if (count > 0) {
      return { ...result, description: `↻ ${count}× this month · ${result.description}` }
    }

    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // Other mods' sections come first; ours follow, nearer the prompt.
    const above = await next(e)
    if (e.props.hasSurvey || !runsOn(showIn, e.surface)) return above

    const [pinned, used, list, inline] = await Promise.all([
      read($, pins),
      read($, uses),
      read($, skills),
      read($, isInline),
    ])
    const at = await $.clock.now()
    const freq = frequent(list, pinned, used, at, DOCK_FREQUENT)
    const t = $.ui.resolve(e)
    const { Box, Text, Button } = t
    const isDesktop = e.surface === 'desktop'
    const isTerminal = e.surface === 'terminal'
    const isNarrow = e.props.bodyColumns < NARROW_COLUMNS
    const hasAbove = ((above as { children?: unknown[] }).children?.length ?? 0) > 0
    // Without fullscreen the terminal takes no clicks: say once how to reach the buttons.
    const hasHint = isTerminal && e.viewport?.isFullscreen !== true && !hasKey(above, HINT_KEY)
    // In the terminal, chips are plain text spaced apart; brackets around each read as noise.
    const chip = isTerminal ? { plain: true as const } : {}

    // Fit as many chips as the row holds; the rest are a click away in All skills.
    const allLabel = inline ? 'Close' : `All skills (${list.length}) ›`
    let room = e.props.bodyColumns - (isNarrow ? 2 : LABEL_WIDTH + 2) - allLabel.length - 4
    const fits = (label: string) => {
      const width = label.length + (isTerminal ? 2 : 5)
      if (width > room) return false
      room -= width
      return true
    }
    const pinLabels = pinned
      .map(name => ({ name, label: `★ ${short(name)}` }))
      .filter(c => fits(c.label))
    if (pinLabels.length > 0) room -= 3
    const freqLabels = freq
      .map(s => ({ name: s.name, label: short(s.name) }))
      .filter(c => fits(c.label))

    return (
      <Box flexDirection="column">
        {above}
        <Box
          flexDirection={isNarrow ? 'column' : 'row'}
          gap={isNarrow ? 0 : 2}
          alignItems={inline || hasHint || isNarrow ? 'flex-start' : 'center'}
          marginTop={hasAbove ? 1 : 0}
        >
          <Box flexDirection="column" flexShrink={0} {...(isNarrow ? {} : { width: LABEL_WIDTH })}>
            <Text dimColor>Skills</Text>
            {hasHint && (
              <Box key={HINT_KEY}>
                <Text dimColor italic>
                  ctrl+x tab
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
            <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap={2}>
              <Box
                flexDirection="row"
                gap={isTerminal ? 2 : 1}
                alignItems="center"
                flexShrink={1}
                overflow="hidden"
              >
                {pinLabels.length + freqLabels.length === 0 && (
                  <Text dimColor>Pin or use a skill and it shows up here</Text>
                )}
                {pinLabels.map(c => (
                  <Button
                    key={`dock-pin-${c.name}`}
                    {...chip}
                    label={c.label}
                    onPress={() => insertSkill($, c.name)}
                  />
                ))}
                {pinLabels.length > 0 && freqLabels.length > 0 && <Text dimColor>│</Text>}
                {freqLabels.map(c => (
                  <Button
                    key={`dock-freq-${c.name}`}
                    {...chip}
                    dimColor
                    label={c.label}
                    onPress={() => insertSkill($, c.name)}
                  />
                ))}
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
              <Box flexDirection="column" marginTop={isDesktop || isTerminal ? 1 : 0}>
                {skillList($, t, { list, pinned, used, at })}
              </Box>
            )}
          </Box>
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    if (!runsOn(showIn, e.surface)) return next(e)
    const [pinned, used, list] = await Promise.all([read($, pins), read($, uses), read($, skills)])

    return skillList($, $.ui.resolve(e), { list, pinned, used, at: await $.clock.now() })
  })
}
