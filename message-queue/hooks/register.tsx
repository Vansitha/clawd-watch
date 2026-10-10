import { atom, read, update } from 'claude-code'
import type { ElementTable, EngineInterface, Register, RenderSurface } from 'claude-code'

import type { QueuedMessage } from '../types'

const messages = atom({ plugin: 'message-queue', key: 'messages' } as const, [])
const isPaused = atom({ plugin: 'message-queue', key: 'isPaused' } as const, false)

// Shared by every Clawd Watch mod; keep these identical across them.
const LABEL_WIDTH = 13
const NARROW_COLUMNS = 72
const HINT_KEY = 'clawd-watch-hint'
const HINT_TEXT = 'ctrl+x tab'

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

const local = { isWorking: false, isSending: false, nextId: 1 }

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

function messageRow($: EngineInterface, t: ElementTable, m: QueuedMessage, index: number) {
  const { Box, Text, Button } = t

  return (
    <Box flexDirection="row" gap={1} alignItems="center">
      <Box width={INDEX_WIDTH} flexShrink={0}>
        <Text color={ACCENT}>{`${index + 1}`}</Text>
      </Box>
      <Box flexGrow={1} flexShrink={1} minWidth={0}>
        <Text wrap="truncate-end">{firstLine(m.text)}</Text>
      </Box>
      <Box
        flexDirection="row"
        gap={1}
        width={CONTROLS_WIDTH}
        flexShrink={0}
        justifyContent="flex-end"
      >
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
  )
}

export const register: Register = (on, options) => {
  const showIn = String(options.show_in ?? 'both')

  on('session.start', async ($, e, next) => {
    const result = await next(e)
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

    if (e.reason === 'answer') {
      if (!paused) $.clock.after(SEND_DELAY_MS, () => void sendNext($))
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

    const [list, paused] = await Promise.all([read($, messages), read($, isPaused)])
    if (list.length === 0) return above

    const t = $.ui.resolve(e)
    const { Box, Text, Button } = t
    const isText = e.surface === 'terminal'
    // The terminal takes no clicks outside fullscreen: say how to reach the buttons.
    const hasHint = isText && e.viewport?.isFullscreen !== true && !hasKey(above, HINT_KEY)

    return (
      <Box flexDirection="column">
        {above}
        <Box flexDirection="column" marginTop={hasContent(above) ? 1 : 0}>
          {section(
            t,
            `Queued (${list.length})`,
            <Box flexDirection="column">
              {list.map((m, index) => messageRow($, t, m, index))}
              <Box flexDirection="row" gap={2} alignItems="center" paddingLeft={INDEX_WIDTH + 1}>
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
            </Box>,
            { isNarrow: e.props.bodyColumns < NARROW_COLUMNS, hasHint },
          )}
        </Box>
      </Box>
    )
  })
}
