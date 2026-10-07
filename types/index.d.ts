export type HudLimit = { kind: string; percentUsed: number; resetsAt?: string }

export type HudUsage = {
  tokens: number | null
  window: number
  percent: number | null
  limits: HudLimit[]
  usd: number | null
}

export type HudInfo = {
  model: string | null
  effort: string | null
  branch: string | null
  startedAt: number | null
  turns: number
  tools: number
  lastTurnMs: number | null
  turnStartedAt: number | null
}

export type HudEdits = { added: number; removed: number; files: string[] }

export type HudSample = { t: number; p: number }

export type HudAgent = { id: string; type: string; description: string }

declare module 'claude-code' {
  interface PluginState {
    'session-hud': {
      usage: HudUsage | null
      info: HudInfo
      now: number
      edits: HudEdits
      agents: HudAgent[]
      toolCounts: Record<string, number>
      skillCounts: Record<string, number>
      samples: Record<string, HudSample[]>
      warned: string[]
      isCompact: boolean
      modeLabel: string | null
    }
  }
}
