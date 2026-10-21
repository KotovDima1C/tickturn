export type TurnReason = 'answer' | 'aborted' | 'refusal' | 'error'

/** Token counts as the API reports them, summed. */
export type Tokens = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export type TurnRecord = {
  id: string
  text: string
  seconds: number
  reason: TurnReason
  /** Tokens of the turn, its subagents' included; absent on records from before 0.3.0. */
  tokens?: Tokens
  /** US dollars the session cost grew by during the turn; absent where the host keeps no cost ledger. */
  usd?: number
}

export type RunningTurn = {
  id: string
  text: string
  startedAt: number
  /** The session's token total when the turn started. */
  tokensAtStart?: Tokens
  /** The session's cost when the turn started. */
  usdAtStart?: number
}

declare module 'claude-code' {
  interface PluginState {
    'tickturn': { turns: TurnRecord[]; running: RunningTurn | null; tokens: Tokens }
  }
}
