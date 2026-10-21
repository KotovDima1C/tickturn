import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { RunningTurn, Tokens, TurnRecord } from '../types'

const PANE = 'tickturn'
const COMMAND = 'time'
const MAX_TURNS = 500
const LABEL_CHARS = 25

type Lang = 'ru' | 'en'

const STRINGS = {
  ru: {
    running: 'Идёт',
    last: 'Последний',
    session: 'Сессия',
    requests: 'запросов',
    tokens: 'токенов',
    input: 'ввод',
    output: 'вывод',
    cacheRead: 'кэш: чтение',
    cacheWrite: 'кэш: запись',
    aborted: ' (прервано)',
    error: ' (ошибка)',
    noText: '(без текста)',
    history: 'История',
    paneTitle: 'Время по запросам',
    empty: 'Запросов ещё не было.',
    more: (n: number) => `… ещё ${n} выше`,
    total: 'Итого',
    command: 'Время по запросам этой сессии в панели',
    opened: 'Панель времени открыта.',
    notOpened: 'Не удалось открыть панель: ',
  },
  en: {
    running: 'Running',
    last: 'Last',
    session: 'Session',
    requests: 'requests',
    tokens: 'tokens',
    input: 'input',
    output: 'output',
    cacheRead: 'cache read',
    cacheWrite: 'cache write',
    aborted: ' (interrupted)',
    error: ' (error)',
    noText: '(no text)',
    history: 'History',
    paneTitle: 'Time per request',
    empty: 'No requests yet.',
    more: (n: number) => `… ${n} more above`,
    total: 'Total',
    command: 'Time per request of this session, in a pane',
    opened: 'Time pane opened.',
    notOpened: 'Could not open the pane: ',
  },
} satisfies Record<Lang, unknown>

type Strings = (typeof STRINGS)[Lang]

const isRussian = (tag: string | undefined) => /^ru(?![a-z])/i.test(tag ?? '')

/** The locale the JS environment runs with: on Windows the user's regional format, on POSIX the LANG-family. */
const intlLocale = (): string | undefined => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale
  } catch {
    return undefined
  }
}

/**
 * Russian when the mod's `language` option says so, or on `auto` when the
 * first set of `LC_ALL`, `LC_MESSAGES`, `LANG`, `LANGUAGE` names it, or, with
 * none set (Windows), when the environment's own locale is Russian. English otherwise.
 */
const detect = async ($: EngineInterface, option: unknown): Promise<Lang> => {
  if (option === 'ru' || option === 'en') return option

  const posix =
    (await $.env.get('LC_ALL')) ||
    (await $.env.get('LC_MESSAGES')) ||
    (await $.env.get('LANG')) ||
    (await $.env.get('LANGUAGE'))
  if (posix) return isRussian(posix) ? 'ru' : 'en'

  return isRussian(intlLocale()) ? 'ru' : 'en'
}

/** The `language` option as `register` received it, and the detection it led to, once. */
let languageOption: unknown
let language: Promise<Lang> | undefined

const strings = async ($: EngineInterface): Promise<Strings> => {
  language ??= detect($, languageOption)
  return STRINGS[await language]
}

const turns = atom({ plugin: 'tickturn', key: 'turns' } as const, [])
const running = atom({ plugin: 'tickturn', key: 'running' } as const, null)
const NO_TOKENS: Tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
/** Every turn's tokens this session, subagents' included: a turn's own is the growth of this while it ran. */
const spent = atom({ plugin: 'tickturn', key: 'tokens' } as const, NO_TOKENS)

const pad = (n: number) => String(n).padStart(2, '0')

const fmt = (seconds: number) => {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

const plus = (a: Tokens, b: Tokens): Tokens => ({
  input: a.input + b.input,
  output: a.output + b.output,
  cacheRead: a.cacheRead + b.cacheRead,
  cacheWrite: a.cacheWrite + b.cacheWrite,
})

const minus = (a: Tokens, b: Tokens): Tokens => ({
  input: a.input - b.input,
  output: a.output - b.output,
  cacheRead: a.cacheRead - b.cacheRead,
  cacheWrite: a.cacheWrite - b.cacheWrite,
})

const sum = (tokens: Tokens) => tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite

const fmtTokens = (n: number) =>
  n >= 1e6
    ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`
    : n >= 1e3
      ? `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k`
      : String(n)

const fmtUsd = (usd: number) => (usd > 0 && usd < 0.01 ? '<$0.01' : `$${usd.toFixed(2)}`)

/** What the session has cost so far, as /cost totals it; undefined where the host keeps no ledger. */
const sessionUsd = async ($: EngineInterface): Promise<number | undefined> => {
  try {
    return (await $.session.usage()).cost?.usd
  } catch {
    return undefined
  }
}

/** The running turn's tokens and cost so far, from the snapshots its start took. */
const sofar = async ($: EngineInterface, turn: RunningTurn) => {
  const usd = turn.usdAtStart === undefined ? undefined : await sessionUsd($)
  return {
    tokens: turn.tokensAtStart && minus(await read($, spent), turn.tokensAtStart),
    usd: usd === undefined || turn.usdAtStart === undefined ? undefined : usd - turn.usdAtStart,
  }
}

/** The finished turns' and the running one's tokens and cost, summed; usd undefined when none had a cost. */
const totals = async ($: EngineInterface, list: TurnRecord[], current: RunningTurn | null) => {
  const parts: { tokens?: Tokens; usd?: number }[] = list.map(turn => ({ tokens: turn.tokens, usd: turn.usd }))
  if (current) parts.push(await sofar($, current))
  const tokens = parts.reduce((all, part) => (part.tokens ? plus(all, part.tokens) : all), NO_TOKENS)
  const priced = parts.filter(part => part.usd !== undefined)
  const usd = priced.length > 0 ? priced.reduce((all, part) => all + (part.usd ?? 0), 0) : undefined
  return { tokens, usd }
}

const spend = (tokens: Tokens | undefined, usd: number | undefined) =>
  [tokens && fmtTokens(sum(tokens)), usd !== undefined && fmtUsd(usd)].filter(Boolean).join(' · ')

const label = (text: string, t: Strings) => {
  const one = Array.from(text.replace(/\s+/g, ' ').trim())
  if (one.length === 0) return t.noText
  return one.length > LABEL_CHARS
    ? one.slice(0, LABEL_CHARS - 1).join('') + '…'
    : one.join('')
}

const mark = (reason: TurnRecord['reason'], t: Strings) =>
  reason === 'aborted' ? t.aborted : reason === 'answer' ? '' : t.error

export const register: Register = (on, options) => {
  let isRunning = false
  languageOption = options.language
  language = undefined

  on('session.start', async ($, e, next) => {
    const t = await strings($)
    await $.command.register({ name: COMMAND, description: t.command })
    isRunning = (await read($, running)) !== null
    $.clock.every(1000, () => {
      if (isRunning) $.ui.invalidate('ui.render')
    })

    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)

    const turn: RunningTurn = {
      id: e.turnId,
      text: e.text,
      startedAt: await $.clock.now(),
      tokensAtStart: await read($, spent),
      usdAtStart: await sessionUsd($),
    }
    await update($, running, () => turn)
    isRunning = true

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.usage) {
      const { input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens } = e.usage
      await update($, spent, total =>
        plus(total, {
          input: input_tokens,
          output: output_tokens,
          cacheRead: cache_read_input_tokens,
          cacheWrite: cache_creation_input_tokens,
        }),
      )
    }
    if (e.agentId !== undefined) return next(e)

    const current = await read($, running)
    const mine = current?.id === e.turnId ? current : null
    const cost = mine ? await sofar($, mine) : { tokens: undefined, usd: undefined }
    const record: TurnRecord = {
      id: e.turnId,
      text: mine ? mine.text : '',
      seconds: Math.round(e.durationMs / 1000),
      reason: e.reason,
      ...(cost.tokens && { tokens: cost.tokens }),
      ...(cost.usd !== undefined && { usd: cost.usd }),
    }
    await update($, turns, list => [...list, record].slice(-MAX_TURNS))
    await update($, running, () => null)
    isRunning = false

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await update($, turns, () => [])
      await update($, running, () => null)
      await update($, spent, () => NO_TOKENS)
      isRunning = false
    }

    return next(e)
  })

  on('command.run', { command: COMMAND }, async $ => {
    const t = await strings($)
    const opened = await $.ui.open({ id: PANE, title: t.paneTitle })

    return { text: opened.isPlaced ? t.opened : `${t.notOpened}${opened.reason}` }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)

    const list = await read($, turns)
    const current = await read($, running)
    if (list.length === 0 && current === null) return next(e)

    const t = await strings($)
    const done = list.reduce((sum, turn) => sum + turn.seconds, 0)
    const now = current ? Math.round(((await $.clock.now()) - current.startedAt) / 1000) : 0
    const last = list[list.length - 1]
    const head = current
      ? `⏱ ${t.running}: ${fmt(now)}`
      : last !== undefined
        ? `⏱ ${t.last}: ${fmt(last.seconds)}${mark(last.reason, t)}`
        : '⏱'
    const count = list.length + (current ? 1 : 0)
    const total = await totals($, list, current)
    const tail =
      ` · ${t.tokens}: ${fmtTokens(sum(total.tokens))}` +
      (total.usd !== undefined ? ` · ${fmtUsd(total.usd)}` : '')

    const { Box, Button, Text } = $.ui.resolve(e)

    return (
      <Box gap={1}>
        <Text dimColor>
          {head} · {t.session}: {fmt(done + now)} · {t.requests}: {count}
          {tail}
        </Text>
        <Button
          key="history"
          label={t.history}
          onPress={() => $.ui.open({ id: PANE, title: t.paneTitle })}
        />
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const t = await strings($)
    const list = await read($, turns)
    const current = await read($, running)
    const done = list.reduce((sum, turn) => sum + turn.seconds, 0)
    const now = current ? Math.round(((await $.clock.now()) - current.startedAt) / 1000) : 0

    const total = await totals($, list, current)

    const rows: { n: number; text: string; spend: string; time: string }[] = list.map((turn, i) => ({
      n: i + 1,
      text: label(turn.text, t) + mark(turn.reason, t),
      spend: spend(turn.tokens, turn.usd),
      time: fmt(turn.seconds),
    }))
    if (current) {
      const so = await sofar($, current)
      rows.push({
        n: rows.length + 1,
        text: label(current.text, t) + ' …',
        spend: spend(so.tokens, so.usd),
        time: fmt(now),
      })
    }

    const room = Math.max(1, (e.viewport?.rows ?? 24) - 7)
    const shown = rows.slice(-room)

    return (
      <Box flexDirection="column">
        {rows.length === 0 && <Text dimColor>{t.empty}</Text>}
        {rows.length > shown.length && <Text dimColor>{t.more(rows.length - shown.length)}</Text>}
        {shown.map(row => (
          <Box key={String(row.n)} justifyContent="space-between" gap={1}>
            <Text>
              {row.n}. {row.text}
            </Text>
            <Text>
              {row.spend && `${row.spend} · `}
              {row.time}
            </Text>
          </Box>
        ))}
        <Box justifyContent="space-between" gap={1} marginTop={1}>
          <Text bold>
            {t.total} ({rows.length})
          </Text>
          <Text bold>
            {spend(total.tokens, total.usd)} · {fmt(done + now)}
          </Text>
        </Box>
        <Text dimColor>
          {t.input} {fmtTokens(total.tokens.input)} · {t.output} {fmtTokens(total.tokens.output)} ·{' '}
          {t.cacheRead} {fmtTokens(total.tokens.cacheRead)} · {t.cacheWrite}{' '}
          {fmtTokens(total.tokens.cacheWrite)}
        </Text>
      </Box>
    )
  })
}
