import { expect, mock, test } from 'claude-code/testing'
import type { AgentRun } from '../types'
import { describeCall, estimate } from '../hooks/register'

const usage = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

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

test('the 5-hour meter shows above the prompt once a reading arrives', async ($, on) => {
  on('session.measure', ($, e) => ({ changed: e.changed }))
  await $.session.measure({
    context: { window: 200_000, percent: 12 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 42.5, resetsAt: '2026-10-03T18:00:00Z' }],
    changed: ['rateLimits'],
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...band(), surface })
    expect(await ui.find({ type: 'Text', text: /43%.*resets/ })).toBeDefined()
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
    await ui.press({ key: 'handoff-start' })

    expect(ran).toEqual(['clear'])
    expect(submitted).toBe('You are continuing the login work.')
    expect(await ui.find({ key: 'handoff-start' })).toBeUndefined()
    await ui.unmount()
  }
})

test('a running subagent shows its task, then finishes', async ($, on) => {
  mock.clock(on, { now: 2_000_000 })
  mock.store(on)
  on('agent.spawn', () => ({ model: 'm', agentId: 'agent-1' }))
  on('turn.complete', () => ({ text: '' }))

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
    expect(await view.find({ type: 'Text', text: '1 subagent working' })).toBeDefined()
    expect(await view.find({ type: 'Text', text: /Find auth handlers/ })).toBeDefined()
    await view.unmount()
  }

  const ui = await $.ui.mount({ ...band(), surface: 'desktop' })

  await $.turn.complete({
    answer: 'found',
    durationMs: 1000,
    isAborted: false,
    turnId: 't1',
    agentId: 'agent-1',
    reason: 'answer',
  })
  expect(await ui.find({ type: 'Text', text: 'Subagents finished' })).toBeDefined()
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
