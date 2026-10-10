import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const band = {
  plugin: 'message-queue',
  component: 'AbovePrompt' as const,
  props: {
    hasSurvey: false,
    isWorking: true,
    maxRows: 20,
    bodyColumns: 110,
    scroll: { offset: 0, bodyRows: 19 },
    view: {},
  },
}

/** The engine beneath the plugin: records what reaches the model, draws an empty band. */
function engine(on: On) {
  const sent: string[] = []
  const clock = mock.clock(on, { now: 1_000_000 })
  on('prompt.submit', ($, e) => (sent.push(e.text), { text: e.text }))
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
    const ui = await $.ui.mount({ ...band, surface })
    expect(await ui.find({ type: 'Text', text: 'then add tests for it' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'sends when Claude finishes' })).toBeDefined()
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
  const ui = await $.ui.mount({ ...band, surface: 'desktop' })
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

test('stopping Claude pauses the queue until you send the next one', async ($, on) => {
  const { sent, clock } = engine(on)
  await $.turn.start({ text: 'build it', turnId: 't1' })
  await $.prompt.submit(typed('later please', true))

  await $.turn.complete(finished('aborted'))
  await clock.advance(300)
  expect(sent).toEqual([])

  const ui = await $.ui.mount({ ...band, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: 'Paused because you stopped Claude' })).toBeDefined()
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

  const ui = await $.ui.mount({ ...band, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: 'write the changelog after' })).toBeDefined()
  await ui.unmount()
})
