/** When each skill was used, in milliseconds since the epoch, newest last. */
export type Uses = Record<string, number[]>

/** Where a skill comes from: Claude Code itself, written by you, or installed from someone else. */
export type SkillKind = 'builtin' | 'mine' | 'installed'

export type SkillEntry = {
  name: string
  description: string
  kind: SkillKind
  /** For an installed skill, where from: the plugin, the repository it was added from, or MCP. */
  origin?: string
  /** For a skill that lives in its own files: its folder (a skill) or file (a command). */
  path?: string
}

/** Which skills the side pane lists. */
export type PaneFilter = 'all' | SkillKind | 'hidden'

/** Whether the Clawd Watch panel is folded, and when that was chosen. Every mod keeps a copy. */
export type Panel = { isFolded: boolean; at: number }

declare module 'claude-code' {
  interface PluginState {
    'skill-dock': {
      pins: string[]
      uses: Uses
      skills: SkillEntry[]
      isInline: boolean
      panel: Panel | null
      /** The names of the desktop app's cards left collapsed. */
      collapsedCards: string[]
      /** Skills hidden from the dock and the pane; they still run when typed. */
      hidden: string[]
      filter: PaneFilter
      query: string
      /** The skill whose removal is waiting on a confirm, if any. */
      confirming: string | null
    }
    'session-hud': {
      agents: Array<{ status: 'running' | 'done' | 'failed' }>
      handoff: { phase: 'writing' | 'ready' } | null
      panel: Panel | null
    }
    'message-queue': {
      messages: unknown[]
      panel: Panel | null
    }
  }
}
