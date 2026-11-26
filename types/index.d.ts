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
  /** US dollars the session cost grew by since the turn before ended; absent where the host keeps no cost ledger. */
  usd?: number
  /** When the turn ended, ms since the epoch; the day it counts on. Absent on records from before 0.6.0. */
  endedAt?: number
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

/** A session's file under `history/`: its turns, their token total, and days booked before it kept turns. */
export type History = { turns: TurnRecord[]; tokens: Tokens; before?: Days }

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
      daily: Daily | null
    }
  }
}
