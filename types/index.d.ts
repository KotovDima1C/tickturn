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

/** One local day's totals over the turns that finished on it. */
export type DayTotals = {
  usd: number
  requests: number
  seconds: number
}

/** Totals by local day, keyed `YYYY-MM-DD`. */
export type Days = Record<string, DayTotals>

/** The days this session has booked so far in the current month, as its file holds them. */
export type OwnDays = { sessionId: string; days: Days }

/** What the band and the pane draw: every session's money for `day` and for its month. */
export type Daily = { day: string; today: number; month: number }

declare module 'claude-code' {
  interface PluginState {
    'tickturn': {
      turns: TurnRecord[]
      running: RunningTurn | null
      tokens: Tokens
      /** The session cost at the last turn booked; null until the first. */
      lastUsd: number | null
      own: OwnDays | null
      daily: Daily | null
    }
  }
}
