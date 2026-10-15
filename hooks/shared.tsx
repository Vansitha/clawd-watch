import { atom, read, update } from 'claude-code'
import type { ElementTable, EngineInterface, RenderSurface } from 'claude-code'

/** The name column every section shares in the terminal, wide enough for "Favourite skills". */
export const LABEL_WIDTH = 17
/** Below this many columns the terminal stacks a section's name above its content. */
export const NARROW_COLUMNS = 72
/** The terminal's chord that hands the keyboard to the panel's buttons. */
export const HINT_TEXT = 'ctrl+x tab'
/** The desktop app's cards: the prompt box's own border colour, and their inner spacing. */
const CARD_BORDER = 'promptBorder'
const CARD_PADDING = { x: 2, y: 1 }
/** Below this many columns (a docked pane) rows wrap onto two lines rather than squeeze. */
export const COMPACT_COLUMNS = 70
/** Rows between sections, and between cards. */
export const SECTION_GAP = 1
export const ACCENT = '#d97757'

const STORE_CARDS = 'collapsedCards'
const collapsedCards = atom({ plugin: 'clawd-watch', key: 'collapsedCards' } as const, [])

/** How a section is drawn: where, how much room, and which cards are collapsed. */
export type View = {
  surface: RenderSurface
  /** The terminal draws text; the desktop app draws cards. */
  isText: boolean
  /** The name above the content (the desktop app, a narrow terminal) rather than beside it. */
  isStacked: boolean
  columns: number
  maxRows: number
  collapsed: readonly string[]
}

/** A collapsible card's state and toggle, as the desktop app draws sections. */
export type Card = { key: string; isCollapsed: boolean; onToggle: () => unknown }

/** Whether the "Show in" setting (both, desktop or terminal) includes a surface. */
export function runsOn(showIn: string, surface: RenderSurface): boolean {
  if (showIn === 'desktop') return surface !== 'terminal'
  if (showIn === 'terminal') return surface === 'terminal'

  return true
}

/** Whether Clawd Watch runs in this session, judged by the surfaces drawing it right now. */
export async function isActive($: EngineInterface, showIn: string): Promise<boolean> {
  if (showIn === 'both') return true
  const surfaces = await $.session.surfaces()

  // Until a client attaches (the desktop app, the SDK) nothing rules it out.
  return surfaces.length === 0 || surfaces.some(surface => runsOn(showIn, surface))
}

export function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`
}

/** The names of the desktop app's cards left collapsed. */
export function collapsedList($: EngineInterface): Promise<string[]> {
  return read($, collapsedCards)
}

/** Collapses a card, or opens it again, and keeps that for later sessions. */
async function toggleCard($: EngineInterface, name: string) {
  const list = await update($, collapsedCards, all =>
    all.includes(name) ? all.filter(one => one !== name) : [...all, name],
  )
  await $.store.set(STORE_CARDS, list)
}

export async function loadCards($: EngineInterface) {
  const stored = await $.store.get(STORE_CARDS)
  if (Array.isArray(stored)) {
    await update($, collapsedCards, () =>
      stored.filter((one): one is string => typeof one === 'string'),
    )
  }
}

/** A section's card in the desktop app, collapsed as it was left; the terminal draws no cards. */
export function cardFor(
  $: EngineInterface,
  view: Pick<View, 'isText' | 'collapsed'>,
  name: string,
): Card | undefined {
  if (view.isText) return undefined

  return {
    key: `card-${name.toLowerCase().replace(/\W+/g, '-')}`,
    isCollapsed: view.collapsed.includes(name),
    onToggle: () => toggleCard($, name),
  }
}

/**
 * A section. In the desktop app it is a card, as the app's own sidebar draws them: a title whose
 * chevron collapses it, `aside` at the right, the content below. In the terminal its name sits in
 * the shared left column (above the content when narrow), the content beside it and `aside` at
 * the far right.
 */
export function section(
  t: ElementTable,
  label: string,
  content: JSX.Element,
  layout: { isStacked: boolean; aside?: JSX.Element; isCentred?: boolean; card?: Card },
) {
  const { Box, Text, Button } = t
  const { isStacked, aside, isCentred = false, card } = layout

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
          <Box flexShrink={0}>
            <Text dimColor>{label}</Text>
          </Box>
          {aside}
        </Box>
        {content}
      </Box>
    )
  }

  return (
    <Box flexDirection="row" gap={2} alignItems={isCentred ? 'center' : 'flex-start'}>
      <Box flexShrink={0} width={LABEL_WIDTH}>
        <Text dimColor>{label}</Text>
      </Box>
      <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0}>
        {content}
      </Box>
      {aside && <Box flexShrink={0}>{aside}</Box>}
    </Box>
  )
}
