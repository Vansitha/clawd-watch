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

declare module 'claude-code' {
  interface PluginState {
    'session-hud': {
      agents: AgentRun[]
      now: number
      handoff: Handoff | null
    }
  }
}
