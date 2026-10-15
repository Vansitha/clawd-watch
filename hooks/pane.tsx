import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { PaneView } from '../types'

/** The sidebar pane every section draws into, where the surface docks one. */
export const PANE = 'clawd-watch'
const PANE_TITLE = 'Clawd Watch'
const STORE_PANE = 'paneOpen'

const paneView = atom({ plugin: 'clawd-watch', key: 'paneView' } as const, 'overview')
/** Whether the pane is open and drawn; while it is, the band above the prompt stays out of the way. */
const paneShown = atom({ plugin: 'clawd-watch', key: 'paneShown' } as const, false)
/** True once the person asked for the pane and no surface could place it: the band keeps it all. */
const paneUnavailable = atom({ plugin: 'clawd-watch', key: 'paneUnavailable' } as const, false)

/** Opens the pane on a view (or moves an open one to it); says whether a surface drew it. */
export async function openPane(
  $: EngineInterface,
  view: PaneView = 'overview',
  options: { isAsked: boolean } = { isAsked: true },
): Promise<boolean> {
  await update($, paneView, () => view)
  const opened = await $.ui.open({ id: PANE, title: PANE_TITLE })
  await update($, paneShown, () => opened.isPlaced)
  // Opening it is a choice the next session keeps; an automatic open is not.
  if (options.isAsked) {
    await Promise.all([
      $.store.set(STORE_PANE, true),
      update($, paneUnavailable, () => !opened.isPlaced),
    ])
  }

  return opened.isPlaced
}

/** Closes the pane as the person's choice; this plugin's own close may not come back to its hooks. */
export async function closePane($: EngineInterface) {
  await $.ui.close({ id: PANE })
  await paneClosed($, true)
}

/** After the pane closes: a close the person or a button made is kept for the next session. */
export async function paneClosed($: EngineInterface, isChosen: boolean) {
  await Promise.all([update($, paneShown, () => false), update($, paneView, () => 'overview')])
  if (isChosen) await $.store.set(STORE_PANE, false)
}

/** Whether the person keeps the pane open; it is, until they close it. */
export async function wantsPane($: EngineInterface): Promise<boolean> {
  return (await $.store.get(STORE_PANE)) !== false
}

/** Checks with the engine whether the pane is drawn, after a surface comes or goes. */
export async function syncPane($: EngineInterface) {
  const pane = (await $.ui.panes()).find(one => one.id === PANE)
  const isPlaced = pane?.isPlaced === true
  await update($, paneShown, () => isPlaced)
  if (isPlaced) await update($, paneUnavailable, () => false)
}

export async function paneState($: EngineInterface) {
  const [isShown, view] = await Promise.all([read($, paneShown), read($, paneView)])

  return { isShown, view }
}

export function isPaneUnavailable($: EngineInterface): Promise<boolean> {
  return read($, paneUnavailable)
}

export function setPaneView($: EngineInterface, view: PaneView) {
  return update($, paneView, () => view)
}
