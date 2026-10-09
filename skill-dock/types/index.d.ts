/** When each skill was used, in milliseconds since the epoch, newest last. */
export type Uses = Record<string, number[]>

export type SkillEntry = { name: string; description: string; group: string }

declare module 'claude-code' {
  interface PluginState {
    'skill-dock': {
      pins: string[]
      uses: Uses
      skills: SkillEntry[]
      filter: string
      isInline: boolean
    }
  }
}
