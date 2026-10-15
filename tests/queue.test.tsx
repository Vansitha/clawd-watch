import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { band, panel } from './views'

/** The engine beneath the plugin: records what reaches the model, draws an empty band. */
function engine(on: On, { failSubmit = false } = {}) {
  const sent: string[] = []
  const clock = mock.clock(on, { now: 1_000_000 })
  on('prompt.submit', ($, e) => {
    // A plugin's own submit (queued messages) fails when asked; the person's typing never does.
    if (failSubmit && e.origin.kind === 'plugin') throw new Error('refused')
    sent.push(e.text)
    return { text: e.text }
  })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box key="engine" />
  })

  return { sent, clock }
}

const typed = (text: string, wait: boolean) => ({
  text,
  wait,
  turnId: 't1',
  origin: { kind: 'composer' as const },
})

const finished = (reason: 'answer' | 'aborted') => ({
  answer: '',
  durationMs: 1000,
  isAborted: reason === 'aborted',
  turnId: 't1',
  reason,
})

test('the queue key holds a message until Claude finishes, then sends it', async ($, on) => {
  const { sent, clock } = engine(on)
  await $.turn.start({ text: 'build the rooms screen', turnId: 't1' })

  const result = await $.prompt.submit(typed('then add tests for it', true))
  expect(result.drop).toBe('Queued. Claude will read it after the current task.')
  expect(sent).toEqual([])

  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await $.ui.mount(panel(surface))
    expect(await ui.find({ type: 'Text', text: 'then add tests for it' })).toBeDefined()
    expect(
      await ui.find({ type: 'Text', text: 'Sent one at a time, each after Claude finishes.' }),
    ).toBeDefined()
    await ui.unmount()
  }

  await $.turn.complete(finished('answer'))
  await clock.advance(300)
  expect(sent).toEqual(['then add tests for it'])
})

test('plain Enter mid-turn still steers right away', async ($, on) => {
  const { sent } = engine(on)
  await $.turn.start({ text: 'build it', turnId: 't1' })

  const result = await $.prompt.submit(typed('use the blue palette', false))
  expect(result.drop).toBeUndefined()
  expect(sent).toEqual(['use the blue palette'])
})

test('queued messages go one at a time, in order, and can be reordered', async ($, on) => {
  const { sent, clock } = engine(on)
  await $.turn.start({ text: 'build it', turnId: 't1' })
  await $.prompt.submit(typed('first', true))
  await $.prompt.submit(typed('second', true))
  await $.prompt.submit(typed('third', true))

  // Move "third" ahead of "second".
  const ui = await $.ui.mount(panel('desktop'))
  const ups = await ui.findAll({ type: 'Button', text: '↑' })
  expect(ups.length).toBe(2)
  await ui.press({ key: ups[1]!.key! })
  await ui.unmount()

  await $.turn.complete(finished('answer'))
  await clock.advance(300)
  expect(sent).toEqual(['first'])

  await $.turn.start({ text: 'first', turnId: 't2' })
  await $.turn.complete({ ...finished('answer'), turnId: 't2' })
  await clock.advance(300)
  expect(sent).toEqual(['first', 'third'])
})

test('one finished task sends one queued message, even if the end is reported twice', async ($, on) => {
  const { sent, clock } = engine(on)
  await $.turn.start({ text: 'build it', turnId: 't1' })
  await $.prompt.submit(typed('first', true))
  await $.prompt.submit(typed('second', true))

  await $.turn.complete(finished('answer'))
  await $.turn.complete(finished('answer'))
  await clock.advance(300)
  expect(sent).toEqual(['first'])
})

test('a message typed just as Claude finishes goes first, and the queue waits for it', async ($, on) => {
  const { sent, clock } = engine(on)
  await $.turn.start({ text: 'build it', turnId: 't1' })
  await $.prompt.submit(typed('queued', true))

  await $.turn.complete(finished('answer'))
  await $.turn.start({ text: 'typed now', turnId: 't2' })
  await clock.advance(300)
  expect(sent).toEqual([])

  await $.turn.complete({ ...finished('answer'), turnId: 't2' })
  await clock.advance(300)
  expect(sent).toEqual(['queued'])
})

test('stopping Claude pauses the queue until you send the next one', async ($, on) => {
  const { sent, clock } = engine(on)
  await $.turn.start({ text: 'build it', turnId: 't1' })
  await $.prompt.submit(typed('later please', true))

  await $.turn.complete(finished('aborted'))
  await clock.advance(300)
  expect(sent).toEqual([])

  const ui = await $.ui.mount(panel('desktop'))
  expect(await ui.find({ type: 'Text', text: 'Paused because you stopped Claude.' })).toBeDefined()
  await ui.press({ key: 'queue-send' })
  expect(sent).toEqual(['later please'])
  expect(await ui.find({ type: 'Text', text: 'later please' })).toBeUndefined()
  await ui.unmount()
})

test('/queue adds a message while Claude works', async ($, on) => {
  const { sent } = engine(on)
  await $.turn.start({ text: 'build it', turnId: 't1' })
  const out = await $.command.run({
    command: 'queue',
    args: 'write the changelog after',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 120 },
  })
  expect(out.text).toBe('Queued.')
  expect(sent).toEqual([])

  const ui = await $.ui.mount(panel('desktop'))
  expect(await ui.find({ type: 'Text', text: 'write the changelog after' })).toBeDefined()
  await ui.unmount()
})

test('emptying a paused queue un-pauses it, so later messages still go', async ($, on) => {
  const { sent, clock } = engine(on)
  await $.turn.start({ text: 'build it', turnId: 't1' })
  await $.prompt.submit(typed('first', true))
  await $.turn.complete(finished('aborted'))

  const ui = await $.ui.mount(panel('desktop'))
  const remove = await ui.find({ type: 'Button', text: '✕' })
  await ui.press({ key: remove!.key! })
  await ui.unmount()

  await $.turn.start({ text: 'again', turnId: 't2' })
  await $.prompt.submit({ ...typed('second', true), turnId: 't2' })
  await $.turn.complete({ ...finished('answer'), turnId: 't2' })
  await clock.advance(300)
  expect(sent).toEqual(['second'])
})

test('a message that fails to send goes back to the front of the queue', async ($, on) => {
  const { clock } = engine(on, { failSubmit: true })
  await $.turn.start({ text: 'build it', turnId: 't1' })
  await $.prompt.submit(typed('keep me', true))
  await $.turn.complete(finished('answer'))
  await clock.advance(300)

  const ui = await $.ui.mount(panel('desktop'))
  expect(await ui.find({ type: 'Text', text: 'keep me' })).toBeDefined()
  await ui.unmount()
})

test('a failed "Send next" keeps the queue paused, with the button still there', async ($, on) => {
  engine(on, { failSubmit: true })
  await $.turn.start({ text: 'build it', turnId: 't1' })
  await $.prompt.submit(typed('keep me', true))
  await $.turn.complete(finished('aborted'))

  const ui = await $.ui.mount(panel('desktop'))
  await ui.press({ key: 'queue-send' })
  expect(await ui.find({ type: 'Text', text: 'keep me' })).toBeDefined()
  expect(await ui.find({ key: 'queue-send' })).toBeDefined()
  await ui.unmount()
})

test('in the terminal the panel folds to one line that says what is waiting', async ($, on) => {
  engine(on)
  // A store that keeps what's set, so the test can see the fold was saved.
  const saved: Record<string, unknown> = {}
  on('store.get', ($, e) => ({ value: saved[e.key] }))
  on('store.set', ($, e) => ((saved[e.key] = e.value), { value: undefined }))
  await $.turn.start({ text: 'build it', turnId: 't1' })
  await $.prompt.submit(typed('first', true))
  await $.prompt.submit(typed('second', true))

  const ui = await $.ui.mount(band('terminal'))
  expect((await ui.find({ key: 'clawd-watch-fold' }))?.props.label).toBe('▾ Clawd Watch')
  await ui.press({ key: 'clawd-watch-fold' })

  expect((await ui.find({ key: 'clawd-watch-fold' }))?.props.label).toBe('▸ Clawd Watch')
  expect(await ui.find({ type: 'Text', text: '2 queued' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'first' })).toBeUndefined()
  expect(saved.folded).toBe(true)

  await ui.press({ key: 'clawd-watch-fold' })
  expect(await ui.find({ type: 'Text', text: 'first' })).toBeDefined()
  await ui.unmount()
})

test('a panel folded in an earlier session starts folded', async ($, on) => {
  engine(on)
  mock.store(on, { folded: true })
  on('session.start', () => ({ cwd: '/work' }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('command.list', () => ({ value: [] }))
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'build it', turnId: 't1' })
  await $.prompt.submit(typed('first', true))

  const ui = await $.ui.mount(band('terminal'))
  expect((await ui.find({ key: 'clawd-watch-fold' }))?.props.label).toBe('▸ Clawd Watch')
  expect(await ui.find({ type: 'Text', text: 'first' })).toBeUndefined()
  await ui.unmount()
})

test('in the desktop app the queue is a card that collapses to its title', async ($, on) => {
  engine(on)
  mock.store(on)
  await $.turn.start({ text: 'build it', turnId: 't1' })
  await $.prompt.submit(typed('first', true))

  const ui = await $.ui.mount(panel('desktop'))
  expect((await ui.find({ key: 'card-queued' }))?.props.label).toBe('Queued (1)  ⌄')
  await ui.press({ key: 'card-queued' })
  expect((await ui.find({ key: 'card-queued' }))?.props.label).toBe('Queued (1)  ›')
  expect(await ui.find({ type: 'Text', text: 'first' })).toBeUndefined()
  await ui.unmount()

  // The terminal draws no cards.
  const terminal = await $.ui.mount(band('terminal'))
  expect(await terminal.find({ key: 'card-queued' })).toBeUndefined()
  expect(await terminal.find({ type: 'Text', text: 'first' })).toBeDefined()
  await terminal.unmount()
})
