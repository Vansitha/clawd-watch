import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { band, pane } from './views'

/** The engine beneath: a store that keeps what's set, panes that open and close, an empty band. */
function engine(on: On, saved: Record<string, unknown> = {}, isPlaced = true) {
  const opened: string[] = []
  const closed: string[] = []
  mock.clock(on, { now: 1_000_000 })
  on('store.get', ($, e) => ({ value: saved[e.key] }))
  on('store.set', ($, e) => ((saved[e.key] = e.value), { value: undefined }))
  on('session.start', () => ({ cwd: '/work' }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('command.list', () => ({ value: [] }))
  on('ui.open', ($, e) => {
    opened.push(e.id)
    return {
      value: isPlaced
        ? { isPlaced: true as const }
        : { isPlaced: false as const, reason: 'no pane here' },
    }
  })
  on('ui.close', ($, e) => (closed.push(e.id), { value: undefined }))
  on('session.attach', ($, e) => ({ clientId: e.clientId }))
  on('ui.panes', () => ({ value: [] }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box key="engine" />
  })

  return { opened, closed, saved }
}

const queueOne = async ($: Engine) => {
  await $.turn.start({ text: 'build it', turnId: 't1' })
  await $.prompt.submit({ text: 'later', wait: true, turnId: 't1', origin: { kind: 'composer' } })
}

test('in the desktop app the panel lives in a side pane, opened from one line above the prompt', async ($, on) => {
  const { opened } = engine(on)
  on('prompt.submit', ($, e) => ({ text: e.text }))
  await queueOne($)

  const above = await $.ui.mount(band('desktop'))
  expect(await above.find({ type: 'Text', text: '1 queued' })).toBeDefined()
  expect(await above.find({ type: 'Text', text: 'later' })).toBeUndefined()
  await above.press({ key: 'clawd-watch-open' })
  expect(opened).toEqual(['clawd-watch'])
  // With the pane open, the band above the prompt stays clear.
  expect(await above.find({ key: 'clawd-watch-open' })).toBeUndefined()

  const side = await $.ui.mount(pane('desktop'))
  expect(await side.find({ key: 'card-queued' })).toBeDefined()
  expect(await side.find({ type: 'Text', text: 'later' })).toBeDefined()
  await side.unmount()
  await above.unmount()
})

test('/watch opens and closes the pane, and a close is kept for the next session', async ($, on) => {
  const { opened, closed, saved } = engine(on)
  const watch = () =>
    $.command.run({
      command: 'watch',
      args: '',
      origin: { kind: 'composer' },
      presentation: { isFullscreen: true, columns: 120 },
    })

  expect((await watch()).text).toBe('Opened the Clawd Watch panel.')
  expect(opened).toEqual(['clawd-watch'])
  expect(saved.paneOpen).toBe(true)

  expect((await watch()).text).toBe('Closed the Clawd Watch panel.')
  expect(closed).toEqual(['clawd-watch'])
  expect(saved.paneOpen).toBe(false)
})

const attach = ($: Engine) =>
  $.session.attach({
    surface: 'desktop',
    clientId: 'desktop:default',
    viewport: { columns: 120, rows: 40, isFullscreen: true },
  })

test('the desktop app opens the pane when it attaches', async ($, on) => {
  const { opened, saved } = engine(on)
  await attach($)
  expect(opened).toEqual(['clawd-watch'])
  // Opening it unasked is not the person's choice, so nothing is saved.
  expect(saved.paneOpen).toBeUndefined()
})

test('a pane the person closed stays closed when the desktop app attaches', async ($, on) => {
  const { opened } = engine(on, { paneOpen: false })
  await attach($)
  expect(opened).toEqual([])
})

test('a desktop app with no pane room keeps everything above the prompt', async ($, on) => {
  engine(on, {}, false)
  on('prompt.submit', ($, e) => ({ text: e.text }))
  await queueOne($)

  const above = await $.ui.mount(band('desktop'))
  await above.press({ key: 'clawd-watch-open' })
  expect(await above.find({ key: 'card-queued' })).toBeDefined()
  expect(await above.find({ type: 'Text', text: 'later' })).toBeDefined()
  await above.unmount()
})

test("what the old mods saved is taken over once, keeping what's already there", async ($, on) => {
  const { saved } = engine(on, { pins: ['kept'] })
  on('env.get', ($, e) => ({ value: e.name === 'HOME' ? '/home/me' : undefined }))
  on('fs.list', () => ({
    value: [
      {
        name: 'skill-dock_inline-1.json',
        kind: 'file' as const,
        size: 1,
        mtimeMs: 0,
        isLink: false,
      },
      {
        name: 'session-hud_inline-2.json',
        kind: 'file' as const,
        size: 1,
        mtimeMs: 0,
        isLink: false,
      },
      {
        name: 'someone-else_inline-3.json',
        kind: 'file' as const,
        size: 1,
        mtimeMs: 0,
        isLink: false,
      },
    ],
  }))
  on('fs.read', ($, e) => {
    const files: Record<string, unknown> = {
      '/home/me/.claude/plugins/store/skill-dock_inline-1.json': {
        pins: ['old'],
        uses: { simplify: [1] },
      },
      '/home/me/.claude/plugins/store/session-hud_inline-2.json': {
        agentHistory: [{ type: 'Explore', ms: 1000, steps: 3 }],
      },
      '/home/me/.claude/plugins/store/someone-else_inline-3.json': { pins: ['theirs'] },
    }
    return { value: JSON.stringify(files[e.path] ?? {}) }
  })

  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  expect(saved.pins).toEqual(['kept'])
  expect(saved.uses).toEqual({ simplify: [1] })
  expect(saved.agentHistory).toEqual([{ type: 'Explore', ms: 1000, steps: 3 }])
  expect(saved.migratedFromMods).toBe(true)
})
