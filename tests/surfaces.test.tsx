import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { runsOn } from '../hooks/shared'

const props = {
  hasSurvey: false,
  isWorking: true,
  maxRows: 20,
  bodyColumns: 110,
  scroll: { offset: 0, bodyRows: 19 },
  view: {},
}

function engine(on: On) {
  const sent: string[] = []
  mock.clock(on, { now: 1_000_000 })
  on('prompt.submit', ($, e) => (sent.push(e.text), { text: e.text }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('session.start', () => ({ cwd: '/work' }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box key="engine" />
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
    on('session.surfaces', () => ({ value: ['terminal' as const] }))
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

test('the terminal shows "ctrl+x tab" only without fullscreen', async ($, on) => {
  engine(on)
  await $.turn.start({ text: 'build it', turnId: 't1' })
  await $.prompt.submit({ text: 'later', wait: true, turnId: 't1', origin: { kind: 'composer' } })

  const plainTerminal = await $.ui.mount({
    plugin: 'clawd-watch',
    surface: 'terminal',
    component: 'AbovePrompt',
    props,
    viewport: { columns: 120, rows: 40, isFullscreen: false },
  })
  expect(await plainTerminal.find({ type: 'Text', text: 'ctrl+x tab' })).toBeDefined()
  await plainTerminal.unmount()

  const fullscreen = await $.ui.mount({
    plugin: 'clawd-watch',
    surface: 'terminal',
    component: 'AbovePrompt',
    props,
    viewport: { columns: 120, rows: 40, isFullscreen: true },
  })
  expect(await fullscreen.find({ type: 'Text', text: 'ctrl+x tab' })).toBeUndefined()
  await fullscreen.unmount()

  const desktop = await $.ui.mount({
    plugin: 'clawd-watch',
    surface: 'desktop',
    component: 'AbovePrompt',
    props,
  })
  expect(await desktop.find({ type: 'Text', text: 'ctrl+x tab' })).toBeUndefined()
  await desktop.unmount()
})

test(
  'set to terminal, the desktop app is unaffected, and a desktop client turns it on',
  { options: { show_in: 'terminal' } },
  async ($, on) => {
    const sent = engine(on)
    let surfaces: ('terminal' | 'desktop')[] = ['desktop']
    on('session.surfaces', () => ({ value: surfaces }))
    await $.turn.start({ text: 'build it', turnId: 't1' })

    const typed = { wait: true, turnId: 't1', origin: { kind: 'composer' as const } }
    expect((await $.prompt.submit({ ...typed, text: 'now' })).drop).toBeUndefined()
    expect(sent).toEqual(['now'])

    surfaces = ['terminal', 'desktop']
    expect((await $.prompt.submit({ ...typed, text: 'later' })).drop).toBeDefined()
    expect(sent).toEqual(['now'])
  },
)
