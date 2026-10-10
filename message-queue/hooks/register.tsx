import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { QueuedMessage } from '../types'

const messages = atom({ plugin: 'message-queue', key: 'messages' } as const, [])
const isPaused = atom({ plugin: 'message-queue', key: 'isPaused' } as const, false)

const ACCENT = '#d97757'
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

/** Whether the mod runs on a surface, by its "Show in" setting: both, desktop or terminal. */
export function runsOn(showIn: string, surface: string | null | undefined): boolean {
  if (showIn === 'desktop')
    return surface !== 'terminal' && surface !== null && surface !== undefined
  if (showIn === 'terminal')
    return surface === 'terminal' || surface === null || surface === undefined

  return true
}

// isActive is false in a session on a surface the "Show in" setting leaves out.
const local = { isWorking: false, isSending: false, nextId: 1, isActive: true }

async function enqueue($: EngineInterface, text: string) {
  const id = `${Date.now()}-${local.nextId++}`
  const list = await update($, messages, all => [...all, { id, text }])
  $.ui.toast(`Queued (${list.length}). Claude reads it after the current task.`)
}

/** Sends the first queued message as the person's own, as a turn of its own. */
async function sendNext($: EngineInterface) {
  if (local.isSending) return
  const [first] = await read($, messages)
  if (!first) return

  local.isSending = true
  try {
    await update($, messages, all => all.filter(m => m.id !== first.id))
    await update($, isPaused, () => false)
    await $.prompt.submit({ text: first.text, asUser: true })
  } finally {
    local.isSending = false
  }
}

async function move($: EngineInterface, id: string, by: number) {
  await update($, messages, all => {
    const from = all.findIndex(m => m.id === id)
    const to = from + by
    if (from < 0 || to < 0 || to >= all.length) return all
    const next = [...all]
    const [item] = next.splice(from, 1)
    next.splice(to, 0, item as QueuedMessage)

    return next
  })
}

function firstLine(text: string): string {
  const line = text.trim().split('\n')[0] ?? ''

  return text.trim().includes('\n') ? `${line} …` : line
}

export const register: Register = (on, options) => {
  const showIn = String(options.show_in ?? 'both')

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    local.isActive = runsOn(showIn, e.surface)
    if (!local.isActive) return result
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

  // The queue key (chat:queueSubmit) while a turn runs: hold the message instead of steering.
  on('prompt.submit', async ($, e, next) => {
    const isTyped = e.origin.kind === 'composer'
    if (!local.isActive || !e.wait || !isTyped || e.turnId === undefined) return next(e)

    if (e.attachments?.length) {
      $.ui.toast("Messages with images can't be queued, so this one was sent now.")
      return next(e)
    }

    await enqueue($, e.text)

    return { drop: 'Queued. Claude will read it after the current task.' }
  })
    // If queueing fails, the message is sent as usual rather than lost.
    .catch(($, e, next) => next(e))

  on('command.run', { command: 'queue' }, async ($, e) => {
    const args = (e.args ?? '').trim()

    if (args === 'clear') {
      const count = (await read($, messages)).length
      await update($, messages, () => [])
      return {
        text: count
          ? `Cleared ${count} queued message${count === 1 ? '' : 's'}.`
          : 'Nothing is queued.',
      }
    }
    if (args === 'send') {
      if (local.isWorking)
        return { text: 'Claude is still working; the next message goes when it finishes.' }
      await sendNext($)
      return { text: 'Sent the next queued message.' }
    }
    if (!args) {
      const count = (await read($, messages)).length
      return {
        text: count
          ? `${count} message${count === 1 ? '' : 's'} queued.`
          : 'Nothing is queued. Use /queue <message>.',
      }
    }

    if (!local.isWorking && !(await read($, messages)).length) {
      // Nothing to wait for: send it now.
      await $.prompt.submit({ text: args, asUser: true })
      return { text: 'Claude is idle, so it was sent now.' }
    }
    await enqueue($, args)

    return { text: 'Queued.' }
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined || !local.isActive) return result

    local.isWorking = false
    if (e.reason === 'answer') {
      // Wait a moment so the turn's last rows land before the next message starts.
      if (!(await read($, isPaused))) $.clock.after(300, () => void sendNext($))
    } else if ((await read($, messages)).length) {
      // The person stopped the turn: hold the queue until they send it.
      await update($, isPaused, () => true)
    }

    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // Other mods' sections come first; ours follow, nearer the prompt.
    const above = await next(e)
    if (e.props.hasSurvey || !runsOn(showIn, e.surface)) return above

    const [list, paused] = await Promise.all([read($, messages), read($, isPaused)])
    if (list.length === 0) return above

    const { Box, Text, Button } = $.ui.resolve(e)
    const isTerminal = e.surface === 'terminal'
    const isNarrow = e.props.bodyColumns < NARROW_COLUMNS
    const hasAbove = ((above as { children?: unknown[] }).children?.length ?? 0) > 0
    // Without fullscreen the terminal takes no clicks: say once how to reach the buttons.
    const hasHint = isTerminal && e.viewport?.isFullscreen !== true && !hasKey(above, HINT_KEY)

    return (
      <Box flexDirection="column">
        {above}
        <Box
          flexDirection={isNarrow ? 'column' : 'row'}
          gap={isNarrow ? 0 : 2}
          marginTop={hasAbove ? 1 : 0}
        >
          <Box flexDirection="column" flexShrink={0} {...(isNarrow ? {} : { width: LABEL_WIDTH })}>
            <Text dimColor>{`Queued (${list.length})`}</Text>
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
            {list.map((m, index) => (
              <Box flexDirection="row" gap={1} alignItems="center">
                <Box width={2} flexShrink={0}>
                  <Text color={ACCENT}>{`${index + 1}`}</Text>
                </Box>
                <Box flexGrow={1} flexShrink={1} minWidth={0}>
                  <Text wrap="truncate-end">{firstLine(m.text)}</Text>
                </Box>
                <Box flexDirection="row" gap={1} width={5} flexShrink={0} justifyContent="flex-end">
                  {index > 0 && (
                    <Button
                      key={`queue-up-${m.id}`}
                      plain
                      dimColor
                      label="↑"
                      onPress={() => move($, m.id, -1)}
                    />
                  )}
                  <Button
                    key={`queue-remove-${m.id}`}
                    plain
                    dimColor
                    label="✕"
                    onPress={() => update($, messages, all => all.filter(x => x.id !== m.id))}
                  />
                </Box>
              </Box>
            ))}
            <Box flexDirection="row" gap={2} alignItems="center" paddingLeft={3}>
              <Text dimColor>
                {paused
                  ? 'Paused because you stopped Claude.'
                  : 'Sent one at a time, each after Claude finishes.'}
              </Text>
              {paused && (
                <Button
                  key="queue-send"
                  {...(isTerminal ? { plain: true as const } : {})}
                  variant="primary"
                  hotkey="n"
                  label="Send next"
                  onPress={() => sendNext($)}
                />
              )}
            </Box>
          </Box>
        </Box>
      </Box>
    )
  })
}
