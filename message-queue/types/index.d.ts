export type QueuedMessage = { id: string; text: string }

/** Whether the Clawd Watch panel is folded, and when that was chosen. Every mod keeps a copy. */
export type Panel = { isFolded: boolean; at: number }

declare module 'claude-code' {
  interface PluginState {
    'message-queue': {
      messages: QueuedMessage[]
      /** True after the person stopped a turn: nothing is sent until they say so. */
      isPaused: boolean
      panel: Panel | null
    }
    'session-hud': {
      agents: Array<{ status: 'running' | 'done' | 'failed' }>
      handoff: { phase: 'writing' | 'ready' } | null
      panel: Panel | null
    }
    'skill-dock': {
      panel: Panel | null
    }
  }
}
