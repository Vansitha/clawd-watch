import { atom, read, update } from 'claude-code'
import type { ElementTable, EngineInterface, Register, RenderSurface, Timer } from 'claude-code'

import type { QueuedMessage, Panel } from '../types'

const messages = atom({ plugin: 'message-queue', key: 'messages' } as const, [])
const isPaused = atom({ plugin: 'message-queue', key: 'isPaused' } as const, false)

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
const OWN_PANEL = atom({ plugin: 'message-queue', key: 'panel' } as const, null)
const OWN_CARDS = atom({ plugin: 'message-queue', key: 'collapsedCards' } as const, [])
const STORE_CARDS = 'collapsedCards'

const ACCENT = '#d97757'
/** Columns for a message's number, and for its ↑ ✕ controls. */
const INDEX_WIDTH = 2
const CONTROLS_WIDTH = 5
/** Lets the finished turn's last rows land before the next message starts a new turn. */
const SEND_DELAY_MS = 300

const AFTER_TASK = 'Claude will read it after the current task.'
const QUEUED_NOTICE = `Queued. ${AFTER_TASK}`
const WAITING_NOTE = 'Sent one at a time, each after Claude finishes.'
const PAUSED_NOTE = 'Paused because you stopped Claude.'

const local: { isWorking: boolean; isSending: boolean; nextId: number; pendingSend?: Timer } = {
  isWorking: false,
  isSending: false,
  nextId: 1,
}

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

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`
}

function firstLine(text: string): string {
  const lines = text.trim().split('\n')

  return lines.length > 1 ? `${lines[0]} …` : (lines[0] ?? '')
}

async function enqueue($: EngineInterface, text: string) {
  const id = `${await $.clock.now()}-${local.nextId++}`
  const list = await update($, messages, all => [...all, { id, text }])
  $.ui.toast(`Queued (${list.length}). ${AFTER_TASK}`)
}

/** Removes messages; an empty queue is no longer paused. */
async function removeWhere($: EngineInterface, isRemoved: (m: QueuedMessage) => boolean) {
  const list = await update($, messages, all => all.filter(m => !isRemoved(m)))
  if (list.length === 0) await update($, isPaused, () => false)
}

/** Sends the first queued message as the person's own words, as a turn of its own. */
async function sendNext($: EngineInterface) {
  if (local.isSending) return
  const [first] = await read($, messages)
  if (!first) return

  local.isSending = true
  try {
    await update($, messages, all => all.filter(m => m.id !== first.id))
    await $.prompt.submit({ text: first.text, asUser: true })
    await update($, isPaused, () => false)
  } catch {
    // Not sent: put it back at the front rather than lose it.
    await update($, messages, all => [first, ...all])
    $.ui.toast("Couldn't send the queued message; it's still first in the queue.")
  } finally {
    local.isSending = false
  }
}

async function moveUp($: EngineInterface, id: string) {
  await update($, messages, all => {
    const index = all.findIndex(m => m.id === id)
    if (index < 1) return all

    const reordered = [...all]
    ;[reordered[index - 1], reordered[index]] = [all[index]!, all[index - 1]!]

    return reordered
  })
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

function messageRow(
  $: EngineInterface,
  t: ElementTable,
  m: QueuedMessage,
  index: number,
  isText: boolean,
) {
  const { Box, Text, Button } = t
  // Where there's a pointer, a row's controls show only while it's hovered.
  const reveal = isText ? {} : { display: 'none' as const, hover: { display: 'flex' as const } }

  return (
    <Box key={`queue-row-${m.id}`} flexDirection="row" gap={1} alignItems="center">
      <Box width={INDEX_WIDTH} flexShrink={0}>
        <Text color={isText ? ACCENT : undefined} dimColor={!isText}>{`${index + 1}`}</Text>
      </Box>
      <Box flexGrow={1} flexShrink={1} minWidth={0}>
        <Text wrap="truncate-end">{firstLine(m.text)}</Text>
      </Box>
      <Box width={CONTROLS_WIDTH} flexShrink={0} justifyContent="flex-end">
        <Box flexDirection="row" gap={1} {...reveal}>
          {index > 0 && (
            <Button
              key={`queue-up-${m.id}`}
              plain
              dimColor
              label="↑"
              onPress={() => moveUp($, m.id)}
            />
          )}
          <Button
            key={`queue-remove-${m.id}`}
            plain
            dimColor
            label="✕"
            onPress={() => removeWhere($, x => x.id === m.id)}
          />
        </Box>
      </Box>
    </Box>
  )
}

export const register: Register = (on, options) => {
  const showIn = String(options.show_in ?? 'both')

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await Promise.all([loadFolded($), loadCards($)]).catch(() => undefined)
    await $.command
      .register({
        name: 'queue',
        description: 'Queue a message for Claude to read after the current task',
        argumentHint: '<message> | send | clear',
        immediate: true,
      })
      .catch(() => undefined)

    return result
  })

  on('turn.start', ($, e, next) => {
    local.isWorking = true
    return next(e)
  })

  // The queue key (chat:queueSubmit) during a turn holds the message instead of steering.
  on('prompt.submit', async ($, e, next) => {
    const isQueueKey = e.wait && e.origin.kind === 'composer' && e.turnId !== undefined
    if (!isQueueKey || !(await isActive($, showIn))) return next(e)

    if (e.attachments?.length) {
      $.ui.toast("Messages with images can't be queued, so this one was sent now.")
      return next(e)
    }

    await enqueue($, e.text)

    return { drop: QUEUED_NOTICE }
  })
    // If queueing fails, the message is sent as usual rather than lost.
    .catch(($, e, next) => next(e))

  on('command.run', { command: 'queue' }, async ($, e) => {
    if (!(await isActive($, showIn))) {
      return {
        text: `message-queue is set to show in the ${showIn} only. Change it under /config.`,
      }
    }

    const args = (e.args ?? '').trim()
    const count = (await read($, messages)).length

    if (args === 'clear') {
      await removeWhere($, () => true)
      return { text: count ? `Cleared ${plural(count, 'queued message')}.` : 'Nothing is queued.' }
    }
    if (args === 'send') {
      if (local.isWorking) {
        return { text: 'Claude is still working; the next message goes when it finishes.' }
      }
      await sendNext($)
      return { text: 'Sent the next queued message.' }
    }
    if (!args) {
      return {
        text: count
          ? `${plural(count, 'message')} queued.`
          : 'Nothing is queued. Use /queue <message>.',
      }
    }
    if (!local.isWorking && count === 0) {
      await $.prompt.submit({ text: args, asUser: true })
      return { text: 'Claude is idle, so it was sent now.' }
    }

    await enqueue($, args)

    return { text: 'Queued.' }
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) return result

    local.isWorking = false
    const [list, paused] = await Promise.all([read($, messages), read($, isPaused)])
    if (list.length === 0 || !(await isActive($, showIn))) return result

    // One send per finished task: a repeated end replaces the pending send, and a turn that
    // starts first (a message typed just then) goes ahead, its own end sending this.
    local.pendingSend?.cancel()
    if (e.reason === 'answer') {
      if (!paused) {
        local.pendingSend = $.clock.after(SEND_DELAY_MS, () => {
          local.pendingSend = undefined
          if (!local.isWorking) void sendNext($)
        })
      }
    } else {
      // The person stopped the turn: hold the queue until they send it.
      await update($, isPaused, () => true)
    }

    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // Other mods' sections come first; this one follows, nearer the prompt.
    const above = await next(e)
    if (e.props.hasSurvey || !runsOn(showIn, e.surface)) return above

    const [list, paused, collapsed] = await Promise.all([
      read($, messages),
      read($, isPaused),
      read($, OWN_CARDS),
    ])
    if (list.length === 0) return above

    const t = $.ui.resolve(e)
    const { Box, Text, Button } = t
    const isText = e.surface === 'terminal'
    const isStacked = !isText || e.props.bodyColumns < NARROW_COLUMNS
    // The terminal takes no clicks outside fullscreen: say how to reach the buttons.
    const hasHint = isText && e.viewport?.isFullscreen !== true && !hasKey(above, HINT_KEY)
    const status = (
      <Box flexDirection="row" gap={2} alignItems="center" flexShrink={0}>
        <Text dimColor>{paused ? PAUSED_NOTE : WAITING_NOTE}</Text>
        {paused && (
          <Button
            key="queue-send"
            plain={isText || undefined}
            variant="primary"
            hotkey="n"
            label="Send next"
            onPress={() => sendNext($)}
          />
        )}
      </Box>
    )

    return inPanel(
      $,
      t,
      above,
      section(
        t,
        `Queued (${list.length})`,
        // Stacked, the status sits beside the section's name; otherwise under the messages.
        <Box flexDirection="column">
          {list.map((m, index) => messageRow($, t, m, index, isText))}
          {!isStacked && <Box paddingLeft={INDEX_WIDTH + 1}>{status}</Box>}
        </Box>,
        {
          isStacked,
          hasHint,
          card: cardFor($, isText, collapsed, 'Queued'),
          ...(isStacked ? { aside: status } : {}),
        },
      ),
    )
  })
}
