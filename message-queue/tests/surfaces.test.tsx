import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { runsOn } from '../hooks/register'

const props = {
  hasSurvey: false,
  isWorking: true,
  maxRows: 20,
  bodyColumns: 110,
  scroll: { offset: 0, bodyRows: 19 },
  view: {},
}

function engine(on: On, below: 'empty' | 'hint' = 'empty') {
  const sent: string[] = []
  mock.clock(on, { now: 1_000_000 })
  on('prompt.submit', ($, e) => (sent.push(e.text), { text: e.text }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('session.start', () => ({ cwd: '/work' }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    // Another Overwatch mod that already drew the hint.
    return below === 'hint' ? (
      <Box key="overwatch-hint">
        <Text>ctrl+x tab</Text>
      </Box>
    ) : (
      <Box key="engine" />
    )
  })

  return sent
}

test('"Show in" picks the surfaces', () => {
  expect(runsOn('both', 'terminal')).toBe(true)
  expect(runsOn('both', 'desktop')).toBe(true)
  expect(runsOn('desktop', 'desktop')).toBe(true)
  expect(runsOn('desktop', 'terminal')).toBe(false)
  expect(runsOn('terminal', 'terminal')).toBe(true)
  expect(runsOn('terminal', 'desktop')).toBe(false)
})

test(
  'set to desktop, a terminal session sends the queue key as usual',
  { options: { show_in: 'desktop' } },
  async ($, on) => {
    const sent = engine(on)
    await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
    await $.turn.start({ text: 'build it', turnId: 't1' })

    const result = await $.prompt.submit({
      text: 'later',
      wait: true,
      turnId: 't1',
      origin: { kind: 'composer' },
    })
    expect(result.drop).toBeUndefined()
    expect(sent).toEqual(['later'])
  },
)

test('the terminal shows "ctrl+x tab" once, and only without fullscreen', async ($, on) => {
  engine(on)
  await $.turn.start({ text: 'build it', turnId: 't1' })
  await $.prompt.submit({ text: 'later', wait: true, turnId: 't1', origin: { kind: 'composer' } })

  const plainTerminal = await $.ui.mount({
    plugin: 'message-queue',
    surface: 'terminal',
    component: 'AbovePrompt',
    props,
    viewport: { columns: 120, rows: 40, isFullscreen: false },
  })
  expect(await plainTerminal.find({ type: 'Text', text: 'ctrl+x tab' })).toBeDefined()
  await plainTerminal.unmount()

  const fullscreen = await $.ui.mount({
    plugin: 'message-queue',
    surface: 'terminal',
    component: 'AbovePrompt',
    props,
    viewport: { columns: 120, rows: 40, isFullscreen: true },
  })
  expect(await fullscreen.find({ type: 'Text', text: 'ctrl+x tab' })).toBeUndefined()
  await fullscreen.unmount()

  const desktop = await $.ui.mount({
    plugin: 'message-queue',
    surface: 'desktop',
    component: 'AbovePrompt',
    props,
  })
  expect(await desktop.find({ type: 'Text', text: 'ctrl+x tab' })).toBeUndefined()
  await desktop.unmount()
})

test("another mod's hint means no second one", async ($, on) => {
  engine(on, 'hint')
  await $.turn.start({ text: 'build it', turnId: 't1' })
  await $.prompt.submit({ text: 'later', wait: true, turnId: 't1', origin: { kind: 'composer' } })

  const ui = await $.ui.mount({
    plugin: 'message-queue',
    surface: 'terminal',
    component: 'AbovePrompt',
    props,
    viewport: { columns: 120, rows: 40, isFullscreen: false },
  })
  expect((await ui.findAll({ type: 'Text', text: 'ctrl+x tab' })).length).toBe(1)
  await ui.unmount()
})
