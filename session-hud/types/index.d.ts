export type RateWindow = { percent: number; resetsAt?: string }

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
      fiveHour: RateWindow | null
      agents: AgentRun[]
      now: number
      handoff: Handoff | null
    }
  }
}
