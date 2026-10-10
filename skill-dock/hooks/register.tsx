import { atom, read, update } from 'claude-code'
import type { CommandInfo, ElementTable, EngineInterface, Register } from 'claude-code'

import type { SkillEntry, Uses } from '../types'

const pins = atom({ plugin: 'skill-dock', key: 'pins' } as const, [])
const uses = atom({ plugin: 'skill-dock', key: 'uses' } as const, {})
const skills = atom({ plugin: 'skill-dock', key: 'skills' } as const, [])
const filter = atom({ plugin: 'skill-dock', key: 'filter' } as const, '')
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
const PANE_FREQUENT = 8

const GROUP_ORDER = ['Yours & this project', 'Plugins', 'Built-in', 'MCP']

// Claude's orange, matching session-hud; reads on light and dark backgrounds.
const ACCENT = '#d97757'

export function score(times: readonly number[] = [], at: number): number {
  return times.reduce((sum, t) => sum + Math.pow(0.5, (at - t) / HALF_LIFE), 0)
}

export function recentCount(times: readonly number[] = [], at: number): number {
  return times.filter(t => at - t <= WINDOW).length
}

/** The most-used skills that are not pinned, best first. */
export function frequent(
  list: readonly SkillEntry[],
  pinned: readonly string[],
  used: Uses,
  at: number,
  limit: number,
): SkillEntry[] {
  return list
    .filter(s => !pinned.includes(s.name) && recentCount(used[s.name], at) > 0)
    .sort((a, b) => score(used[b.name], at) - score(used[a.name], at))
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

function ago(times: readonly number[] = [], at: number): string {
  if (times.length === 0) return 'not used yet'
  const days = Math.floor((at - Math.max(...times)) / DAY)

  return days <= 0 ? 'today' : days === 1 ? 'yesterday' : `${days}d ago`
}

function matches(s: SkillEntry, query: string): boolean {
  const q = query.trim().toLowerCase()

  return !q || s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q)
}

function groupRank(group: string): number {
  const i = GROUP_ORDER.findIndex(prefix => group.startsWith(prefix))

  return i === -1 ? GROUP_ORDER.length : i
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

/** The pinned, frequent and full lists, drawn in the pane or under the dock. */
function skillList(
  $: EngineInterface,
  t: ElementTable,
  state: { list: SkillEntry[]; pinned: string[]; used: Uses; query: string; at: number },
) {
  const { Box, Text, Button } = t
  // The mobile app draws no text field, so its list has no filter.
  const Input = 'Input' in t ? t.Input : undefined
  const { list, pinned, used, query, at } = state
  const byName = new Map(list.map(s => [s.name, s]))
  const entry = (name: string): SkillEntry =>
    byName.get(name) ?? { name, description: '', group: 'Built-in' }

  const pinnedShown = pinned.map(entry).filter(s => matches(s, query))
  const freqShown = frequent(list, pinned, used, at, PANE_FREQUENT).filter(s => matches(s, query))
  const top = Math.max(0.01, ...freqShown.map(s => score(used[s.name], at)))
  const all = list.filter(s => matches(s, query))
  const groups = [...new Set(all.map(s => s.group))].sort(
    (a, b) => groupRank(a) - groupRank(b) || a.localeCompare(b),
  )

  // A short rounded bar where the surface draws SVG, a run of blocks in the terminal.
  const meter = (key: string, fraction: number) => {
    const f = Math.min(1, Math.max(0, fraction))
    if ('Svg' in t) {
      const { Svg } = t
      const filled = Math.max(5, Math.round(56 * f))
      const source =
        `<svg xmlns="http://www.w3.org/2000/svg" width="56" height="5" viewBox="0 0 56 5">` +
        `<rect width="56" height="5" rx="2.5" fill="#8b8b8b" fill-opacity="0.25"/>` +
        `<rect width="${filled}" height="5" rx="2.5" fill="${ACCENT}"/></svg>`

      return (
        <Svg
          key={key}
          source={source}
          alt={`${Math.round(f * 100)}% of your top skill`}
          width={56}
          height={5}
        />
      )
    }
    const cells = Math.max(1, Math.round(f * 8))

    return (
      <Box flexDirection="row">
        <Text color={ACCENT}>{'━'.repeat(cells)}</Text>
        <Text dimColor>{'─'.repeat(8 - cells)}</Text>
      </Box>
    )
  }

  const row = (section: string, s: SkillEntry, meta: string, share?: number) => {
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
            $.ui.toast(`${nowPinned ? 'Pinned' : 'Unpinned'} /${s.name}`)
          }}
        />
        <Button
          key={`${section}-use-${s.name}`}
          plain
          label={short(s.name)}
          onPress={() => insertSkill($, s.name)}
        />
        <Box flexGrow={1} flexShrink={1} minWidth={0} marginLeft={1}>
          <Text dimColor wrap="truncate-end">
            {s.description}
          </Text>
        </Box>
        {share !== undefined && meter(`${section}-bar-${s.name}`, share)}
        {meta !== '' && <Text dimColor>{meta}</Text>}
      </Box>
    )
  }

  const title = (left: string, right = '') => (
    <Box flexDirection="row" justifyContent="space-between" marginTop={1}>
      <Text dimColor bold>
        {left.toUpperCase()}
      </Text>
      {right !== '' && <Text dimColor>{right}</Text>}
    </Box>
  )

  const empty = (text: string) => (
    <Box paddingLeft={2}>
      <Text dimColor italic>
        {text}
      </Text>
    </Box>
  )

  return (
    <Box flexDirection="column">
      {Input && (
        <Input
          key="filter"
          placeholder="Filter skills…"
          value={query}
          submitLabel="insert first"
          onInput={value => void update($, filter, () => value)}
          onSubmit={value => {
            const first = [...pinnedShown, ...freqShown, ...list].find(s => matches(s, value))
            if (first) void insertSkill($, first.name)
          }}
        />
      )}
      {title('Pinned', pinned.length ? `${pinned.length}` : '')}
      {pinnedShown.length === 0 &&
        empty(query ? 'No pinned skills match.' : 'Click ☆ next to any skill to pin it.')}
      {pinnedShown.map(s => row('pinned', s, used[s.name]?.length ? ago(used[s.name], at) : ''))}
      {title('Frequently used', 'last 30 days')}
      {freqShown.length === 0 &&
        empty(query ? 'Nothing matches.' : 'Skills you use will show up here.')}
      {freqShown.map(s =>
        row('freq', s, `${recentCount(used[s.name], at)}×`, score(used[s.name], at) / top),
      )}
      {title('All skills', `${list.length}`)}
      {all.length === 0 && empty(`No skills match "${query}".`)}
      {groups.map((group, index) => (
        <Box flexDirection="column" marginTop={index === 0 ? 0 : 1}>
          <Text dimColor>{group}</Text>
          {all
            .filter(s => s.group === group)
            .sort((a, b) => a.name.localeCompare(b.name))
            .map(s => row('all', s, ''))}
        </Box>
      ))}
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

    const [pinned, used, list, inline, query] = await Promise.all([
      read($, pins),
      read($, uses),
      read($, skills),
      read($, isInline),
      read($, filter),
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
            {skillList($, t, { list, pinned, used, query, at })}
          </Box>
        )}
        {below}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const [pinned, used, list, query] = await Promise.all([
      read($, pins),
      read($, uses),
      read($, skills),
      read($, filter),
    ])

    return skillList($, $.ui.resolve(e), { list, pinned, used, query, at: await $.clock.now() })
  })
}
