export type UnitName = 'SCOUT' | 'REWRITE' | 'DIVE'
export type Verdict = 'idle' | 'running' | 'approved' | 'denied'
export type Unit = { verdict: Verdict; count: number; tool: string }
export type Units = { SCOUT: Unit; REWRITE: Unit; DIVE: Unit }
export type LogEntry = {
  id: string
  at: number
  unit: UnitName
  tool: string
  summary: string
  verdict: Verdict
  // サブエージェントの中で実行されたときの、そのエージェントのid
  agentId?: string
}
export type Alarm = { tool: string; reason: string }
export type Limit = { kind: string; percentUsed: number; resetsAt?: string }
export type ContextGauge = { tokens?: number; window: number; percent?: number }
// 随伴機(サブエージェント)1機ぶん。toolUseIdは起動したAgentツールの呼び出し
export type Escort = {
  id: string
  toolUseId: string
  type: string
  description: string
  model: string
  verdict: Verdict
  count: number
  // バックグラウンドで動く機体は、Agentツールが返っても作業が続く
  isBackground: boolean
}
// 全ターンのトークンの累計。キャッシュの効き具合を出すのに使う
export type TokenTally = { input: number; output: number; cacheRead: number; cacheWrite: number; turns: number }
export type MemoryKind = 'used' | 'free' | 'buffer' | 'deferred'
export type MemorySlice = { name: string; tokens: number; kind: MemoryKind }
// コンテキストの内訳(/contextの見積もり)。maxはsliceの合計が対応する窓の大きさ
export type MemoryMap = { slices: MemorySlice[]; used: number; max: number; percentage: number }

declare module 'claude-code' {
  interface PluginState {
    'netdive-quota': {
      units: Units
      log: LogEntry[]
      startedAt: number
      alarm: Alarm | null
      bash: string | null
      limits: Limit[]
      context: ContextGauge | null
      anchor: number
      escorts: Escort[]
      cost: number | null
      tokens: TokenTally
      memory: MemoryMap | null
      // 作り直しを後回しにしたSVGを、間隔が空いたところで描き直させるための数
      redraw: number
    }
  }
}
