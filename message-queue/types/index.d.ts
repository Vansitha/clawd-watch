export type QueuedMessage = { id: string; text: string }

declare module 'claude-code' {
  interface PluginState {
    'message-queue': {
      messages: QueuedMessage[]
      /** True after the person stopped a turn: nothing is sent until they say so. */
      isPaused: boolean
    }
  }
}
