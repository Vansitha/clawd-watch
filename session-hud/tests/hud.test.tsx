import { expect, mock, test } from 'claude-code/testing'
import type { AgentRun } from '../types'
import { describeCall, estimate } from '../hooks/register'

const usage = {
  input_tokens: 1,
  output_tokens: 1,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
}

const band = (bodyColumns = 120) => ({
  plugin: 'session-hud',
  component: 'AbovePrompt' as const,
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 12,
    bodyColumns,
    scroll: { offset: 0, bodyRows: 11 },
    view: {},
  },
})

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
    const ui = await $.ui.mount({ ...band(), surface })
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

    const ui = await $.ui.mount({ ...band(), surface })
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
    const view = await $.ui.mount({ ...band(), surface })
    expect(await view.find({ type: 'Text', text: 'Subagents' })).toBeDefined()
    expect(await view.find({ type: 'Text', text: /^All done by ~/ })).toBeDefined()
    expect(await view.find({ type: 'Text', text: /^done by ~/ })).toBeDefined()
    expect(await view.find({ type: 'Text', text: /Find auth handlers/ })).toBeDefined()
    // A progress bar: rounded SVG on the desktop, a run of blocks in the terminal.
    if (surface === 'desktop') expect(await view.find({ type: 'Svg' })).toBeDefined()
    else expect(await view.find({ type: 'Text', text: /─/ })).toBeDefined()
    await view.unmount()
  }

  const ui = await $.ui.mount({ ...band(), surface: 'desktop' })

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

    const terminal = await $.ui.mount({ ...band(), surface: 'terminal' })
    expect(await terminal.find({ type: 'Text', text: 'Subagents' })).toBeUndefined()
    await terminal.unmount()

    const desktop = await $.ui.mount({ ...band(), surface: 'desktop' })
    expect(await desktop.find({ type: 'Text', text: 'Subagents' })).toBeDefined()
    await desktop.unmount()
  },
)

test('a background subagent that ends unseen is marked done from the agent list', async ($, on) => {
  const clock = mock.clock(on, { now: 2_000_000 })
  mock.store(on)
  let status = 'running'
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

  const ui = await $.ui.mount({ ...band(), surface: 'desktop' })
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

  const ui = await $.ui.mount({ ...band(), surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: 'Subagents' })).toBeUndefined()
  await ui.unmount()
})
