import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderSurface, SessionRateLimit } from 'claude-code'

import type { AgentRun, Handoff } from '../types'

const fiveHour = atom({ plugin: 'session-hud', key: 'fiveHour' } as const, null)
const agents = atom({ plugin: 'session-hud', key: 'agents' } as const, [])
const now = atom({ plugin: 'session-hud', key: 'now' } as const, 0)
const handoff = atom({ plugin: 'session-hud', key: 'handoff' } as const, null)

// How long a finished subagent stays on screen before the panel clears.
const LINGER_MS = 8000
// How many past subagent runs the ETA model learns from.
const HISTORY_SIZE = 60
// An auto suggestion goes stale after this many further turns.
const STALE_TURNS = 3

const DEFAULT_MS: Record<string, number> = {
  Explore: 60_000,
  Plan: 90_000,
  'general-purpose': 120_000,
}
const DEFAULT_STEPS = 12
const SPINNER = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'

type Sample = { type: string; ms: number; steps: number }

const HANDOFF_RULES = `The starter prompt goes to a brand-new Claude Code session that has none of this conversation's context. It must stand alone: state the goal; what is already done (file paths, branch, commands, PRs); key decisions and constraints; what remains, as concrete next steps; and how to verify the result. Address the new session directly ("You are continuing..."), keep it tight, no preamble.`

const HANDOFF_FORMAT = `<title>3 to 6 word title of the next work</title>
<handoff>
the starter prompt
</handoff>`

function manualAsk(focus: string): string {
  const target = focus
    ? `Focus the handoff on: ${focus}`
    : 'Focus on the next piece of work we were about to do.'

  return `Stop and do not continue the work. Write a handoff so it can continue in a fresh session.
${target}
${HANDOFF_RULES}
Reply in exactly this format and nothing else:
${HANDOFF_FORMAT}`
}

const AUTO_ASK = `Stop and do not continue the work. Judge one question: would the NEXT piece of work in this conversation go better in a fresh Claude Code session (cleared context) than here?
Say yes only when the next work is a distinct task that needs little of the detail above (a new feature, a separate bug, moving from planning to a large implementation), or when this context is long and mostly no longer relevant to what comes next.
Say no when we are mid-task, debugging something that depends on details above, waiting on an answer from the user, or the conversation is short.
Reply in exactly this format and nothing else:
<decision>yes or no</decision>
<reason>one short sentence, under 12 words, saying why</reason>
Only when the decision is yes, add after it:
${HANDOFF_FORMAT}
${HANDOFF_RULES}`

function tag(text: string, name: string): string | undefined {
  const match = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(text)

  return match?.[1]?.trim() || undefined
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)

  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value))
}

function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`

  return `${Math.floor(m / 60)}h ${m % 60}m`
}

function stopwatch(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))

  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function clockTime(ms: number): string {
  try {
    return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  } catch {
    const d = new Date(ms)

    return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`
  }
}

function fit(text: string, width: number): string {
  if (width <= 0) return ''
  if (text.length <= width) return text.padEnd(width)

  return `${text.slice(0, Math.max(0, width - 1))}…`
}

function bar(fraction: number, width: number, full: string, empty: string): [string, string] {
  const filled = Math.round(clamp(fraction, 0, 1) * width)

  return [full.repeat(filled), empty.repeat(width - filled)]
}

function basename(path: unknown): string {
  return typeof path === 'string' ? (path.split('/').pop() ?? path) : ''
}

/** A few words on what a subagent's tool call is doing. */
export function describeCall(call: Record<string, unknown>): string {
  const tool = String(call.tool)
  const quoted = (value: unknown) => (typeof value === 'string' ? `"${value}"` : '')

  switch (tool) {
    case 'Read':
      return `Reading ${basename(call.file_path)}`
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
      return `Editing ${basename(call.file_path)}`
    case 'Grep':
      return `Searching ${quoted(call.pattern)}`
    case 'Glob':
      return `Finding ${quoted(call.pattern)}`
    case 'Bash':
      return `Running ${String(call.description ?? call.command ?? '')}`
    case 'WebFetch':
      try {
        return `Fetching ${new URL(String(call.url)).host}`
      } catch {
        return 'Fetching a page'
      }
    case 'WebSearch':
      return `Searching the web for ${quoted(call.query)}`
    case 'TodoWrite':
    case 'TaskCreate':
    case 'TaskUpdate':
      return 'Updating its plan'
    default:
      return tool.startsWith('mcp__') ? `Using ${tool.split('__').slice(1).join(' ')}` : tool
  }
}

/** Progress and time left for one run, from its elapsed time, steps and what similar runs took. */
export function estimate(run: AgentRun, at: number) {
  const elapsed = Math.max(0, (run.endedAt ?? at) - run.startedAt)
  if (run.status !== 'running') return { elapsed, progress: 1, remaining: 0 }

  const raw = 0.6 * (elapsed / run.expectedMs) + 0.4 * (run.steps / run.expectedSteps)
  // Linear until 85%, then it eases toward 97% instead of claiming it is done.
  const eased = raw < 0.85 ? raw : 0.85 + 0.12 * (1 - Math.exp(-(raw - 0.85) * 2.5))
  const progress = clamp(eased, 0.01, 0.97)
  const projected = elapsed > 5000 && progress > 0.08 ? elapsed / progress : run.expectedMs
  const total = Math.max(elapsed + 3000, 0.5 * run.expectedMs + 0.5 * projected)

  return { elapsed, progress, remaining: total - elapsed }
}

function isShown(run: AgentRun, at: number): boolean {
  return run.status === 'running' || at - (run.endedAt ?? at) < LINGER_MS
}

function isAgentTool(tool: string): boolean {
  return tool === 'Agent' || tool === 'Task'
}

// The module's own counters: they start over when the mod reloads.
const local = { contextPercent: 0, turnsSinceCheck: 0, isChecking: false, wasLive: false }

async function history($: EngineInterface): Promise<Sample[]> {
  const stored = await $.store.get('agentHistory')

  return Array.isArray(stored) ? (stored as Sample[]) : []
}

async function expectation($: EngineInterface, type: string) {
  const past = await history($)
  const same = past.filter(sample => sample.type === type)
  const basis = same.length >= 3 ? same : past.length >= 3 ? past : []

  return basis.length
    ? {
        expectedMs: median(basis.map(sample => sample.ms)),
        expectedSteps: Math.max(1, median(basis.map(sample => sample.steps))),
      }
    : { expectedMs: DEFAULT_MS[type] ?? 90_000, expectedSteps: DEFAULT_STEPS }
}

async function finish(
  $: EngineInterface,
  matches: (run: AgentRun) => boolean,
  status: AgentRun['status'],
) {
  const at = await $.clock.now()
  const run = (await read($, agents)).find(one => one.status === 'running' && matches(one))
  if (!run) return

  await update($, agents, list =>
    list.map(one =>
      one.toolUseId === run.toolUseId && one.status === 'running'
        ? { ...one, status, endedAt: at, activity: status === 'done' ? 'Done' : 'Stopped' }
        : one,
    ),
  )
  await update($, now, () => at)

  if (status === 'done') {
    const sample: Sample = { type: run.type, ms: at - run.startedAt, steps: run.steps }
    await $.store.set('agentHistory', [...(await history($)), sample].slice(-HISTORY_SIZE))
  }
}

async function saveRate($: EngineInterface, limits: readonly SessionRateLimit[]) {
  const window = limits.find(limit => limit.kind === 'five_hour')
  await update($, fiveHour, () =>
    window ? { percent: window.percentUsed, resetsAt: window.resetsAt } : null,
  )
}

async function tick($: EngineInterface) {
  const at = await $.clock.now()
  const isLive = (await read($, agents)).some(run => isShown(run, at))
  if (isLive || local.wasLive) await update($, now, () => at)
  local.wasLive = isLive
}

async function writeHandoff($: EngineInterface, focus: string) {
  const reply = await $.model.fork({ prompt: manualAsk(focus) }).catch((error: unknown) => ({
    isAnswered: false as const,
    reason: error instanceof Error ? error.message : 'the request failed',
  }))
  const prompt = reply.isAnswered ? (tag(reply.text, 'handoff') ?? reply.text.trim()) : undefined

  if (!prompt) {
    await update($, handoff, () => null)
    const why = reply.isAnswered ? 'the reply was empty' : reply.reason
    $.ui.toast(`Couldn't write a handoff (${why}).`)
    return
  }

  const title = (reply.isAnswered && tag(reply.text, 'title')) || 'Continue in a fresh session'
  await update($, handoff, () => ({
    phase: 'ready' as const,
    source: 'manual' as const,
    title,
    reason: '',
    prompt,
    turnsSince: 0,
  }))
}

async function autoCheck($: EngineInterface) {
  if (local.isChecking || (await read($, handoff))) return
  local.isChecking = true

  try {
    const reply = await $.model.fork({ prompt: AUTO_ASK }).catch(() => undefined)
    if (!reply?.isAnswered) return
    if (tag(reply.text, 'decision')?.toLowerCase() !== 'yes') return

    const prompt = tag(reply.text, 'handoff')
    if (!prompt || (await read($, handoff))) return

    await update($, handoff, () => ({
      phase: 'ready' as const,
      source: 'auto' as const,
      title: tag(reply.text, 'title') ?? 'Next task',
      reason: tag(reply.text, 'reason') ?? 'fits a fresh session',
      prompt,
      turnsSince: 0,
    }))
    $.ui.toast('The next task fits a fresh session: the handoff is ready above the prompt.')
  } finally {
    local.isChecking = false
  }
}

async function startFresh($: EngineInterface, ready: Handoff, surface: RenderSurface) {
  if (ready.phase !== 'ready') return

  await update($, handoff, () => null)
  await $.ui.copy({ text: ready.prompt, surface }).catch(() => undefined)

  try {
    await $.command.run({ command: 'clear' })
  } catch {
    await update($, handoff, () => ready)
    $.ui.toast('Could not clear the session; the handoff is on your clipboard. Run /clear and paste it.', {
      timeoutMs: 8000,
    })
    return
  }

  await $.prompt.submit({ text: ready.prompt, asUser: true })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)

    await $.command.register({
      name: 'handoff',
      description: 'Write a starter prompt for a fresh session; a pill above the prompt starts it',
      argumentHint: '[focus] | auto on | auto off',
    })

    const usage = await $.session.usage()
    local.contextPercent = usage.context.percent ?? 0
    await saveRate($, usage.rateLimits)

    $.clock.every(1000, () => void tick($))

    return result
  })

  on('session.measure', async ($, e, next) => {
    local.contextPercent = e.context.percent ?? local.contextPercent
    if (e.changed.includes('rateLimits')) await saveRate($, e.rateLimits)

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      local.turnsSinceCheck = 0
      local.contextPercent = 0
      await update($, agents, () => [])
      await update($, handoff, () => null)
    }

    return next(e)
  })

  on('command.run', { command: 'handoff' }, async ($, e) => {
    const args = (e.args ?? '').trim()
    const toggle = /^auto\s+(on|off)$/i.exec(args)

    if (toggle) {
      const isOn = toggle[1]!.toLowerCase() === 'on'
      await $.store.set('autoSuggest', isOn)

      return { text: `Handoff suggestions are ${isOn ? 'on' : 'off'}.` }
    }

    if (await read($, handoff)) await update($, handoff, () => null)
    await update($, handoff, () => ({ phase: 'writing' as const, source: 'manual' as const }))
    $.clock.after(0, () => void writeHandoff($, args))

    return { text: 'Writing a handoff. A pill to start the fresh session will appear above the prompt.' }
  })

  on('agent.spawn', async ($, e, next) => {
    const at = await $.clock.now()
    const run: AgentRun = {
      toolUseId: e.tool_use_id,
      description: e.description || e.subagentType,
      type: e.subagentType,
      startedAt: at,
      isBackground: e.background,
      status: 'running',
      steps: 0,
      activity: 'Starting',
      ...(await expectation($, e.subagentType)),
    }

    await update($, agents, list => [...list.filter(one => isShown(one, at)), run].slice(-12))
    await update($, now, () => at)

    const result = await next(e)

    await update($, agents, list =>
      result.deny !== undefined
        ? list.filter(one => one.toolUseId !== run.toolUseId)
        : list.map(one =>
            one.toolUseId === run.toolUseId ? { ...one, agentId: result.agentId } : one,
          ),
    )

    return result
  })

  on('tool.call', async ($, e, next) => {
    const agentId = e.agentId

    if (agentId !== undefined) {
      const activity = describeCall(e as unknown as Record<string, unknown>)
      await update($, agents, list => {
        // A subagent's first calls can land before its spawn resolved its id.
        const owner =
          list.find(one => one.agentId === agentId) ??
          [...list].reverse().find(one => one.status === 'running' && one.agentId === undefined)

        return list.map(one =>
          one === owner ? { ...one, agentId, steps: one.steps + 1, activity } : one,
        )
      })

      return next(e)
    }

    const ran = await next(e)

    // A foreground Agent call returns when its subagent is finished.
    if (isAgentTool(String(e.tool))) {
      await finish(
        $,
        one => one.toolUseId === e.tool_use_id && !one.isBackground,
        ran.deny === undefined && !ran.isError ? 'done' : 'failed',
      )
    }

    return ran
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    const agentId = e.agentId

    if (agentId !== undefined) {
      await finish($, one => one.agentId === agentId, e.reason === 'answer' ? 'done' : 'failed')
      return result
    }

    local.turnsSinceCheck += 1

    const pending = await read($, handoff)
    if (pending?.phase === 'ready' && pending.source === 'auto') {
      const turnsSince = pending.turnsSince + 1
      await update($, handoff, () => (turnsSince >= STALE_TURNS ? null : { ...pending, turnsSince }))
    }

    const isAuto = (await $.store.get('autoSuggest')) !== false
    const isBusy = (await read($, agents)).some(run => run.status === 'running')
    const isDue = local.turnsSinceCheck >= 4 && (local.contextPercent >= 30 || local.turnsSinceCheck >= 12)

    if (isAuto && isDue && !isBusy && !pending && e.reason === 'answer') {
      local.turnsSinceCheck = 0
      $.clock.after(1500, () => void autoCheck($))
    }

    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)

    const [rate, list, tickAt, pending] = await Promise.all([
      read($, fiveHour),
      read($, agents),
      read($, now),
      read($, handoff),
    ])
    const at = Math.max(tickAt, ...list.map(run => run.endedAt ?? run.startedAt))
    const shown = list.filter(run => isShown(run, at))

    if (!rate && shown.length === 0 && !pending) return next(e)

    const { Box, Text, Button } = $.ui.resolve(e)
    const cols = Math.max(20, e.props.bodyColumns)
    const rows: JSX.Element[] = []

    if (shown.length > 0) {
      const running = shown.filter(run => run.status === 'running')
      const estimates = shown.map(run => estimate(run, at))
      const left = Math.max(0, ...estimates.map(one => one.remaining))
      const done = shown.length - running.length
      const spin = SPINNER[Math.floor(at / 1000) % SPINNER.length]

      rows.push(
        <Box flexDirection="row">
          <Text color="magenta" bold>
            {running.length ? '◆ ' : '◇ '}
          </Text>
          <Text bold>
            {running.length
              ? `${running.length} subagent${running.length === 1 ? '' : 's'} working`
              : 'Subagents finished'}
          </Text>
          <Text dimColor wrap="truncate-end">
            {` · ${done}/${shown.length} done`}
            {running.length ? ` · ~${duration(left)} left · done ≈ ${clockTime(at + left)}` : ''}
          </Text>
        </Box>,
      )

      const isWide = cols >= 72
      const hasBar = cols >= 52
      const nameWidth = clamp(Math.floor(cols * 0.28), 12, 32)
      const typeWidth = 10
      const room = Math.max(1, e.props.maxRows - 1 - (pending ? 1 : 0) - (rate ? 1 : 0))

      shown.slice(-room).forEach(run => {
        const { elapsed, progress, remaining } = estimate(run, at)
        const glyph = run.status === 'running' ? spin : run.status === 'done' ? '✓' : '✗'
        const [full, empty] = bar(progress, 10, '▰', '▱')
        const tail = run.status === 'running' ? `~${duration(remaining)} left` : `in ${duration(elapsed)}`
        const used = 4 + nameWidth + typeWidth + (hasBar ? 16 : 0) + 7 + tail.length + 2

        rows.push(
          <Box flexDirection="row">
            <Text color={run.status === 'failed' ? 'red' : 'magenta'}>{`  ${glyph} `}</Text>
            <Text>{fit(run.description, nameWidth)}</Text>
            <Text dimColor>{fit(` ${run.type}`, typeWidth)}</Text>
            {hasBar && <Text color={run.status === 'failed' ? 'red' : 'magenta'}>{` ${full}`}</Text>}
            {hasBar && <Text dimColor>{`${empty} ${String(Math.round(progress * 100)).padStart(3)}%`}</Text>}
            <Text dimColor>{` ${stopwatch(elapsed).padStart(5)} · ${tail}`}</Text>
            {isWide && cols - used > 8 && (
              <Text dimColor italic wrap="truncate-end">
                {`  ${fit(run.activity, cols - used).trimEnd()}`}
              </Text>
            )}
          </Box>,
        )
      })
    }

    if (pending?.phase === 'writing') {
      rows.push(
        <Box flexDirection="row">
          <Text color="cyan">◌ </Text>
          <Text dimColor>Writing handoff prompt…</Text>
        </Box>,
      )
    }

    if (pending?.phase === 'ready') {
      rows.push(
        <Box key="handoff" flexDirection="row" gap={1}>
          <Text color="cyan">{pending.source === 'auto' ? '✦' : '⇢'}</Text>
          <Text bold wrap="truncate-end">
            {pending.title}
          </Text>
          {pending.reason !== '' && (
            <Text dimColor wrap="truncate-end">
              {`· ${pending.reason}`}
            </Text>
          )}
          <Button
            key="handoff-start"
            variant="primary"
            hotkey="s"
            label="Start fresh session"
            onPress={press => startFresh($, pending, press.surface)}
          />
          <Button
            key="handoff-copy"
            dimColor
            hotkey="c"
            label="Copy"
            onPress={async press => {
              const copied = await $.ui.copy({ text: pending.prompt, surface: press.surface })
              $.ui.toast(copied.isCopied ? 'Handoff copied.' : 'Could not reach the clipboard.')
            }}
          />
          <Button
            key="handoff-dismiss"
            role="dismiss"
            dimColor
            hotkey="x"
            label="✕"
            onPress={() => update($, handoff, () => null)}
          />
        </Box>,
      )
    }

    if (rate) {
      const width = clamp(Math.floor(cols / 5), 10, 24)
      const [full, empty] = bar(rate.percent / 100, width, '━', '─')
      const color = rate.percent >= 90 ? 'red' : rate.percent >= 70 ? 'yellow' : 'cyan'
      const resets = rate.resetsAt ? Date.parse(rate.resetsAt) : NaN

      rows.push(
        <Box flexDirection="row">
          <Text dimColor>5h </Text>
          <Text color={color} dimColor={rate.percent < 70}>
            {full}
          </Text>
          <Text dimColor>{empty}</Text>
          <Text dimColor wrap="truncate-end">
            {` ${Math.round(rate.percent)}%`}
            {Number.isNaN(resets) ? '' : ` · resets ${clockTime(resets)}`}
          </Text>
        </Box>,
      )
    }

    return <Box flexDirection="column">{rows}</Box>
  })
}
