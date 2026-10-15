import { atom, read, update } from 'claude-code'
import type { ElementTable, EngineInterface, On, Timer, TurnCompleteInput } from 'claude-code'

import type { QueuedMessage } from '../types'
import { ACCENT, COMPACT_COLUMNS, cardFor, isActive, plural, section } from './shared.js'
import type { View } from './shared.js'

const messages = atom({ plugin: 'clawd-watch', key: 'messages' } as const, [])
const isPaused = atom({ plugin: 'clawd-watch', key: 'isPaused' } as const, false)

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

/** The hooks behind the Queued section, the queue key and /queue. */
export function registerQueue(on: On, showIn: string) {
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
        text: `Clawd Watch is set to show in the ${showIn} only. Change it under /config.`,
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
}

/** The Queued section, when anything is queued. */
export async function queueSections(
  $: EngineInterface,
  t: ElementTable,
  view: View,
): Promise<JSX.Element[]> {
  const [list, paused] = await Promise.all([read($, messages), read($, isPaused)])
  if (list.length === 0) return []

  const { Box, Text, Button } = t
  // The status sits beside the section's name where there's room, otherwise under the messages.
  const isBeside = view.isStacked && view.columns >= COMPACT_COLUMNS
  const status = (
    <Box flexDirection="row" gap={2} alignItems="center" flexShrink={0}>
      <Text dimColor>{paused ? PAUSED_NOTE : WAITING_NOTE}</Text>
      {paused && (
        <Button
          key="queue-send"
          plain={view.isText || undefined}
          variant="primary"
          hotkey="n"
          label="Send next"
          onPress={() => sendNext($)}
        />
      )}
    </Box>
  )

  return [
    section(
      t,
      `Queued (${list.length})`,
      <Box flexDirection="column">
        {list.map((m, index) => messageRow($, t, m, index, view.isText))}
        {!isBeside && (
          <Box paddingLeft={INDEX_WIDTH + 1} marginTop={view.isText ? 0 : 1}>
            {status}
          </Box>
        )}
      </Box>,
      {
        isStacked: view.isStacked,
        card: cardFor($, view, 'Queued'),
        ...(isBeside ? { aside: status } : {}),
      },
    ),
  ]
}

/** What the folded panel says about the queue. */
export async function queueSummary($: EngineInterface): Promise<string[]> {
  const count = (await read($, messages)).length

  return count > 0 ? [`${count} queued`] : []
}

/** At session start: /queue. */
export async function startQueue($: EngineInterface) {
  await $.command
    .register({
      name: 'queue',
      description: 'Queue a message for Claude to read after the current task',
      argumentHint: '<message> | send | clear',
      immediate: true,
    })
    .catch(() => undefined)
}

/** When a turn ends: send the next queued message, or hold the queue if the person stopped Claude. */
export async function queueTurnComplete($: EngineInterface, e: TurnCompleteInput, showIn: string) {
  if (e.agentId !== undefined) return

  local.isWorking = false
  const [list, paused] = await Promise.all([read($, messages), read($, isPaused)])
  if (list.length === 0 || !(await isActive($, showIn))) return

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
}
