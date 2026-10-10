import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderSurface } from 'claude-code'

import type { AgentRun, Handoff } from '../types'

const agents = atom({ plugin: 'session-hud', key: 'agents' } as const, [])
const now = atom({ plugin: 'session-hud', key: 'now' } as const, 0)
const handoff = atom({ plugin: 'session-hud', key: 'handoff' } as const, null)

// How long a finished subagent stays on screen before the panel clears.
const LINGER_MS = 8000
// How many past subagent runs the ETA model learns from.
const HISTORY_SIZE = 60
// An auto suggestion goes stale after this many further turns.
const STALE_TURNS = 3

// What a subagent of each type takes before the mod has seen any finish.
const DEFAULT_MS: Record<string, number> = {
  Explore: 90_000,
  Plan: 120_000,
  'general-purpose': 300_000,
}
const DEFAULT_STEPS: Record<string, number> = {
  Explore: 20,
  Plan: 15,
  'general-purpose': 40,
}
const SPINNER = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'

// Colors that read on both light and dark backgrounds.
const ACCENT = '#d97757'
const SUCCESS = '#5fa865'
const ERROR = '#d9534f'

// The width of the section-name column every claude-mods band shares, in cells.
const LABEL_WIDTH = 13

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

  // Time leads; steps only nudge, so a busy agent doesn't jump to the end early.
  const raw = 0.75 * (elapsed / run.expectedMs) + 0.25 * Math.min(1, run.steps / run.expectedSteps)
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
const local = {
  contextPercent: 0,
  turnsSinceCheck: 0,
  isChecking: false,
  wasLive: false,
  isTicking: false,
}

/** Starts the once-a-second redraw that keeps elapsed times and ETAs moving. */
function startTicker($: EngineInterface) {
  if (local.isTicking) return
  local.isTicking = true
  $.clock.every(1000, () => void tick($))
}

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
    : { expectedMs: DEFAULT_MS[type] ?? 180_000, expectedSteps: DEFAULT_STEPS[type] ?? 25 }
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
    $.ui.toast(
      'Could not clear the session; the handoff is on your clipboard. Run /clear and paste it.',
      {
        timeoutMs: 8000,
      },
    )
    return
  }

  await $.prompt.submit({ text: ready.prompt, asUser: true })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    startTicker($)

    // Each step stands alone, so one that fails doesn't stop the others.
    await $.command
      .register({
        name: 'handoff',
        description:
          'Write a starter prompt for a fresh session; a pill above the prompt starts it',
        argumentHint: '[focus] | auto on | auto off',
      })
      .catch(() => undefined)

    const usage = await $.session.usage().catch(() => undefined)
    local.contextPercent = usage?.context.percent ?? 0

    return result
  })

  on('session.measure', async ($, e, next) => {
    // How full the context is decides how soon to suggest a fresh session.
    local.contextPercent = e.context.percent ?? local.contextPercent

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

    return {
      text: 'Writing a handoff. A pill to start the fresh session will appear above the prompt.',
    }
  })

  on('agent.spawn', async ($, e, next) => {
    startTicker($)
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
      await update($, handoff, () =>
        turnsSince >= STALE_TURNS ? null : { ...pending, turnsSince },
      )
    }

    const isAuto = (await $.store.get('autoSuggest')) !== false
    const isBusy = (await read($, agents)).some(run => run.status === 'running')
    const isDue =
      local.turnsSinceCheck >= 4 && (local.contextPercent >= 30 || local.turnsSinceCheck >= 12)

    if (isAuto && isDue && !isBusy && !pending && e.reason === 'answer') {
      local.turnsSinceCheck = 0
      $.clock.after(1500, () => void autoCheck($))
    }

    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // Other mods' sections come first; ours follow, nearer the prompt.
    const above = await next(e)
    if (e.props.hasSurvey) return above

    const [list, pending] = await Promise.all([
      read($, agents),
      read($, handoff),
      // Read so the ticker's writes redraw the band while agents run.
      read($, now),
    ])
    const at = await $.clock.now()
    const shown = list.filter(run => isShown(run, at))

    if (shown.length === 0 && !pending) return above

    const t = $.ui.resolve(e)
    const { Box, Text, Button } = t
    const isDesktop = e.surface === 'desktop'
    const cols = Math.max(30, e.props.bodyColumns)
    const barCells = clamp(Math.floor((cols - LABEL_WIDTH) / 6), 10, 20)
    const hasAbove = ((above as { children?: unknown[] }).children?.length ?? 0) > 0
    const sections: JSX.Element[] = []

    // Every section: its name in a fixed column on the left, its content beside it.
    // A one-line section with buttons centres its name on them; a list keeps it on the first line.
    const section = (label: string, content: JSX.Element, isOneLine = false) => (
      <Box flexDirection="row" gap={2} alignItems={isOneLine ? 'center' : 'flex-start'}>
        <Box width={LABEL_WIDTH} flexShrink={0}>
          <Text dimColor>{label}</Text>
        </Box>
        <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0}>
          {content}
        </Box>
      </Box>
    )

    // A rounded SVG bar where the surface draws SVG, a run of blocks in the terminal.
    const meter = (key: string, fraction: number, fill: string, label: string) => {
      const f = clamp(fraction, 0, 1)

      if ('Svg' in t) {
        const { Svg } = t
        const w = barCells * 8
        const filled = f > 0 ? Math.max(6, Math.round(w * f)) : 0
        const source =
          `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="6" viewBox="0 0 ${w} 6">` +
          `<rect width="${w}" height="6" rx="3" fill="#8b8b8b" fill-opacity="0.25"/>` +
          (filled ? `<rect width="${filled}" height="6" rx="3" fill="${fill}"/>` : '') +
          `</svg>`

        return <Svg key={key} source={source} alt={label} width={w} height={6} />
      }

      const [full, empty] = bar(f, barCells, '━', '─')

      return (
        <Box flexDirection="row">
          <Text color={fill}>{full}</Text>
          <Text dimColor>{empty}</Text>
        </Box>
      )
    }

    if (shown.length > 0) {
      const running = shown.filter(run => run.status === 'running')
      const left = Math.max(0, ...shown.map(run => estimate(run, at).remaining))
      const spin = SPINNER[Math.floor(at / 1000) % SPINNER.length]
      const rows: JSX.Element[] = [
        running.length > 0 ? (
          <Box flexDirection="row" gap={1}>
            <Text bold>{`All done by ~${clockTime(at + left)}`}</Text>
            <Text dimColor>{`·  in ~${duration(left)}`}</Text>
          </Box>
        ) : (
          <Text color={SUCCESS}>All done</Text>
        ),
      ]

      shown.slice(-Math.max(1, Math.floor((e.props.maxRows - 3) / 2))).forEach(run => {
        const { elapsed, progress, remaining } = estimate(run, at)
        const isRunning = run.status === 'running'
        // Braille spinners read as stray dots in a proportional font.
        const glyph = isRunning ? (isDesktop ? '●' : spin) : run.status === 'done' ? '✓' : '✗'
        const tone = run.status === 'failed' ? ERROR : run.status === 'done' ? SUCCESS : ACCENT

        rows.push(
          <Box flexDirection="column" marginTop={isDesktop ? 1 : 0}>
            <Box flexDirection="row" justifyContent="space-between" gap={2}>
              <Box flexDirection="row" gap={1} flexShrink={1} minWidth={0}>
                <Text color={tone}>{glyph}</Text>
                <Text wrap="truncate-end" dimColor={!isRunning}>
                  {run.description}
                </Text>
              </Box>
              {isRunning ? (
                <Box flexDirection="row" gap={1}>
                  <Text>{`done by ~${clockTime(at + remaining)}`}</Text>
                  <Text dimColor>{`·  ~${duration(remaining)}`}</Text>
                </Box>
              ) : (
                <Text dimColor>
                  {run.status === 'done'
                    ? `finished in ${duration(elapsed)}`
                    : `stopped after ${duration(elapsed)}`}
                </Text>
              )}
            </Box>
            {isRunning && (
              <Box flexDirection="row" gap={2} paddingLeft={2} alignItems="center">
                {meter(
                  `bar-${run.toolUseId}`,
                  progress,
                  ACCENT,
                  `about ${Math.round(progress * 100)}% done`,
                )}
                <Box flexShrink={1} minWidth={0}>
                  <Text dimColor wrap="truncate-end">
                    {run.activity}
                  </Text>
                </Box>
              </Box>
            )}
          </Box>,
        )
      })

      sections.push(section('Subagents', <Box flexDirection="column">{rows}</Box>))
    }

    if (pending?.phase === 'writing') {
      sections.push(section('Next session', <Text dimColor>Writing the handoff prompt…</Text>))
    }

    if (pending?.phase === 'ready') {
      sections.push(
        section(
          pending.source === 'auto' ? 'Suggested' : 'Next session',
          <Box
            key="handoff"
            flexDirection="row"
            justifyContent="space-between"
            gap={2}
            alignItems="center"
          >
            <Box flexDirection="row" gap={1} flexShrink={1} minWidth={0}>
              <Text bold wrap="truncate-end">
                {pending.title}
              </Text>
              {pending.reason !== '' && (
                <Text dimColor wrap="truncate-end">
                  {`·  ${pending.reason}`}
                </Text>
              )}
            </Box>
            <Box flexDirection="row" gap={1} flexShrink={0}>
              <Button
                key="handoff-start"
                variant="primary"
                hotkey="s"
                label="Start fresh session"
                onPress={press => startFresh($, pending, press.surface)}
              />
              <Button
                key="handoff-copy"
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
                hotkey="x"
                label="Dismiss"
                onPress={() => update($, handoff, () => null)}
              />
            </Box>
          </Box>,
          true,
        ),
      )
    }

    return (
      <Box flexDirection="column">
        {above}
        <Box
          flexDirection="column"
          gap={isDesktop ? 1 : 0}
          marginTop={isDesktop && hasAbove ? 1 : 0}
        >
          {sections}
        </Box>
      </Box>
    )
  })
}
