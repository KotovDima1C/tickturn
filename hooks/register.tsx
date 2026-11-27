import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { DayTotals, Days, History, RunningTurn, Tokens, TurnReason, TurnRecord } from '../types'

const PANE = 'tickturn'
const COMMAND = 'time'
const MAX_TURNS = 500
const LABEL_CHARS = 25
/** How much of a request's text a record keeps: enough for the label, not the whole prompt on disk. */
const TEXT_CHARS = 100

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
    today: 'Сегодня',
    thisMonth: 'Этот месяц',
    reportTitle: 'Расходы Claude Code',
    day: 'День',
    month: 'Месяц',
    amount: 'Сумма',
    reportRequests: 'Запросов',
    time: 'Время',
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
    today: 'Today',
    thisMonth: 'This month',
    reportTitle: 'Claude Code spending',
    day: 'Day',
    month: 'Month',
    amount: 'Amount',
    reportRequests: 'Requests',
    time: 'Time',
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
/** The `reportPath` option as `register` received it. */
let reportOption: unknown

const strings = async ($: EngineInterface): Promise<Strings> => {
  language ??= detect($, languageOption)
  return STRINGS[await language]
}

const turns = atom({ plugin: 'tickturn', key: 'turns' } as const, [])
const running = atom({ plugin: 'tickturn', key: 'running' } as const, null)
const NO_TOKENS: Tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
/** Every turn's tokens this session, subagents' included: a turn's own is the growth of this while it ran. */
const spent = atom({ plugin: 'tickturn', key: 'tokens' } as const, NO_TOKENS)
const lastUsd = atom({ plugin: 'tickturn', key: 'lastUsd' } as const, null)
const daily = atom({ plugin: 'tickturn', key: 'daily' } as const, null)

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

const NO_DAY: DayTotals = { usd: 0, requests: 0, seconds: 0 }

/** The local calendar day of a time, `YYYY-MM-DD`. */
const dayKey = (ms: number) => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

const monthOf = (day: string) => day.slice(0, 7)

const addDay = (a: DayTotals, b: DayTotals): DayTotals => ({
  usd: a.usd + b.usd,
  requests: a.requests + b.requests,
  seconds: a.seconds + b.seconds,
})

const merge = (into: Days, from: Days): Days => {
  const out: Days = { ...into }
  for (const [day, totals] of Object.entries(from)) out[day] = addDay(out[day] ?? NO_DAY, totals)
  return out
}

let hasComplained = false

/** One log line per process about a file the statistics could not use. */
const complain = async ($: EngineInterface, what: string) => {
  if (hasComplained) return
  hasComplained = true
  try {
    await $.ui.log(`tickturn: ${what}`)
  } catch {
    // nowhere to say it
  }
}

/** Day totals as a file holds them; entries that are not day totals are left out. */
const parseDays = (map: unknown): Days => {
  const days: Days = {}
  if (typeof map !== 'object' || map === null) return days
  for (const [day, value] of Object.entries(map)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || typeof value !== 'object' || value === null) continue
    const totals = value as Partial<Record<keyof DayTotals, unknown>>
    days[day] = {
      usd: Number(totals.usd) || 0,
      requests: Number(totals.requests) || 0,
      seconds: Number(totals.seconds) || 0,
    }
  }
  return days
}

/** A folder's entries, none where it is not there. */
const list = async ($: EngineInterface, path: string) => {
  try {
    return await $.fs.list(path)
  } catch {
    return []
  }
}

/** A session's turns summed by the local day each ended on; a turn with no end time counts on `fallbackMs`'s day. */
const daysOf = (history: History, fallbackMs: number): Days => {
  let days: Days = { ...history.before }
  for (const turn of history.turns) {
    const day = dayKey(turn.endedAt ?? fallbackMs)
    days = merge(days, { [day]: { usd: turn.usd ?? 0, requests: 1, seconds: turn.seconds } })
  }
  return days
}

/** History files read so far, by name, with the size and time they were read at. */
const seen = new Map<string, { mtimeMs: number; size: number; days: Days }>()

/** Every session's days on this computer, summed from the history files. */
const collect = async ($: EngineInterface, dir: string) => {
  let all: Days = {}
  for (const entry of await list($, `${dir}/history`)) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.json')) continue
    let hit = seen.get(entry.name)
    if (!hit || hit.mtimeMs !== entry.mtimeMs || hit.size !== entry.size) {
      const path = `${dir}/history/${entry.name}`
      try {
        hit = { mtimeMs: entry.mtimeMs, size: entry.size, days: daysOf(parseHistory(await $.fs.read(path)), entry.mtimeMs) }
      } catch (error) {
        await complain($, `${path}: ${String(error)}`)
        continue
      }
      seen.set(entry.name, hit)
    }
    all = merge(all, hit.days)
  }
  return all
}

const fmtHms = (seconds: number) =>
  `${Math.floor(seconds / 3600)}:${pad(Math.floor((seconds % 3600) / 60))}:${pad(seconds % 60)}`

/** The report file: a table of days and a table of months, newest first. */
const report = (all: Days, t: Strings) => {
  const byNewest = (days: Days) => Object.entries(days).sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0))
  const months: Days = {}
  for (const [day, totals] of Object.entries(all)) {
    months[monthOf(day)] = addDay(months[monthOf(day)] ?? NO_DAY, totals)
  }
  const table = (head: string, rows: Days) =>
    [
      `| ${head} | ${t.amount} | ${t.reportRequests} | ${t.time} |`,
      '| --- | --- | --- | --- |',
      ...byNewest(rows).map(
        ([name, totals]) => `| ${name} | ${fmtUsd(totals.usd)} | ${totals.requests} | ${fmtHms(totals.seconds)} |`,
      ),
    ].join('\n')
  return `# ${t.reportTitle}\n\n${table(t.day, all)}\n\n${table(t.month, months)}\n`
}

/**
 * What the session cost grew by since the last turn ended: the turn's own cost
 * and whatever the session spent between turns. At the first turn after the mod
 * started that is the turn's own cost, so a resumed session's earlier spend is
 * not counted twice; a counter that started over counts from zero.
 */
const growth = async ($: EngineInterface, own: number | undefined) => {
  const now = await sessionUsd($)
  if (now === undefined) return undefined
  const last = await read($, lastUsd)
  await update($, lastUsd, () => now)
  if (last === null) return Math.max(0, own ?? 0)
  return now >= last ? now - last : now
}

/** The person's home and the mod's data folder under it; undefined where no home is named. */
const dataDir = async ($: EngineInterface) => {
  const home = (await $.env.get('USERPROFILE')) || (await $.env.get('HOME'))
  return home ? { home, dir: `${home}/.claude/tickturn` } : undefined
}

/** Sums every session's days and keeps today's and this month's money for the band and the pane. */
const refreshDaily = async ($: EngineInterface, dir: string, now: number) => {
  const day = dayKey(now)
  const month = monthOf(day)
  const all = await collect($, dir)
  let monthUsd = 0
  for (const [key, totals] of Object.entries(all)) {
    if (monthOf(key) === month) monthUsd += totals.usd
  }
  await update($, daily, () => ({ day, today: all[day]?.usd ?? 0, month: monthUsd }))
  return all
}

const isReason = (value: unknown): value is TurnReason =>
  value === 'answer' || value === 'aborted' || value === 'refusal' || value === 'error'

const toTokens = (value: unknown): Tokens | undefined => {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Partial<Record<keyof Tokens, unknown>>
  return {
    input: Number(raw.input) || 0,
    output: Number(raw.output) || 0,
    cacheRead: Number(raw.cacheRead) || 0,
    cacheWrite: Number(raw.cacheWrite) || 0,
  }
}

/** A history file's turns, token total and pre-history days; records that are not turns are left out. */
const parseHistory = (text: string): History => {
  const raw: unknown = JSON.parse(text)
  const body = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
  const turns: TurnRecord[] = []
  for (const item of Array.isArray(body.turns) ? body.turns : []) {
    if (typeof item !== 'object' || item === null) continue
    const r = item as Record<string, unknown>
    if (typeof r.id !== 'string' || !isReason(r.reason)) continue
    const tokens = toTokens(r.tokens)
    turns.push({
      id: r.id,
      text: typeof r.text === 'string' ? r.text : '',
      seconds: Number(r.seconds) || 0,
      reason: r.reason,
      ...(typeof r.endedAt === 'number' && { endedAt: r.endedAt }),
      ...(tokens && { tokens }),
      ...(typeof r.usd === 'number' && { usd: r.usd }),
    })
  }
  const before = parseDays(body.before)
  return {
    turns,
    tokens: toTokens(body.tokens) ?? NO_TOKENS,
    ...(Object.keys(before).length > 0 && { before }),
  }
}

const historyPath = (dir: string, id: string) => `${dir}/history/${id}.json`

/** This session's history file as it stands, or undefined where there is none or it cannot be used. */
const readHistory = async ($: EngineInterface, path: string) => {
  if (!(await $.fs.exists(path))) return undefined
  try {
    return parseHistory(await $.fs.read(path))
  } catch (error) {
    await complain($, `${path}: ${String(error)}`)
    return undefined
  }
}

/** Set by /clear: the next save starts the file over instead of keeping turns it holds. */
let isCleared = false

/**
 * Writes this session's history whole, so a restart or a resume can bring it
 * back. Turns the file holds that memory has not (another window of the same
 * session, a migration) are kept ahead of memory's, and so are its pre-history days.
 */
/** When a session's history file was last written; undefined where it is not there. */
const writtenAt = async ($: EngineInterface, dir: string, id: string) =>
  (await list($, `${dir}/history`)).find(entry => entry.name === `${id}.json`)?.mtimeMs

/**
 * Gives turns written before 0.6.0, which have no end time, the time their file
 * was written, once: otherwise they would move to whatever day the file is next written.
 */
const stamp = (list: TurnRecord[], at: number | undefined) =>
  at === undefined ? list : list.map(turn => (turn.endedAt === undefined ? { ...turn, endedAt: at } : turn))

const saveHistory = async ($: EngineInterface, dir: string) => {
  const id = await $.session.id()
  const path = historyPath(dir, id)
  const mine = await read($, turns)
  const onDisk = isCleared ? undefined : await readHistory($, path)
  const held = onDisk && { ...onDisk, turns: stamp(onDisk.turns, await writtenAt($, dir, id)) }
  isCleared = false
  const ids = new Set(mine.map(turn => turn.id))
  const body: History = {
    turns: [...(held?.turns.filter(turn => !ids.has(turn.id)) ?? []), ...mine],
    tokens: await read($, spent),
    ...(held?.before && { before: held.before }),
  }
  await $.fs.write(path, JSON.stringify(body))
}

/** Puts this session's saved turns back when the mod starts with none in memory. */
const loadHistory = async ($: EngineInterface, dir: string) => {
  if ((await read($, turns)).length > 0 || (await read($, running)) !== null) return
  const id = await $.session.id()
  const saved = await readHistory($, historyPath(dir, id))
  if (!saved) return
  const stamped = stamp(saved.turns, await writtenAt($, dir, id))
  await update($, turns, () => stamped.slice(-MAX_TURNS))
  await update($, spent, () => saved.tokens)
}

/** Saves the session's history, then sums every session's for the band, the pane and the report. */
const book = async ($: EngineInterface) => {
  const place = await dataDir($)
  if (!place) return

  await saveHistory($, place.dir)
  const all = await refreshDaily($, place.dir, await $.clock.now())

  const custom = typeof reportOption === 'string' ? reportOption.trim() : ''
  const target = custom === '' ? `${place.dir}/costs.md` : custom.replace(/^~(?=[\\/]|$)/, place.home)
  await $.fs.write(target, report(all, await strings($)))
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
  reportOption = options.reportPath
  hasComplained = false
  seen.clear()
  isCleared = false

  on('session.start', async ($, e, next) => {
    const t = await strings($)
    await $.command.register({ name: COMMAND, description: t.command })
    isRunning = (await read($, running)) !== null
    $.clock.every(1000, () => {
      if (isRunning) $.ui.invalidate('ui.render')
    })

    // the history and the day's money never stand in a session's way
    try {
      const place = await dataDir($)
      if (place) {
        if (e.source !== 'clear') await loadHistory($, place.dir)
        await refreshDaily($, place.dir, await $.clock.now())
      }
    } catch (error) {
      await complain($, String(error))
    }

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
    const usd = await growth($, cost.usd)
    const record: TurnRecord = {
      id: e.turnId,
      text: mine ? Array.from(mine.text).slice(0, TEXT_CHARS).join('') : '',
      seconds: Math.round(e.durationMs / 1000),
      reason: e.reason,
      endedAt: await $.clock.now(),
      ...(cost.tokens && { tokens: cost.tokens }),
      ...(usd !== undefined && { usd }),
    }
    await update($, turns, list => [...list, record].slice(-MAX_TURNS))
    await update($, running, () => null)
    isRunning = false

    try {
      await book($)
    } catch (error) {
      // the history and the day's statistics never stand in a turn's way
      await complain($, String(error))
    }

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await update($, turns, () => [])
      await update($, running, () => null)
      await update($, spent, () => NO_TOKENS)
      await update($, lastUsd, () => null)
      isCleared = true
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
    const spentToday = await read($, daily)
    const today =
      spentToday && total.usd !== undefined && spentToday.day === dayKey(await $.clock.now())
        ? ` · ${t.today}: ${fmtUsd(spentToday.today)}`
        : ''

    const { Box, Button, Text } = $.ui.resolve(e)

    return (
      <Box gap={1}>
        <Text dimColor>
          {head} · {t.session}: {fmt(done + now)} · {t.requests}: {count}
          {tail}
          {today}
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

    const spentToday = await read($, daily)
    const money =
      spentToday && total.usd !== undefined && spentToday.day === dayKey(await $.clock.now())
        ? spentToday
        : null

    const room = Math.max(1, (e.viewport?.rows ?? 24) - 7 - (money ? 2 : 0))
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
              {row.time}
              {row.spend && ` · ${row.spend}`}
            </Text>
          </Box>
        ))}
        <Box justifyContent="space-between" gap={1} marginTop={1}>
          <Text bold>
            {t.total} ({rows.length})
          </Text>
          <Text bold>
            {fmt(done + now)} · {spend(total.tokens, total.usd)}
          </Text>
        </Box>
        <Text dimColor>
          {t.input} {fmtTokens(total.tokens.input)} · {t.output} {fmtTokens(total.tokens.output)} ·{' '}
          {t.cacheRead} {fmtTokens(total.tokens.cacheRead)} · {t.cacheWrite}{' '}
          {fmtTokens(total.tokens.cacheWrite)}
        </Text>
        {money && (
          <Box justifyContent="space-between" gap={1}>
            <Text>{t.today}</Text>
            <Text>{fmtUsd(money.today)}</Text>
          </Box>
        )}
        {money && (
          <Box justifyContent="space-between" gap={1}>
            <Text>{t.thisMonth}</Text>
            <Text>{fmtUsd(money.month)}</Text>
          </Box>
        )}
      </Box>
    )
  })
}
