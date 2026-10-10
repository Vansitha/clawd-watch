import { atom, read, update } from 'claude-code'
import type { CommandInfo, ElementTable, EngineInterface, Register } from 'claude-code'

import type { SkillEntry, Uses } from '../types'

const pins = atom({ plugin: 'skill-dock', key: 'pins' } as const, [])
const uses = atom({ plugin: 'skill-dock', key: 'uses' } as const, {})
const skills = atom({ plugin: 'skill-dock', key: 'skills' } as const, [])
const isInline = atom({ plugin: 'skill-dock', key: 'isInline' } as const, false)

const PANE = 'skill-dock'
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
  return list
    .filter(s => !pinned.includes(s.name) && recentCount(used[s.name], at) > 0)
    // Most uses in the last 30 days first; recent use breaks ties.
    .sort(
      (a, b) =>
        recentCount(used[b.name], at) - recentCount(used[a.name], at) ||
        score(used[b.name], at) - score(used[a.name], at),
    )
    .slice(0, limit)
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

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)

    await $.command.register({
      name: 'dock',
      description: 'Show all your skills; pin favourites to the dock above the prompt',
      argumentHint: '[pin <skill> | unpin <skill>]',
    })
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
    const below = await next(e)
    if (e.props.hasSurvey) return below

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
    // Fit as many chips as the row holds; the rest are a click away in All skills.
    const allLabel = inline ? 'Close' : `All skills (${list.length}) ›`
    let room = e.props.bodyColumns - 'Skills'.length - allLabel.length - 8
    const fits = (label: string) => {
      const width = label.length + 5
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

    const pinChips = pinLabels.map(c => (
      <Button key={`dock-pin-${c.name}`} label={c.label} onPress={() => insertSkill($, c.name)} />
    ))
    const freqChips = freqLabels.map(c => (
      <Button
        key={`dock-freq-${c.name}`}
        dimColor
        label={c.label}
        onPress={() => insertSkill($, c.name)}
      />
    ))
    // Leave a row between the dock and the next mod's rows, when there are any.
    const hasBelow = ((below as { children?: unknown[] }).children?.length ?? 0) > 0

    return (
      <Box flexDirection="column">
        <Box
          flexDirection="row"
          justifyContent="space-between"
          alignItems="center"
          gap={2}
          marginBottom={isDesktop && (hasBelow || inline) ? 1 : 0}
        >
          <Box flexDirection="row" gap={1} alignItems="center" flexShrink={1} overflow="hidden">
            <Text bold dimColor>
              Skills
            </Text>
            {pinChips.length + freqChips.length === 0 && (
              <Text dimColor italic>
                Pin or use a skill and it appears here
              </Text>
            )}
            {pinChips}
            {pinChips.length > 0 && freqChips.length > 0 && <Text dimColor>│</Text>}
            {freqChips}
          </Box>
          <Button
            key="dock-all"
            plain
            dimColor
            label={allLabel}
            onPress={() => (inline ? update($, isInline, () => false) : openAll($))}
          />
        </Box>
        {inline && (
          <Box flexDirection="column" marginBottom={isDesktop && hasBelow ? 1 : 0}>
            {skillList($, t, { list, pinned, used, at })}
          </Box>
        )}
        {below}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const [pinned, used, list] = await Promise.all([read($, pins), read($, uses), read($, skills)])

    return skillList($, $.ui.resolve(e), { list, pinned, used, at: await $.clock.now() })
  })
}
