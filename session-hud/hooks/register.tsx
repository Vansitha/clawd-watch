import { atom, read, update } from 'claude-code'
import type { ElementTable, EngineInterface, Register, RenderSurface, Timer } from 'claude-code'

import type { AgentRun, Handoff, Panel } from '../types'

type ReadyHandoff = Extract<Handoff, { phase: 'ready' }>
type Sample = { type: string; ms: number; steps: number; guessMs?: number; guessSteps?: number }
type Style = { isText: boolean; isStacked: boolean; barCells: number }

const agents = atom({ plugin: 'session-hud', key: 'agents' } as const, [])
const now = atom({ plugin: 'session-hud', key: 'now' } as const, 0)
const handoff = atom({ plugin: 'session-hud', key: 'handoff' } as const, null)

// Shared by every Clawd Watch mod; keep these identical across them.
const LABEL_WIDTH = 17
const NARROW_COLUMNS = 72
const HINT_KEY = 'clawd-watch-hint'
const HINT_TEXT = 'ctrl+x tab'
/** The desktop app's cards: the prompt box's own border colour, and their inner spacing. */
const CARD_BORDER = 'promptBorder'
const CARD_PADDING = { x: 2, y: 1 }
/** Rows between sections, and between cards. */
const SECTION_GAP = 1
const PANEL_KEY = 'clawd-watch-panel'
const PANEL_NAME = 'Clawd Watch'
const STORE_PANEL = 'panel'
/** Each mod keeps its own copy of whether the panel is folded; the latest change wins. */
const HUD_PANEL = atom({ plugin: 'session-hud', key: 'panel' } as const, null)
const QUEUE_PANEL = atom({ plugin: 'message-queue', key: 'panel' } as const, null)
const DOCK_PANEL = atom({ plugin: 'skill-dock', key: 'panel' } as const, null)
/** What the folded panel sums up, read from the mods that own it. */
const SUBAGENTS = atom({ plugin: 'session-hud', key: 'agents' } as const, [])
const NEXT_SESSION = atom({ plugin: 'session-hud', key: 'handoff' } as const, null)
const QUEUED = atom({ plugin: 'message-queue', key: 'messages' } as const, [])
/** This mod's own copy, the one it writes. */
const OWN_PANEL = atom({ plugin: 'session-hud', key: 'panel' } as const, null)
const OWN_CARDS = atom({ plugin: 'session-hud', key: 'collapsedCards' } as const, [])
const STORE_CARDS = 'collapsedCards'

// Colors that read on both light and dark backgrounds.
const ACCENT = '#d97757'
const SUCCESS = '#5fa865'
const ERROR = '#d9534f'
const BAR_TRACK = '#8b8b8b'

const TICK_MS = 1000
const SPINNER = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
/** How long a finished subagent stays on screen. */
const LINGER_MS = 8000
const MAX_AGENT_ROWS = 12
/** Rows the band spends on things other than agent rows, and the rows each agent takes. */
const BAND_CHROME_ROWS = 3
const ROWS_PER_AGENT = { terminal: 2, graphical: 1 }
/** Cells for the time at the end of a desktop row, so the bars and times line up. */
const TIME_COLUMN = 18
/** Check running rows against the engine's agent list this often, in ticks. */
const RECONCILE_EVERY_TICKS = 10

/** Past runs the ETA model learns from, and how many of a type it needs before trusting them. */
const HISTORY_SIZE = 60
const MIN_SAMPLES = 3
/** What a subagent takes before any run of its type has been seen. */
const DEFAULT_MS: Record<string, number> = {
  Explore: 90_000,
  Plan: 120_000,
  'general-purpose': 300_000,
}
const DEFAULT_STEPS: Record<string, number> = { Explore: 20, Plan: 15, 'general-purpose': 40 }
const FALLBACK_MS = 180_000
const FALLBACK_STEPS = 25

/** Claude sizes each subagent's task from its instructions, with a small, fast model. */
const SIZE_MODEL = 'haiku'
const SIZE_TIMEOUT_MS = 20_000
const SIZE_MAX_TOKENS = 200
/** How much of a subagent's instructions the sizing call reads. */
const SIZE_PROMPT_CHARS = 6000
/** Bounds on a guess, and on how far learned corrections may stretch or shrink one. */
const GUESS_MINUTES = { min: 0.2, max: 180 }
const GUESS_STEPS = { min: 1, max: 1000 }
const CORRECTION = { min: 0.25, max: 4 }
const SIZE_RULES = `You estimate how long a Claude Code subagent will take to finish its task. A subagent works alone with tools: it reads and searches files, edits code and runs commands, one tool call at a time, then reports back.

Judge the size of the work in the instructions: how many files it must read or change, whether it must run builds or tests, how open-ended it is. For reference, one tool call takes about 5 to 20 seconds. A quick lookup is about 1 to 2 minutes and 10 tool calls. Reading through a feature to explain it is about 3 to 6 minutes and 20 to 50 calls. Implementing and testing a change is about 8 to 25 minutes and 50 to 150 calls.

Reply with exactly this and nothing else:
<minutes>N</minutes><steps>M</steps>
N is wall-clock minutes (decimals allowed) and M is the number of tool calls.`

/** When to ask Claude whether the next work fits a fresh session. */
const CHECK_AFTER_TURNS = 4
const CHECK_AT_CONTEXT_PERCENT = 30
const CHECK_ALWAYS_AFTER_TURNS = 12
const CHECK_DELAY_MS = 1500
/** An unused suggestion clears after this many more turns. */
const STALE_TURNS = 3

const MIN_BAND_COLUMNS = 30
const COLUMNS_PER_BAR_CELL = 6
const BAR_MIN_CELLS = 10
const BAR_MAX_CELLS = 20
const BAR_PX_PER_CELL = 8
const BAR_HEIGHT_PX = 6
const LONG_TOAST_MS = 8000

const STORE_HISTORY = 'agentHistory'
const STORE_AUTO_SUGGEST = 'autoSuggest'

const STATUS_LOOK: Record<AgentRun['status'], { glyph: string; tone: string; verb: string }> = {
  running: { glyph: '●', tone: ACCENT, verb: '' },
  done: { glyph: '✓', tone: SUCCESS, verb: 'finished in' },
  failed: { glyph: '✗', tone: ERROR, verb: 'stopped after' },
}

const HANDOFF_RULES = `The starter prompt goes to a brand-new Claude Code session that has none of this conversation's context. It must stand alone: state the goal; what is already done (file paths, branch, commands, PRs); key decisions and constraints; what remains, as concrete next steps; and how to verify the result. Address the new session directly ("You are continuing..."), keep it tight, no preamble.`

const HANDOFF_FORMAT = `<title>3 to 6 word title of the next work</title>
<handoff>
the starter prompt
</handoff>`

const AUTO_ASK = `Stop and do not continue the work. Judge one question: would the NEXT piece of work in this conversation go better in a fresh Claude Code session (cleared context) than here?
Say yes only when the next work is a distinct task that needs little of the detail above (a new feature, a separate bug, moving from planning to a large implementation), or when this context is long and mostly no longer relevant to what comes next.
Say no when we are mid-task, debugging something that depends on details above, waiting on an answer from the user, or the conversation is short.
Reply in exactly this format and nothing else:
<decision>yes or no</decision>
<reason>one short sentence, under 12 words, saying why</reason>
Only when the decision is yes, add after it:
${HANDOFF_FORMAT}
${HANDOFF_RULES}`

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

const local: {
  contextPercent: number
  turnsSinceCheck: number
  isChecking: boolean
  wasLive: boolean
  ticks: number
  ticker?: Timer
  history?: Sample[]
} = { contextPercent: 0, turnsSinceCheck: 0, isChecking: false, wasLive: false, ticks: 0 }

/** Whether a drawn tree already holds an element with this key. */
function hasKey(node: unknown, key: string): boolean {
  if (!node || typeof node !== 'object') return false
  const element = node as { props?: { key?: unknown }; children?: unknown[] }

  return element.props?.key === key || (element.children ?? []).some(c => hasKey(c, key))
}

/** Whether another mod drew anything above this one. */
function hasContent(tree: unknown): boolean {
  return ((tree as { children?: unknown[] }).children?.length ?? 0) > 0
}

/** Whether the panel is folded: the most recent choice made in any Clawd Watch mod. */
async function isFolded($: EngineInterface): Promise<boolean> {
  const choices = await Promise.all([read($, HUD_PANEL), read($, QUEUE_PANEL), read($, DOCK_PANEL)])
  const latest = choices.reduce<Panel | null>(
    (best, one) => (one && (!best || one.at > best.at) ? one : best),
    null,
  )

  return latest?.isFolded ?? false
}

async function setFolded($: EngineInterface, isFolded: boolean) {
  const choice = { isFolded, at: await $.clock.now() }
  await Promise.all([update($, OWN_PANEL, () => choice), $.store.set(STORE_PANEL, choice)])
}

/** Restores the panel's last fold, kept across sessions. */
async function loadFolded($: EngineInterface) {
  const stored = (await $.store.get(STORE_PANEL)) as Panel | undefined
  if (typeof stored?.isFolded === 'boolean' && typeof stored.at === 'number') {
    await update($, OWN_PANEL, () => stored)
  }
}

/** Collapses a card, or opens it again, and keeps that for later sessions. */
async function toggleCard($: EngineInterface, name: string) {
  const list = await update($, OWN_CARDS, all =>
    all.includes(name) ? all.filter(one => one !== name) : [...all, name],
  )
  await $.store.set(STORE_CARDS, list)
}

async function loadCards($: EngineInterface) {
  const stored = await $.store.get(STORE_CARDS)
  if (Array.isArray(stored)) {
    await update($, OWN_CARDS, () => stored.filter((one): one is string => typeof one === 'string'))
  }
}

/** A section's card in the desktop app, collapsed as it was left; the terminal draws no cards. */
function cardFor(
  $: EngineInterface,
  isText: boolean,
  collapsed: readonly string[],
  name: string,
): Card | undefined {
  if (isText) return undefined

  return {
    key: `card-${name.toLowerCase().replace(/\W+/g, '-')}`,
    isCollapsed: collapsed.includes(name),
    onToggle: () => toggleCard($, name),
  }
}

/** The folded panel's one line: what is running, queued or ready. */
async function foldedSummary($: EngineInterface): Promise<string> {
  const [agents, next, queued] = await Promise.all([
    read($, SUBAGENTS),
    read($, NEXT_SESSION),
    read($, QUEUED),
  ])
  const running = agents.filter(run => run.status === 'running').length
  const parts = [
    running > 0 ? `${running} subagent${running === 1 ? '' : 's'} running` : '',
    queued.length > 0 ? `${queued.length} queued` : '',
    next?.phase === 'ready' ? 'next session ready' : '',
  ]

  return parts.filter(part => part !== '').join('  ·  ')
}

/** The panel's top row: its name, which folds or unfolds it, and when folded, the summary. */
function panelBar($: EngineInterface, t: ElementTable, isFolded: boolean, summary: string) {
  const { Box, Text, Button } = t

  return (
    <Box key={PANEL_KEY} flexDirection="row" gap={2} alignItems="center">
      <Button
        key="clawd-watch-fold"
        plain
        dimColor
        hotkey="h"
        label={`${isFolded ? '▸' : '▾'} ${PANEL_NAME}`}
        onPress={() => setFolded($, !isFolded)}
      />
      {summary !== '' && (
        <Box flexShrink={1} minWidth={0}>
          <Text dimColor wrap="truncate-end">
            {summary}
          </Text>
        </Box>
      )}
    </Box>
  )
}

/**
 * Places this mod's sections in the panel. The first mod to draw adds the panel's top row; folded,
 * that row is all there is, and the other mods add nothing.
 */
async function inPanel(
  $: EngineInterface,
  t: ElementTable,
  above: JSX.Element,
  content: JSX.Element,
) {
  const { Box } = t
  const isFirst = !hasKey(above, PANEL_KEY)
  const gap = hasContent(above) ? SECTION_GAP : 0
  const folded = await isFolded($)
  if (folded && !isFirst) return above

  return (
    <Box flexDirection="column">
      {above}
      {isFirst && (
        <Box flexDirection="column" marginTop={gap}>
          {panelBar($, t, folded, folded ? await foldedSummary($) : '')}
        </Box>
      )}
      {!folded && (
        <Box flexDirection="column" marginTop={isFirst ? 1 : gap}>
          {content}
        </Box>
      )}
    </Box>
  )
}

/** Whether the "Show in" setting (both, desktop or terminal) includes a surface. */
export function runsOn(showIn: string, surface: RenderSurface): boolean {
  if (showIn === 'desktop') return surface !== 'terminal'
  if (showIn === 'terminal') return surface === 'terminal'

  return true
}

/** Whether the mod runs in this session, judged by the surfaces drawing it right now. */
async function isActive($: EngineInterface, showIn: string): Promise<boolean> {
  if (showIn === 'both') return true
  const surfaces = await $.session.surfaces()

  // Until a client attaches (the desktop app, the SDK) nothing rules the mod out.
  return surfaces.length === 0 || surfaces.some(surface => runsOn(showIn, surface))
}

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

export function clockTime(ms: number): string {
  try {
    return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  } catch {
    const d = new Date(ms)

    return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`
  }
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

function readyHandoff(
  source: ReadyHandoff['source'],
  title: string,
  reason: string,
  prompt: string,
): ReadyHandoff {
  return { phase: 'ready', source, title, reason, prompt, turnsSince: 0 }
}

/** Redraws once a second while subagents are on screen, so times keep moving. */
function startTicker($: EngineInterface) {
  local.ticker ??= $.clock.every(TICK_MS, () => void tick($))
}

async function tick($: EngineInterface) {
  const [at, list] = await Promise.all([$.clock.now(), read($, agents)])
  const isLive = list.some(run => isShown(run, at))
  if (isLive || local.wasLive) await update($, now, () => at)
  local.wasLive = isLive

  if (!isLive) {
    local.ticker?.cancel()
    local.ticker = undefined
    return
  }

  local.ticks += 1
  if (local.ticks % RECONCILE_EVERY_TICKS === 0) await reconcile($, list)
}

/** Ends rows whose subagent the engine says has stopped, should its last turn have gone unseen. */
async function reconcile($: EngineInterface, list: readonly AgentRun[]) {
  const watched = list.filter(run => run.status === 'running' && run.agentId !== undefined)
  if (watched.length === 0) return

  const infos = await $.agent.list().catch(() => [])
  const statusById = new Map(infos.map(info => [info.id, info.status]))
  for (const run of watched) {
    const status = statusById.get(run.agentId!)
    if (status === undefined || status === 'running') continue
    await finish($, one => one.agentId === run.agentId, status === 'completed' ? 'done' : 'failed')
  }
}

async function history($: EngineInterface): Promise<Sample[]> {
  if (!local.history) {
    const stored = await $.store.get(STORE_HISTORY)
    local.history = Array.isArray(stored) ? (stored as Sample[]) : []
  }

  return local.history
}

async function remember($: EngineInterface, sample: Sample) {
  local.history = [...(await history($)), sample].slice(-HISTORY_SIZE)
  await $.store.set(STORE_HISTORY, local.history)
}

async function expectation($: EngineInterface, type: string) {
  const past = await history($)
  const same = past.filter(sample => sample.type === type)
  const basis = same.length >= MIN_SAMPLES ? same : past.length >= MIN_SAMPLES ? past : []

  return basis.length
    ? {
        expectedMs: median(basis.map(sample => sample.ms)),
        expectedSteps: Math.max(1, median(basis.map(sample => sample.steps))),
      }
    : {
        expectedMs: DEFAULT_MS[type] ?? FALLBACK_MS,
        expectedSteps: DEFAULT_STEPS[type] ?? FALLBACK_STEPS,
      }
}

/** Claude's guess at a task's minutes and tool calls, or undefined when the reply holds none. */
export function parseSize(text: string): { ms: number; steps: number } | undefined {
  const minutes = Number(tag(text, 'minutes'))
  const steps = Number(tag(text, 'steps'))
  if (!(minutes > 0) || !(steps > 0)) return undefined

  return {
    ms: clamp(minutes, GUESS_MINUTES.min, GUESS_MINUTES.max) * 60_000,
    steps: Math.round(clamp(steps, GUESS_STEPS.min, GUESS_STEPS.max)),
  }
}

/** How actual runs compared with Claude's guesses: the median ratio, 1 until there are enough. */
export function correction(past: readonly Sample[], ratio: (sample: Sample) => number | undefined) {
  const ratios = past.map(ratio).filter((r): r is number => r !== undefined && Number.isFinite(r))
  if (ratios.length < MIN_SAMPLES) return 1

  return clamp(median(ratios), CORRECTION.min, CORRECTION.max)
}

/** Asks Claude to size a subagent's task, then sets the run's expectations from its answer. */
async function sizeRun($: EngineInterface, toolUseId: string, task: string) {
  const reply = await $.model
    .complete({
      model: SIZE_MODEL,
      system: SIZE_RULES,
      prompt: task,
      effort: 'low',
      maxTokens: SIZE_MAX_TOKENS,
      timeoutMs: SIZE_TIMEOUT_MS,
    })
    .catch(() => undefined)
  const guess = reply?.isAnswered ? parseSize(reply.text) : undefined
  const past = await history($)
  // Without a guess, the expectations from past runs that the row started with stay.
  const sized = guess && {
    guessMs: guess.ms,
    guessSteps: guess.steps,
    expectedMs: guess.ms * correction(past, s => (s.guessMs ? s.ms / s.guessMs : undefined)),
    expectedSteps: Math.max(
      1,
      Math.round(
        guess.steps * correction(past, s => (s.guessSteps ? s.steps / s.guessSteps : undefined)),
      ),
    ),
  }

  await update($, agents, list =>
    list.map(one => (one.toolUseId === toolUseId ? { ...one, ...sized, isSizing: false } : one)),
  )
}

async function finish(
  $: EngineInterface,
  matches: (run: AgentRun) => boolean,
  status: AgentRun['status'],
) {
  const [at, list] = await Promise.all([$.clock.now(), read($, agents)])
  const run = list.find(one => one.status === 'running' && matches(one))
  if (!run) return

  await Promise.all([
    update($, agents, all =>
      all.map(one =>
        one.toolUseId === run.toolUseId && one.status === 'running'
          ? { ...one, status, endedAt: at }
          : one,
      ),
    ),
    update($, now, () => at),
  ])

  if (status === 'done') {
    await remember($, {
      type: run.type,
      ms: at - run.startedAt,
      steps: run.steps,
      ...(run.guessMs ? { guessMs: run.guessMs, guessSteps: run.guessSteps } : {}),
    })
  }
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
  await update($, handoff, () => readyHandoff('manual', title, '', prompt))
}

async function autoCheck($: EngineInterface) {
  if (local.isChecking || (await read($, handoff))) return
  local.isChecking = true

  try {
    const reply = await $.model.fork({ prompt: AUTO_ASK }).catch(() => undefined)
    if (!reply?.isAnswered || tag(reply.text, 'decision')?.toLowerCase() !== 'yes') return

    const prompt = tag(reply.text, 'handoff')
    if (!prompt || (await read($, handoff))) return

    const title = tag(reply.text, 'title') ?? 'Next task'
    const reason = tag(reply.text, 'reason') ?? 'fits a fresh session'
    await update($, handoff, () => readyHandoff('auto', title, reason, prompt))
    $.ui.toast('The next task fits a fresh session: the handoff is ready above the prompt.')
  } finally {
    local.isChecking = false
  }
}

async function startFresh($: EngineInterface, ready: ReadyHandoff, surface: RenderSurface) {
  await update($, handoff, () => null)
  await $.ui.copy({ text: ready.prompt, surface }).catch(() => undefined)

  try {
    await $.command.run({ command: 'clear' })
  } catch {
    await update($, handoff, () => ready)
    $.ui.toast(
      'Could not clear the session; the handoff is on your clipboard. Run /clear and paste it.',
      { timeoutMs: LONG_TOAST_MS },
    )
    return
  }

  await $.prompt.submit({ text: ready.prompt, asUser: true })
}

async function copyHandoff($: EngineInterface, ready: ReadyHandoff, surface: RenderSurface) {
  const copied = await $.ui.copy({ text: ready.prompt, surface })
  $.ui.toast(copied.isCopied ? 'Handoff copied.' : 'Could not reach the clipboard.')
}

/** A collapsible card's state and toggle, as the desktop app draws sections. */
type Card = { key: string; isCollapsed: boolean; onToggle: () => unknown }

/**
 * A band section. In the desktop app it is a card, as the app's own sidebar draws them: a title
 * whose chevron collapses it, `aside` at the right, the content below. In the terminal its name
 * sits in the shared left column (above the content when narrow), the content beside it and
 * `aside` at the far right.
 */
function section(
  t: ElementTable,
  label: string,
  content: JSX.Element,
  layout: {
    isStacked: boolean
    aside?: JSX.Element
    hasHint?: boolean
    isCentred?: boolean
    card?: Card
  },
) {
  const { Box, Text, Button } = t
  const { isStacked, aside, hasHint = false, isCentred = false, card } = layout
  const hint = hasHint && (
    <Box key={HINT_KEY}>
      <Text dimColor italic>
        {HINT_TEXT}
      </Text>
    </Box>
  )

  if (card) {
    return (
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={CARD_BORDER}
        paddingX={CARD_PADDING.x}
        paddingY={CARD_PADDING.y}
      >
        <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap={2}>
          <Button
            key={card.key}
            plain
            label={`${label}  ${card.isCollapsed ? '›' : '⌄'}`}
            onPress={() => void card.onToggle()}
          />
          {aside}
        </Box>
        {!card.isCollapsed && (
          <Box flexDirection="column" marginTop={1}>
            {content}
          </Box>
        )}
      </Box>
    )
  }

  if (isStacked) {
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap={2}>
          <Box flexDirection="row" gap={2} flexShrink={0}>
            <Text dimColor>{label}</Text>
            {hint}
          </Box>
          {aside}
        </Box>
        {content}
      </Box>
    )
  }

  return (
    <Box flexDirection="row" gap={2} alignItems={isCentred && !hasHint ? 'center' : 'flex-start'}>
      <Box flexDirection="column" flexShrink={0} width={LABEL_WIDTH}>
        <Text dimColor>{label}</Text>
        {hint}
      </Box>
      <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0}>
        {content}
      </Box>
      {aside && <Box flexShrink={0}>{aside}</Box>}
    </Box>
  )
}

/** A progress bar: rounded SVG on graphical surfaces, a run of blocks in the terminal. */
function meter(t: ElementTable, key: string, fraction: number, label: string, style: Style) {
  const { Box, Text } = t
  const f = clamp(fraction, 0, 1)

  if (!style.isText && 'Svg' in t) {
    const { Svg } = t
    const width = style.barCells * BAR_PX_PER_CELL
    // Not `h`: that name is the JSX factory.
    const height = BAR_HEIGHT_PX
    const filled = f > 0 ? Math.max(height, Math.round(width * f)) : 0
    const rect = (length: number, paint: string) =>
      `<rect width="${length}" height="${height}" rx="${height / 2}" ${paint}/>`
    const source =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
      rect(width, `fill="${BAR_TRACK}" fill-opacity="0.25"`) +
      (filled ? rect(filled, `fill="${ACCENT}"`) : '') +
      `</svg>`

    return <Svg key={key} source={source} alt={label} width={width} height={height} />
  }

  const filled = Math.round(f * style.barCells)

  return (
    <Box flexDirection="row">
      <Text color={ACCENT}>{'━'.repeat(filled)}</Text>
      <Text dimColor>{'─'.repeat(style.barCells - filled)}</Text>
    </Box>
  )
}

/** One line on graphical surfaces: the task and what it's doing, then its bar and time in columns. */
function agentLine(t: ElementTable, run: AgentRun, at: number, style: Style) {
  const { Box, Text } = t
  const { elapsed, progress, remaining } = estimate(run, at)
  const look = STATUS_LOOK[run.status]
  const isRunning = run.status === 'running'
  const time = !isRunning
    ? `${look.verb} ${duration(elapsed)}`
    : run.isSizing
      ? 'estimating…'
      : `~${clockTime(at + remaining)}`

  return (
    <Box flexDirection="row" alignItems="center" gap={2}>
      <Box flexDirection="row" gap={1} flexGrow={1} flexShrink={1} minWidth={0}>
        <Text color={look.tone}>{look.glyph}</Text>
        <Box flexShrink={1} minWidth={0}>
          <Text wrap="truncate-end" dimColor={!isRunning}>
            {run.description}
          </Text>
        </Box>
        {/* What it's doing gives way first when the row runs short. */}
        {isRunning && (
          <Box flexShrink={4} minWidth={0} paddingLeft={1}>
            <Text dimColor wrap="truncate-end">
              {run.activity}
            </Text>
          </Box>
        )}
      </Box>
      {isRunning &&
        meter(
          t,
          `bar-${run.toolUseId}`,
          progress,
          `about ${Math.round(progress * 100)}% done`,
          style,
        )}
      <Box width={TIME_COLUMN} flexShrink={0} justifyContent="flex-end">
        <Text dimColor={!isRunning || run.isSizing}>{time}</Text>
      </Box>
    </Box>
  )
}

function agentRow(t: ElementTable, run: AgentRun, at: number, style: Style) {
  if (!style.isText) return agentLine(t, run, at, style)

  const { Box, Text } = t
  const { elapsed, progress, remaining } = estimate(run, at)
  const look = STATUS_LOOK[run.status]
  const isRunning = run.status === 'running'
  // Braille spinners read as stray dots in a proportional font, so only the terminal spins.
  const glyph = isRunning ? SPINNER[Math.floor(at / TICK_MS) % SPINNER.length] : look.glyph

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" justifyContent="space-between" gap={2}>
        <Box flexDirection="row" gap={1} flexShrink={1} minWidth={0}>
          <Text color={look.tone}>{glyph}</Text>
          <Text wrap="truncate-end" dimColor={!isRunning}>
            {run.description}
          </Text>
        </Box>
        {isRunning ? (
          run.isSizing ? (
            <Text dimColor>estimating…</Text>
          ) : (
            <Text>{`done by ~${clockTime(at + remaining)}`}</Text>
          )
        ) : (
          <Text dimColor>{`${look.verb} ${duration(elapsed)}`}</Text>
        )}
      </Box>
      {isRunning && (
        <Box flexDirection="row" gap={2} paddingLeft={2} alignItems="center">
          {meter(
            t,
            `bar-${run.toolUseId}`,
            progress,
            `about ${Math.round(progress * 100)}% done`,
            style,
          )}
          <Box flexShrink={1} minWidth={0}>
            <Text dimColor wrap="truncate-end">
              {run.activity}
            </Text>
          </Box>
        </Box>
      )}
    </Box>
  )
}

function subagentsSection(
  t: ElementTable,
  shown: AgentRun[],
  at: number,
  style: Style,
  maxRows: number,
  card?: Card,
) {
  const { Box, Text } = t
  const sized = shown.filter(run => !run.isSizing)
  const left = Math.max(0, ...sized.map(run => estimate(run, at).remaining))
  const isRunning = shown.some(run => run.status === 'running')
  const isEstimating = shown.some(run => run.status === 'running' && run.isSizing)
  const rowsPerAgent = style.isText ? ROWS_PER_AGENT.terminal : ROWS_PER_AGENT.graphical
  const fit = Math.max(1, Math.floor((maxRows - BAND_CHROME_ROWS) / rowsPerAgent))

  // The header waits for every running task's size, so it doesn't jump as answers arrive.
  const summary = isEstimating ? (
    <Text dimColor>Estimating…</Text>
  ) : isRunning ? (
    <Text bold>{`All done by ~${clockTime(at + left)}`}</Text>
  ) : (
    <Text color={SUCCESS}>All done</Text>
  )

  // Stacked, the summary sits beside the section's name; otherwise it heads the rows.
  return section(
    t,
    'Subagents',
    <Box flexDirection="column">
      {!style.isStacked && summary}
      {shown.slice(-fit).map(run => agentRow(t, run, at, style))}
    </Box>,
    { ...style, card, ...(style.isStacked ? { aside: summary } : {}) },
  )
}

function handoffSection(
  $: EngineInterface,
  t: ElementTable,
  ready: ReadyHandoff,
  style: Style,
  hasHint: boolean,
  card?: Card,
) {
  const { Box, Text, Button } = t
  const plain = style.isText || undefined

  return section(
    t,
    ready.source === 'auto' ? 'Suggested' : 'Next session',
    <Box
      key="handoff"
      flexDirection="row"
      justifyContent="space-between"
      gap={2}
      alignItems="center"
    >
      <Box flexDirection="row" gap={1} flexShrink={1} minWidth={0}>
        <Text bold wrap="truncate-end">
          {ready.title}
        </Text>
        {ready.reason !== '' && (
          <Text dimColor wrap="truncate-end">
            {`·  ${ready.reason}`}
          </Text>
        )}
      </Box>
      <Box flexDirection="row" gap={style.isText ? 3 : 1} flexShrink={0}>
        <Button
          key="handoff-start"
          plain={plain}
          variant="primary"
          hotkey="s"
          label="Start fresh session"
          onPress={press => startFresh($, ready, press.surface)}
        />
        <Button
          key="handoff-copy"
          plain={plain}
          hotkey="c"
          label="Copy"
          onPress={press => copyHandoff($, ready, press.surface)}
        />
        <Button
          key="handoff-dismiss"
          plain={plain}
          role="dismiss"
          hotkey="x"
          label="Dismiss"
          onPress={() => update($, handoff, () => null)}
        />
      </Box>
    </Box>,
    { ...style, hasHint, isCentred: true, card },
  )
}

export const register: Register = (on, options) => {
  const showIn = String(options.show_in ?? 'both')

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await Promise.all([loadFolded($), loadCards($)]).catch(() => undefined)
    const [, usage] = await Promise.all([
      $.command
        .register({
          name: 'handoff',
          description:
            'Write a starter prompt for a fresh session; a pill above the prompt starts it',
          argumentHint: '[focus] | auto on | auto off',
        })
        .catch(() => undefined),
      $.session.usage().catch(() => undefined),
    ])
    local.contextPercent = usage?.context.percent ?? 0

    return result
  })

  on('session.measure', ($, e, next) => {
    local.contextPercent = e.context.percent ?? local.contextPercent
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      local.turnsSinceCheck = 0
      local.contextPercent = 0
      await Promise.all([update($, agents, () => []), update($, handoff, () => null)])
    }

    return next(e)
  })

  on('command.run', { command: 'handoff' }, async ($, e) => {
    if (!(await isActive($, showIn))) {
      return { text: `session-hud is set to show in the ${showIn} only. Change it under /config.` }
    }

    const args = (e.args ?? '').trim()
    const toggle = /^auto\s+(on|off)$/i.exec(args)
    if (toggle) {
      const isOn = toggle[1]!.toLowerCase() === 'on'
      await $.store.set(STORE_AUTO_SUGGEST, isOn)

      return { text: `Handoff suggestions are ${isOn ? 'on' : 'off'}.` }
    }

    await update($, handoff, () => ({ phase: 'writing' as const, source: 'manual' as const }))
    $.clock.after(0, () => void writeHandoff($, args))

    return {
      text: 'Writing a handoff. A pill to start the fresh session will appear above the prompt.',
    }
  })

  on('agent.spawn', async ($, e, next) => {
    startTicker($)
    const [at, expected, isSized] = await Promise.all([
      $.clock.now(),
      expectation($, e.subagentType),
      isActive($, showIn),
    ])
    const run: AgentRun = {
      toolUseId: e.tool_use_id,
      description: e.description || e.subagentType,
      type: e.subagentType,
      startedAt: at,
      isBackground: e.background,
      status: 'running',
      steps: 0,
      activity: 'Starting',
      ...expected,
      isSizing: isSized,
    }
    const withoutRun = (list: AgentRun[]) => list.filter(one => one.toolUseId !== run.toolUseId)

    await Promise.all([
      update($, agents, list =>
        [...list.filter(one => isShown(one, at)), run].slice(-MAX_AGENT_ROWS),
      ),
      update($, now, () => at),
    ])

    // Sized alongside the subagent, so it starts without waiting on the guess.
    if (isSized) {
      const task = `Subagent type: ${e.subagentType}\nTask: ${e.description}\n\nIts instructions:\n${e.prompt.slice(0, SIZE_PROMPT_CHARS)}`
      void sizeRun($, run.toolUseId, task).catch(() => undefined)
    }

    let result: Awaited<ReturnType<typeof next>>
    try {
      result = await next(e)
    } catch (error) {
      await update($, agents, withoutRun)
      throw error
    }

    await update($, agents, list =>
      result.deny !== undefined
        ? withoutRun(list)
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
      const [ran] = await Promise.all([
        next(e),
        update($, agents, list => {
          // A subagent's first calls can land before its spawn resolved its id.
          const owner =
            list.find(one => one.agentId === agentId) ??
            [...list].reverse().find(one => one.status === 'running' && one.agentId === undefined)

          return list.map(one =>
            one === owner ? { ...one, agentId, steps: one.steps + 1, activity } : one,
          )
        }),
      ])

      return ran
    }

    const ran = await next(e)

    // A foreground Agent call returns once its subagent has finished.
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

    const isDue =
      e.reason === 'answer' &&
      !pending &&
      local.turnsSinceCheck >= CHECK_AFTER_TURNS &&
      (local.contextPercent >= CHECK_AT_CONTEXT_PERCENT ||
        local.turnsSinceCheck >= CHECK_ALWAYS_AFTER_TURNS)
    if (!isDue) return result

    const [autoSuggest, list, active] = await Promise.all([
      $.store.get(STORE_AUTO_SUGGEST),
      read($, agents),
      isActive($, showIn),
    ])
    if (autoSuggest !== false && active && !list.some(run => run.status === 'running')) {
      local.turnsSinceCheck = 0
      $.clock.after(CHECK_DELAY_MS, () => void autoCheck($))
    }

    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // Other mods' sections come first; this one follows, nearer the prompt.
    const above = await next(e)
    if (e.props.hasSurvey || !runsOn(showIn, e.surface)) return above

    // `now` is read so the ticker's writes redraw the band while agents run.
    const [list, pending, at] = await Promise.all([
      read($, agents),
      read($, handoff),
      $.clock.now(),
      read($, now),
    ])
    const shown = list.filter(run => isShown(run, at))
    if (shown.length === 0 && !pending) return above

    const t = $.ui.resolve(e)
    const { Box, Text } = t
    const cols = Math.max(MIN_BAND_COLUMNS, e.props.bodyColumns)
    const style: Style = {
      isText: e.surface === 'terminal',
      isStacked: e.surface !== 'terminal' || cols < NARROW_COLUMNS,
      barCells: clamp(
        Math.floor((cols - LABEL_WIDTH) / COLUMNS_PER_BAR_CELL),
        BAR_MIN_CELLS,
        BAR_MAX_CELLS,
      ),
    }
    // The terminal takes no clicks outside fullscreen: say how to reach the buttons.
    const hasHint = style.isText && e.viewport?.isFullscreen !== true && !hasKey(above, HINT_KEY)

    const collapsed = await read($, OWN_CARDS)
    const card = (name: string) => cardFor($, style.isText, collapsed, name)
    const sections: JSX.Element[] = []
    if (shown.length > 0) {
      sections.push(subagentsSection(t, shown, at, style, e.props.maxRows, card('Subagents')))
    }
    if (pending?.phase === 'writing') {
      sections.push(
        section(t, 'Next session', <Text dimColor>Writing the handoff prompt…</Text>, {
          ...style,
          card: card('Next session'),
        }),
      )
    }
    if (pending?.phase === 'ready') {
      sections.push(handoffSection($, t, pending, style, hasHint, card('Next session')))
    }

    return inPanel(
      $,
      t,
      above,
      <Box flexDirection="column" gap={SECTION_GAP}>
        {sections}
      </Box>,
    )
  })
}
