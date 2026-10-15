type Surface = 'desktop' | 'terminal'

/**
 * The band above the prompt, as the engine mounts it. The terminal is on its main screen, which
 * docks no pane, as a terminal says; the desktop app docks one.
 */
export function band(surface: Surface, bodyColumns = 110) {
  return {
    plugin: 'clawd-watch',
    surface,
    component: 'AbovePrompt' as const,
    viewport: { columns: bodyColumns, rows: 40, isFullscreen: surface !== 'terminal' },
    props: {
      hasSurvey: false,
      isWorking: true,
      maxRows: 20,
      bodyColumns,
      scroll: { offset: 0, bodyRows: 19 },
      view: {},
    },
  }
}

/** The Clawd Watch pane, docked beside the transcript. */
export function pane(surface: Surface, bodyColumns = 60) {
  return {
    plugin: 'clawd-watch',
    surface,
    component: 'Pane' as const,
    requestId: 'clawd-watch',
    props: {
      title: 'Clawd Watch',
      isFocused: true,
      bodyColumns,
      placement: 'dock' as const,
      scroll: { offset: 0, bodyRows: 60 },
      view: {},
    },
  }
}

/** Where the sections are drawn: the pane in the desktop app, the band in the terminal. */
export function panel(surface: Surface) {
  return surface === 'terminal' ? band(surface) : pane(surface)
}
