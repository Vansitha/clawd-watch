import { atom, read, update } from 'claude-code'
import type { ElementTable, EngineInterface, Register } from 'claude-code'

import {
  PANE,
  closePane,
  isPaneUnavailable,
  openPane,
  paneClosed,
  paneState,
  setPaneView,
  syncPane,
  wantsPane,
} from './pane.js'
import {
  queueSections,
  queueSummary,
  queueTurnComplete,
  registerQueue,
  startQueue,
} from './queue.js'
import {
  HINT_TEXT,
  NARROW_COLUMNS,
  SECTION_GAP,
  collapsedList,
  isActive,
  loadCards,
  runsOn,
} from './shared.js'
import type { View } from './shared.js'
import { allSkills, registerSkills, skillsSections, startSkills } from './skills.js'
import {
  registerSubagents,
  startSubagents,
  subagentSections,
  subagentSummary,
  subagentsTurnComplete,
} from './subagents.js'

const PANEL_NAME = 'Clawd Watch'
const PANEL_KEY = 'clawd-watch-panel'
const STORE_FOLDED = 'folded'
/** True while the band above the prompt is folded to one line. */
const isFolded = atom({ plugin: 'clawd-watch', key: 'isFolded' } as const, false)

/** The mods Clawd Watch was split into before, whose saved data it takes over once. */
const OLD_MODS = ['session-hud', 'message-queue', 'skill-dock']
const OLD_STORE_DIR = '.claude/plugins/store'
const STORE_MIGRATED = 'migratedFromMods'
const MIGRATED_KEYS = [
  'pins',
  'uses',
  'knownSkills',
  'hidden',
  'agentHistory',
  'autoSuggest',
  'collapsedCards',
]

/** Whether another plugin drew anything above Clawd Watch. */
function hasContent(tree: unknown): boolean {
  return ((tree as { children?: unknown[] }).children?.length ?? 0) > 0
}

/**
 * Takes over what the old session-hud, message-queue and skill-dock mods saved (pins, skill use,
 * subagent timings), once, keeping anything Clawd Watch already has.
 */
async function migrate($: EngineInterface) {
  if ((await $.store.get(STORE_MIGRATED)) === true) return
  const home = await $.env.get('HOME').catch(() => undefined)
  const dir = home && `${home}/${OLD_STORE_DIR}`
  const files = dir ? await $.fs.list(dir).catch(() => []) : []

  for (const file of files) {
    const isOld = OLD_MODS.some(mod => file.name.startsWith(`${mod}_`))
    if (!isOld || !file.name.endsWith('.json')) continue
    const saved = await $.fs
      .read(`${dir}/${file.name}`)
      .then(text => JSON.parse(text) as Record<string, unknown>)
      .catch(() => undefined)
    for (const key of MIGRATED_KEYS) {
      if (saved?.[key] !== undefined && (await $.store.get(key)) === undefined) {
        await $.store.set(key, saved[key])
      }
    }
  }
  await $.store.set(STORE_MIGRATED, true)
}

async function loadFolded($: EngineInterface) {
  const stored = await $.store.get(STORE_FOLDED)
  if (typeof stored === 'boolean') await update($, isFolded, () => stored)
}

async function setFolded($: EngineInterface, folded: boolean) {
  await Promise.all([update($, isFolded, () => folded), $.store.set(STORE_FOLDED, folded)])
}

/** One line on what's running, queued or ready, for the folded band and the closed pane. */
async function summary($: EngineInterface): Promise<string> {
  const parts = await Promise.all([subagentSummary($), queueSummary($)])

  return parts.flat().join('  ·  ')
}

/** The panel's top row: its name, which opens, folds or unfolds it, then what's going on. */
function panelBar(
  t: ElementTable,
  bar: { label: string; summary: string; action?: string; hint?: string; onPress: () => unknown },
) {
  const { Box, Text, Button } = t

  return (
    <Box key={PANEL_KEY} flexDirection="row" gap={2} alignItems="center">
      <Button
        key="clawd-watch-fold"
        plain
        dimColor
        hotkey="h"
        label={bar.label}
        onPress={() => void bar.onPress()}
      />
      <Box flexGrow={1} flexShrink={1} minWidth={0}>
        {bar.summary !== '' && (
          <Text dimColor wrap="truncate-end">
            {bar.summary}
          </Text>
        )}
      </Box>
      {bar.action && (
        <Button
          key="clawd-watch-open"
          plain
          dimColor
          label={bar.action}
          onPress={() => void bar.onPress()}
        />
      )}
      {bar.hint && (
        <Text dimColor italic>
          {bar.hint}
        </Text>
      )}
    </Box>
  )
}

/** Every section with something to show, in the panel's order. */
async function allSections($: EngineInterface, t: ElementTable, view: View) {
  const groups = await Promise.all([
    subagentSections($, t, view),
    queueSections($, t, view),
    skillsSections($, t, view),
  ])

  return groups.flat()
}

export const register: Register = (on, options) => {
  const showIn = String(options.show_in ?? 'both')

  on('session.start', async ($, e, next) => {
    // Before anything loads what it saved, take over what the old mods saved.
    await migrate($).catch(() => undefined)
    const result = await next(e)
    await Promise.all([
      loadFolded($).catch(() => undefined),
      loadCards($).catch(() => undefined),
      $.command
        .register({ name: 'watch', description: 'Open or close the Clawd Watch panel' })
        .catch(() => undefined),
      startSubagents($),
      startQueue($),
      startSkills($, e.cwd),
    ])

    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    await Promise.all([subagentsTurnComplete($, e, showIn), queueTurnComplete($, e, showIn)])

    return result
  })

  registerSubagents(on, showIn)
  registerQueue(on, showIn)
  registerSkills(on, showIn)

  // The desktop app shows the panel in its sidebar, unless the person closed it there.
  on('session.attach', async ($, e, next) => {
    const result = await next(e)
    if (e.surface !== 'terminal' && runsOn(showIn, e.surface) && (await wantsPane($))) {
      await openPane($, 'overview', { isAsked: false }).catch(() => undefined)
    } else {
      await syncPane($).catch(() => undefined)
    }

    return result
  })

  on('ui.close', async ($, e, next) => {
    const result = await next(e)
    if (e.id === PANE) await paneClosed($, e.origin.kind !== 'unload')

    return result
  })

  on('command.run', { command: 'watch' }, async ($, e) => {
    if (!(await isActive($, showIn))) {
      return { text: `Clawd Watch is set to show in the ${showIn} only. Change it under /config.` }
    }
    if ((await paneState($)).isShown) {
      await closePane($)
      return { text: 'Closed the Clawd Watch panel.' }
    }
    const isPlaced = await openPane($)

    return {
      text: isPlaced
        ? 'Opened the Clawd Watch panel.'
        : "Clawd Watch can't open a side panel here, so it stays above the prompt.",
    }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // Other plugins' rows come first; Clawd Watch follows, nearest the prompt.
    const above = await next(e)
    if (e.props.hasSurvey || !runsOn(showIn, e.surface)) return above

    const t = $.ui.resolve(e)
    const { Box } = t
    const isText = e.surface === 'terminal'
    const [pane, folded, unavailable, collapsed] = await Promise.all([
      paneState($),
      read($, isFolded),
      isPaneUnavailable($),
      collapsedList($),
    ])
    const gap = hasContent(above) ? SECTION_GAP : 0
    const withBand = (band: JSX.Element) => (
      <Box flexDirection="column">
        {above}
        <Box flexDirection="column" marginTop={gap}>
          {band}
        </Box>
      </Box>
    )

    // While the pane is drawn beside the transcript, it has everything.
    if (pane.isShown && e.viewport?.isFullscreen !== false) return above

    // The desktop app keeps one line here, which opens the pane.
    if (!isText && !unavailable) {
      return withBand(
        panelBar(t, {
          label: `▸ ${PANEL_NAME}`,
          summary: await summary($),
          action: 'Open panel',
          onPress: () => openPane($),
        }),
      )
    }

    const view: View = {
      surface: e.surface,
      isText,
      isStacked: !isText || e.props.bodyColumns < NARROW_COLUMNS,
      columns: e.props.bodyColumns,
      maxRows: e.props.maxRows,
      collapsed,
    }
    const sections = folded ? [] : await allSections($, t, view)
    if (!folded && sections.length === 0) return above
    // The terminal takes no clicks outside fullscreen: say how to reach the buttons.
    const hint = isText && e.viewport?.isFullscreen !== true ? HINT_TEXT : undefined

    return withBand(
      <Box flexDirection="column" gap={SECTION_GAP}>
        {panelBar(t, {
          label: `${folded ? '▸' : '▾'} ${PANEL_NAME}`,
          summary: folded ? await summary($) : '',
          ...(hint ? { hint } : {}),
          onPress: () => setFolded($, !folded),
        })}
        {sections}
      </Box>,
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    if (!runsOn(showIn, e.surface)) return next(e)

    const t = $.ui.resolve(e)
    const { Box, Text, Button } = t
    const view: View = {
      surface: e.surface,
      isText: e.surface === 'terminal',
      isStacked: true,
      columns: e.props.bodyColumns,
      maxRows: e.props.scroll.bodyRows,
      collapsed: await collapsedList($),
    }

    if ((await paneState($)).view === 'skills') {
      return (
        <Box flexDirection="column" gap={SECTION_GAP}>
          <Box flexDirection="row">
            <Button
              key="pane-back"
              plain
              dimColor
              label="‹ Back"
              onPress={() => setPaneView($, 'overview')}
            />
          </Box>
          {await allSkills($, t, view)}
        </Box>
      )
    }

    const sections = await allSections($, t, view)
    const isQuiet = (await summary($)) === ''

    return (
      <Box flexDirection="column" gap={SECTION_GAP}>
        {isQuiet && (
          <Text dimColor>
            Subagents, queued messages and handoffs show up here while Claude works.
          </Text>
        )}
        {sections}
      </Box>
    )
  })
}
