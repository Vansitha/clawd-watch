import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { AgentRun } from '../types'
import { clockTime, correction, describeCall, estimate, parseSize } from '../hooks/subagents'
import { band, pane, panel } from './views'

/** The test runner's timer, for letting a background answer land. */
declare const setTimeout: (done: (value?: unknown) => void, ms: number) => unknown

const usage = {
  input_tokens: 1,
  output_tokens: 1,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
}

test("with nothing running the band adds nothing and keeps other mods' rows", async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box key="engine">
        <Text>another mod</Text>
      </Box>
    )
  })
  on('session.measure', ($, e) => ({ changed: e.changed }))
  await $.session.measure({
    context: { window: 200_000, percent: 12 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 42.5, resetsAt: '2026-10-03T18:00:00Z' }],
    changed: ['context', 'rateLimits'],
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount(band(surface))
    expect(await ui.find({ type: 'Text', text: 'another mod' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /5-hour|43%/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('/handoff writes a starter prompt and the pill clears and starts it', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const ran: string[] = []
  let submitted = ''

  on('model.fork', () => ({
    value: {
      isAnswered: true as const,
      text: '<title>Build the login page</title>\n<handoff>\nYou are continuing the login work.\n</handoff>',
      usage,
    },
  }))
  on('command.run', { command: 'clear' }, ($, e) => (ran.push(e.command), { text: '' }))
  on('prompt.submit', ($, e) => ((submitted = e.text), { text: e.text }))
  on('ui.copy', () => ({ value: { isCopied: true as const } }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box key="engine" />
  })
  for (const surface of ['terminal', 'desktop'] as const) {
    ran.length = 0
    submitted = ''
    await $.command.run({
      command: 'handoff',
      args: '',
      origin: { kind: 'composer' },
      presentation: { isFullscreen: true, columns: 120 },
    })
    await clock.advance(10)

    const ui = await $.ui.mount(panel(surface))
    expect(await ui.find({ type: 'Text', text: 'Build the login page' })).toBeDefined()
    const start = await ui.find({ key: 'handoff-start' })
    expect(start?.props.plain).toBe(surface === 'terminal' ? true : undefined)
    expect(start?.props.hotkey).toBe('s')
    await ui.press({ key: 'handoff-start' })

    expect(ran).toEqual(['clear'])
    expect(submitted).toBe('You are continuing the login work.')
    expect(await ui.find({ key: 'handoff-start' })).toBeUndefined()
    await ui.unmount()
  }
})

test('a running subagent shows its task, then finishes', async ($, on) => {
  const clock = mock.clock(on, { now: 2_000_000 })
  mock.store(on)
  on('agent.spawn', () => ({ model: 'm', agentId: 'agent-1' }))
  on('agent.list', () => ({ value: [] }))
  on('turn.complete', () => ({ text: '' }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box key="engine" />
  })

  await $.agent.spawn({
    tool_use_id: 'toolu_1',
    prompt: 'find them',
    description: 'Find auth handlers',
    subagentType: 'Explore',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'm',
    background: false,
    fork: false,
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    const view = await $.ui.mount(panel(surface))
    // The desktop app draws the section as a card whose title collapses it.
    const title =
      surface === 'terminal'
        ? await view.find({ type: 'Text', text: 'Subagents' })
        : await view.find({ key: 'card-subagents' })
    expect(title).toBeDefined()
    expect(await view.find({ type: 'Text', text: /^All done by ~/ })).toBeDefined()
    // A narrow pane and the terminal say when each row will be done, under its name.
    expect(await view.find({ type: 'Text', text: /^done by ~/ })).toBeDefined()
    expect(await view.find({ type: 'Text', text: /Find auth handlers/ })).toBeDefined()
    // A progress bar: rounded SVG on the desktop, a run of blocks in the terminal.
    if (surface === 'desktop') expect(await view.find({ type: 'Svg' })).toBeDefined()
    else expect(await view.find({ type: 'Text', text: /─/ })).toBeDefined()
    await view.unmount()
  }

  // A wide pane gives each subagent one line, its time in a column.
  const wide = await $.ui.mount(pane('desktop', 100))
  expect(await wide.find({ type: 'Text', text: /^~\d/ })).toBeDefined()
  await wide.unmount()

  const ui = await $.ui.mount(pane('desktop'))

  // The bar follows the clock even when nothing else changes; no countdown ticks beside it.
  const before = (await ui.find({ type: 'Svg' }))?.props.source
  await clock.advance(65_000)
  expect((await ui.find({ type: 'Svg' }))?.props.source).not.toBe(before)
  expect(await ui.find({ type: 'Text', text: /~\d+m \d+s|in ~/ })).toBeUndefined()

  await $.turn.complete({
    answer: 'found',
    durationMs: 1000,
    isAborted: false,
    turnId: 't1',
    agentId: 'agent-1',
    reason: 'answer',
  })
  expect(await ui.find({ type: 'Text', text: 'All done' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^finished in 1m 5s/ })).toBeDefined()
  await ui.unmount()
})

test('estimates ease toward done and never claim it early', () => {
  const run: AgentRun = {
    toolUseId: 't',
    description: 'd',
    type: 'Explore',
    startedAt: 0,
    isBackground: false,
    status: 'running',
    steps: 6,
    activity: '',
    expectedMs: 60_000,
    expectedSteps: 12,
    isSizing: false,
  }
  const early = estimate(run, 10_000)
  const late = estimate({ ...run, steps: 40 }, 300_000)

  expect(early.progress).toBeGreaterThan(0.2)
  expect(early.progress).toBeLessThan(0.5)
  expect(late.progress).toBeLessThan(0.98)
  expect(late.remaining).toBeGreaterThan(0)
  expect(describeCall({ tool: 'Read', file_path: '/a/b/c.ts' })).toBe('Reading c.ts')
})

test(
  '"Show in: desktop" keeps the terminal clear',
  { options: { show_in: 'desktop' } },
  async ($, on) => {
    mock.clock(on, { now: 2_000_000 })
    mock.store(on)
    on('session.surfaces', () => ({ value: ['desktop' as const] }))
    on('agent.spawn', () => ({ model: 'm', agentId: 'agent-1' }))
    on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
      const { Box } = $.ui.resolve(e)
      return <Box key="engine" />
    })
    await $.agent.spawn({
      tool_use_id: 'toolu_1',
      prompt: 'p',
      description: 'Find auth handlers',
      subagentType: 'Explore',
      provider: { plugin: 'engine', tier: 'core' },
      parentModel: 'm',
      background: false,
      fork: false,
    })

    const terminal = await $.ui.mount(band('terminal'))
    expect(await terminal.find({ type: 'Text', text: 'Subagents' })).toBeUndefined()
    await terminal.unmount()

    const desktop = await $.ui.mount(pane('desktop'))
    expect(await desktop.find({ key: 'card-subagents' })).toBeDefined()
    await desktop.unmount()
  },
)

test('a background subagent that ends unseen is marked done from the agent list', async ($, on) => {
  const clock = mock.clock(on, { now: 2_000_000 })
  mock.store(on)
  let status: 'running' | 'completed' = 'running'
  on('agent.spawn', () => ({ model: 'm', agentId: 'agent-1' }))
  on('agent.list', () => ({
    value: [{ id: 'agent-1', description: 'd', type: 'Explore', status }],
  }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box key="engine" />
  })
  await $.agent.spawn({
    tool_use_id: 'toolu_1',
    prompt: 'p',
    description: 'Find auth handlers',
    subagentType: 'Explore',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'm',
    background: true,
    fork: false,
  })

  const ui = await $.ui.mount(pane('desktop'))
  await clock.advance(10_000)
  expect(await ui.find({ type: 'Text', text: /^All done by ~/ })).toBeDefined()

  status = 'completed'
  await clock.advance(10_000)
  expect(await ui.find({ type: 'Text', text: 'All done' })).toBeDefined()
  await ui.unmount()
})

test('a spawn that fails leaves no row behind', async ($, on) => {
  mock.clock(on, { now: 2_000_000 })
  mock.store(on)
  on('agent.spawn', () => {
    throw new Error('refused')
  })
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box key="engine" />
  })
  await $.agent
    .spawn({
      tool_use_id: 'toolu_1',
      prompt: 'p',
      description: 'Find auth handlers',
      subagentType: 'Explore',
      provider: { plugin: 'engine', tier: 'core' },
      parentModel: 'm',
      background: false,
      fork: false,
    })
    .catch(() => undefined)

  const ui = await $.ui.mount(pane('desktop'))
  expect(await ui.find({ key: 'card-subagents' })).toBeUndefined()
  await ui.unmount()
})

const spawnArgs = (prompt: string) => ({
  tool_use_id: 'toolu_1',
  prompt,
  description: 'Fix six notch UI issues',
  subagentType: 'general-purpose',
  provider: { plugin: 'engine', tier: 'core' as const },
  parentModel: 'm',
  background: false,
  fork: false,
})

function hudEngine(on: On, now: number) {
  mock.clock(on, { now })
  mock.store(on)
  on('agent.spawn', () => ({ model: 'm', agentId: 'agent-1' }))
  on('agent.list', () => ({ value: [] }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box key="engine" />
  })
}

test('Claude sizes each task; the row says estimating until it answers', async ($, on) => {
  const NOW = 2_000_000
  hudEngine(on, NOW)
  let asked = ''
  let answer: () => void = () => undefined
  const answered = new Promise<void>(resolve => (answer = resolve))
  on('model.complete', async ($, e) => {
    asked = typeof e.prompt === 'string' ? e.prompt : ''
    await answered
    return {
      value: { isAnswered: true as const, text: '<minutes>10</minutes><steps>80</steps>', usage },
    }
  })

  await $.agent.spawn(spawnArgs('Fix the six notch issues listed in notch.md, then run the tests.'))
  const ui = await $.ui.mount(pane('desktop'))
  expect(asked).toContain('Fix six notch UI issues')
  expect(asked).toContain('notch.md')
  expect(await ui.find({ type: 'Text', text: 'estimating…' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Estimating…' })).toBeDefined()

  answer()
  await new Promise(resolve => setTimeout(resolve, 20))
  expect(
    await ui.find({ type: 'Text', text: `done by ~${clockTime(NOW + 600_000)}` }),
  ).toBeDefined()
  expect(
    await ui.find({ type: 'Text', text: `All done by ~${clockTime(NOW + 600_000)}` }),
  ).toBeDefined()
  await ui.unmount()
})

test('when sizing fails, the estimate from past runs shows', async ($, on) => {
  hudEngine(on, 2_000_000)
  on('model.complete', () => ({
    value: {
      isAnswered: false as const,
      reason: 'api-error' as const,
      status: 529,
      error: 'overloaded',
      usage,
    },
  }))

  await $.agent.spawn(spawnArgs('p'))
  await new Promise(resolve => setTimeout(resolve, 20))
  const ui = await $.ui.mount(pane('desktop'))
  expect(await ui.find({ type: 'Text', text: /^done by ~/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'estimating…' })).toBeUndefined()
  await ui.unmount()
})

test("Claude's guesses are read safely and corrected by how past runs went", () => {
  expect(parseSize('<minutes>2.5</minutes><steps>30</steps>')).toEqual({ ms: 150_000, steps: 30 })
  expect(parseSize('<minutes>999</minutes><steps>0</steps>')).toBeUndefined()
  expect(parseSize('about ten minutes')).toBeUndefined()

  const ratio = (s: { ms: number; guessMs?: number }) => (s.guessMs ? s.ms / s.guessMs : undefined)
  const sample = (ms: number, guessMs?: number) => ({ type: 'x', ms, steps: 1, guessMs })
  // Runs took twice what Claude guessed, so later guesses double; too few samples change nothing.
  expect(correction([sample(20, 10), sample(40, 20), sample(60, 30)], ratio)).toBe(2)
  expect(correction([sample(20, 10), sample(40)], ratio)).toBe(1)
  expect(correction([sample(1000, 1), sample(1000, 1), sample(1000, 1)], ratio)).toBe(4)
})

test('one line says how many subagents are running: the closed panel, and the folded band', async ($, on) => {
  hudEngine(on, 2_000_000)
  on('model.complete', () => ({
    value: { isAnswered: true as const, text: '<minutes>5</minutes><steps>40</steps>', usage },
  }))
  await $.agent.spawn(spawnArgs('p'))

  // The desktop app, its pane closed: one line, which opens the pane.
  const desktop = await $.ui.mount(band('desktop'))
  expect(await desktop.find({ type: 'Text', text: '1 subagent running' })).toBeDefined()
  expect(await desktop.find({ key: 'card-subagents' })).toBeUndefined()
  expect((await desktop.find({ key: 'clawd-watch-open' }))?.props.label).toBe('Open panel')
  await desktop.unmount()

  // The terminal, folded.
  const terminal = await $.ui.mount(band('terminal'))
  await terminal.press({ key: 'clawd-watch-fold' })
  expect(await terminal.find({ type: 'Text', text: '1 subagent running' })).toBeDefined()
  expect(await terminal.find({ type: 'Text', text: 'Subagents' })).toBeUndefined()
  await terminal.unmount()
})
