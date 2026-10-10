import { expect, mock, test } from 'claude-code/testing'
import type { CommandInfo, On } from 'claude-code'
import { frequent, groupOf } from '../hooks/register'

const DAY = 86_400_000
const NOW = 1_800_000_000_000

const COMMANDS: CommandInfo[] = [
  { name: 'clear', description: 'Clear conversation history', source: 'builtin' },
  { name: 'simplify', description: 'Review changed code for simplification', source: 'builtin' },
  { name: 'release-checklist', description: 'Run the release checklist', source: 'user' },
  {
    name: 'anthropic-skills:pdf',
    description: 'Read and fill PDFs',
    source: 'plugin',
    plugin: 'anthropic-skills',
  },
  {
    name: 'anthropic-skills:xlsx',
    description: 'Build spreadsheets',
    source: 'plugin',
    plugin: 'anthropic-skills',
  },
  { name: 'dock', description: 'Show all your skills', source: 'plugin', plugin: 'skill-dock' },
]

const band = {
  plugin: 'skill-dock',
  component: 'AbovePrompt' as const,
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 20,
    bodyColumns: 120,
    scroll: { offset: 0, bodyRows: 19 },
    view: {},
  },
}

/** The engine beneath the plugin: its commands, prompt box, panes and an empty band. */
function engine(on: On, store: Record<string, unknown> = {}, isPlaced = true) {
  const filled: string[] = []
  const clock = mock.clock(on, { now: NOW })
  mock.store(on, store)
  on('command.list', () => ({ value: COMMANDS }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.start', () => ({ cwd: '/work' }))
  on('prompt.read', () => ({ value: { text: 'for the Q3 report', cursor: 0 } }))
  on('prompt.fill', ($, e) => (filled.push(e.text), { isFilled: true }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('ui.open', () => ({
    value: isPlaced
      ? { isPlaced: true as const }
      : { isPlaced: false as const, reason: 'this desktop app places no panes' },
  }))
  on('skill.prompt', ($, e) => ({ text: e.text }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box key="engine" />
  })

  return { filled, clock }
}

test('pinned and frequently used skills sit in the dock, and a click fills the prompt', async ($, on) => {
  const { filled } = engine(on, {
    pins: ['anthropic-skills:pdf'],
    uses: { simplify: [NOW - DAY, NOW - 2 * DAY], 'anthropic-skills:xlsx': [NOW - 20 * DAY] },
    knownSkills: ['simplify'],
  })
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })

  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await $.ui.mount({ ...band, surface })
    expect((await ui.find({ key: 'dock-pin-anthropic-skills:pdf' }))?.props.label).toBe('★ pdf')
    expect((await ui.find({ key: 'dock-freq-simplify' }))?.props.label).toBe('simplify')
    expect(await ui.find({ key: 'dock-freq-clear' })).toBeUndefined()

    await ui.press({ key: 'dock-freq-simplify' })
    expect(filled.at(-1)).toBe('/simplify for the Q3 report')
    await ui.unmount()
  }
})

test('using a skill counts it, and pinning from the pane moves it to the front', async ($, on) => {
  const { clock } = engine(on)
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
  await $.skill.prompt({ skill: 'release-checklist', text: 'Run the checklist.' })
  await clock.advance(1)

  const dock = await $.ui.mount({ ...band, surface: 'desktop' })
  expect(await dock.find({ key: 'dock-freq-release-checklist' })).toBeDefined()

  const pane = await $.ui.mount({
    plugin: 'skill-dock',
    surface: 'desktop',
    component: 'Pane',
    requestId: 'skill-dock',
    props: {
      title: 'Skills',
      isFocused: true,
      bodyColumns: 60,
      placement: 'dock',
      scroll: { offset: 0, bodyRows: 40 },
      view: {},
    },
  })
  expect(await pane.find({ type: 'Text', text: 'AVAILABLE HERE' })).toBeDefined()
  expect(await pane.find({ key: 'used-use-release-checklist' })).toBeDefined()
  expect(await pane.find({ key: 'all-use-anthropic-skills:pdf' })).toBeDefined()
  await pane.press({ key: 'all-star-release-checklist' })

  expect(await dock.find({ key: 'dock-pin-release-checklist' })).toBeDefined()
  expect(await dock.find({ key: 'dock-freq-release-checklist' })).toBeUndefined()
  await pane.unmount()
  await dock.unmount()
})

test('/ menu descriptions carry the pin and the count', async ($, on) => {
  engine(on, { pins: ['simplify'], uses: { 'release-checklist': [NOW - DAY] } })
  on('command.describe', ($, e) => ({ description: e.description, isHidden: false }))
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })

  const base = {
    argumentHint: undefined,
    isHidden: false,
    immediate: false,
    provider: { plugin: 'engine', tier: 'core' as const },
  }
  const pinned = await $.command.describe({
    ...base,
    command: 'simplify',
    description: 'Review changed code',
  })
  const used = await $.command.describe({
    ...base,
    command: 'release-checklist',
    description: 'Run it',
  })

  expect(pinned.description).toBe('★ pinned · Review changed code')
  expect(used.description).toBe('↻ 1× this month · Run it')
})

test('built-in commands only count as skills once they have been used as one', () => {
  expect(groupOf(COMMANDS[0]!, [])).toBeUndefined()
  expect(groupOf(COMMANDS[1]!, ['simplify'])).toBe('Built-in')
  expect(groupOf(COMMANDS[3]!, [])).toBe('Plugins · anthropic-skills')
  expect(groupOf(COMMANDS[5]!, [])).toBeUndefined()

  const list = [
    { name: 'a', description: '', group: 'x' },
    { name: 'b', description: '', group: 'x' },
    { name: 'c', description: '', group: 'x' },
    { name: 'd', description: '', group: 'x' },
  ]
  const ranked = frequent(
    list,
    ['c'],
    { a: [NOW - 25 * DAY, NOW - 26 * DAY], b: [NOW], c: [NOW], d: [NOW - 40 * DAY] },
    NOW,
    5,
  )
  // More uses wins; uses older than 30 days don't count.
  expect(ranked.map(s => s.name)).toEqual(['a', 'b'])
})

test('where no pane can be placed, All skills opens the list inside the dock', async ($, on) => {
  engine(on, { pins: ['simplify'], knownSkills: ['simplify'] }, false)
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...band, surface: 'desktop' })
  await ui.press({ key: 'dock-all' })
  expect(await ui.find({ type: 'Text', text: 'AVAILABLE HERE' })).toBeDefined()
  expect((await ui.find({ key: 'dock-all' }))?.props.label).toBe('Close')

  await ui.press({ key: 'dock-all' })
  expect(await ui.find({ type: 'Text', text: 'AVAILABLE HERE' })).toBeUndefined()
  await ui.unmount()
})
