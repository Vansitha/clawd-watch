export type AgentRun = {
  toolUseId: string
  agentId?: string
  description: string
  type: string
  startedAt: number
  endedAt?: number
  isBackground: boolean
  status: 'running' | 'done' | 'failed'
  steps: number
  activity: string
  expectedMs: number
  expectedSteps: number
  /** True until Claude has sized the task (or couldn't); the row says "estimating" meanwhile. */
  isSizing: boolean
  /** Claude's own guess, before learned corrections, kept to learn from when the run ends. */
  guessMs?: number
  guessSteps?: number
}

export type Handoff =
  | { phase: 'writing'; source: 'manual' | 'auto' }
  | {
      phase: 'ready'
      source: 'manual' | 'auto'
      title: string
      reason: string
      prompt: string
      turnsSince: number
    }

export type QueuedMessage = { id: string; text: string }

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

/** Which skills the skills list shows. */
export type PaneFilter = 'all' | SkillKind | 'hidden'

/** What the pane shows: every section as a card, or all skills. */
export type PaneView = 'overview' | 'skills'

declare module 'claude-code' {
  interface PluginState {
    'clawd-watch': {
      // Subagents and the next session
      agents: AgentRun[]
      now: number
      handoff: Handoff | null
      // The queue
      messages: QueuedMessage[]
      /** True after the person stopped a turn: nothing is sent until they say so. */
      isPaused: boolean
      // Skills
      pins: string[]
      uses: Uses
      skills: SkillEntry[]
      isInline: boolean
      /** Skills hidden from the dock and the lists; they still run when typed. */
      hidden: string[]
      filter: PaneFilter
      query: string
      /** The skill whose removal is waiting on a confirm, if any. */
      confirming: string | null
      // The panel
      /** True while the band above the prompt is folded to one line. */
      isFolded: boolean
      /** The names of the desktop app's cards left collapsed. */
      collapsedCards: string[]
      paneView: PaneView
      paneShown: boolean
      paneUnavailable: boolean
    }
  }
}
