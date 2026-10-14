/** When each skill was used, in milliseconds since the epoch, newest last. */
export type Uses = Record<string, number[]>

export type SkillEntry = { name: string; description: string; group: string }

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
