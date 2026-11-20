import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

type Engine = Parameters<TestBody>[0]
type On = Parameters<TestBody>[1]
type Files = Map<string, { text: string; mtimeMs: number }>

const DIR = '/home/.claude/tickturn'
/** Noon of 2026-11-20, local time: far from midnight in any time zone. */
const NOON = new Date(2026, 10, 20, 12).getTime()

const PANE = {
  plugin: 'tickturn',
  component: 'Pane',
  requestId: 'tickturn',
  props: {
    title: 'tickturn',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

const BAND = {
  plugin: 'tickturn',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isCollapsed: false,
    isWorking: false,
    maxRows: 3,
    bodyColumns: 160,
    scroll: { offset: 0, bodyRows: 3 },
    view: {},
  },
} as const

/** A path as the tests spell it: the engine hands hooks an absolute one in the platform's own spelling. */
const norm = (path: string) => path.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '')

/** A file system in memory under the mod: every write gets a later mtime. */
const disk = (on: On): Files => {
  const files: Files = new Map()
  let tick = 0
  on('fs.write', (_, e) => {
    files.set(norm(e.path), { text: e.text, mtimeMs: ++tick })
    return { value: undefined }
  })
  on('fs.read', (_, e) => {
    const file = files.get(norm(e.path))
    if (!file) throw new Error(`ENOENT: ${e.path}`)
    return { value: file.text }
  })
  on('fs.exists', (_, e) => ({ value: files.has(norm(e.path)) }))
  on('fs.list', (_, e) => {
    const prefix = `${norm(e.path)}/`
    const entries = new Map<string, { name: string; kind: 'file' | 'dir'; size: number; mtimeMs: number; isLink: boolean }>()
    for (const [path, file] of files) {
      if (!path.startsWith(prefix)) continue
      const rest = path.slice(prefix.length)
      const name = rest.split('/')[0] ?? rest
      entries.set(
        name,
        rest.includes('/')
          ? { name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false }
          : { name, kind: 'file', size: file.text.length, mtimeMs: file.mtimeMs, isLink: false },
      )
    }
    if (entries.size === 0) throw new Error(`ENOENT: ${e.path}`)
    return { value: [...entries.values()] }
  })
  return files
}

/** The world under the mod: a home, a session id, a clock at NOON, a cost the test moves, a disk. */
const world = (on: On, sessionId = 's1') => {
  mock.env(on, { USERPROFILE: '/home' })
  const cost: { usd: number | undefined } = { usd: 1 }
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { window: 200000 },
      rateLimits: [],
      ...(cost.usd !== undefined && { cost: { usd: cost.usd } }),
    },
  }))
  on('session.id', () => ({ value: sessionId }))
  on('clock.now', () => ({ value: NOON }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  return { cost, files: disk(on) }
}

/** One main-loop turn of three seconds, the session cost standing at `usdAfter` when it ends. */
const turn = async ($: Engine, cost: { usd: number | undefined }, turnId: string, usdAfter: number | undefined) => {
  await $.turn.start({ turnId, text: 'hello' })
  cost.usd = usdAfter
  await $.turn.complete({
    turnId,
    answer: '',
    durationMs: 3000,
    isAborted: false,
    reason: 'answer',
    usage: {
      input_tokens: 10,
      output_tokens: 20,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      model: 'claude-opus-5-5',
    },
  })
}

const seed = (files: Files, path: string, days: Record<string, unknown>) =>
  files.set(path, { text: JSON.stringify({ days }), mtimeMs: 0.5 })

const daysIn = (files: Files, path: string) => JSON.parse(files.get(path)?.text ?? '{}').days

const bandText = async ($: Engine) => {
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const text = (await band.findAll({ type: 'Text' })).map(f => f.text).join(' | ')
  await band.unmount()
  return text
}

const paneText = async ($: Engine) => {
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const text = (await pane.findAll({ type: 'Text' })).map(f => f.text).join(' | ')
  await pane.unmount()
  return text
}

test('a turn is booked to today in the session file', { options: { language: 'en' } }, async ($, on) => {
  const { cost, files } = world(on)

  await turn($, cost, 't1', 1.25)

  expect(daysIn(files, `${DIR}/sessions/2026-11/s1.json`)).toEqual({
    '2026-11-20': { usd: 0.25, requests: 1, seconds: 3 },
  })
})

test('cost that grew between turns goes to the next turn', { options: { language: 'en' } }, async ($, on) => {
  const { cost, files } = world(on)

  await turn($, cost, 't1', 1.25)
  cost.usd = 1.5
  await turn($, cost, 't2', 2)

  expect(daysIn(files, `${DIR}/sessions/2026-11/s1.json`)).toEqual({
    '2026-11-20': { usd: 1, requests: 2, seconds: 6 },
  })
})

test('a cost counter that started over counts from zero', { options: { language: 'en' } }, async ($, on) => {
  const { cost, files } = world(on)

  await turn($, cost, 't1', 1.25)
  cost.usd = 0.25
  await turn($, cost, 't2', 0.5)

  expect(daysIn(files, `${DIR}/sessions/2026-11/s1.json`)).toEqual({
    '2026-11-20': { usd: 0.75, requests: 2, seconds: 6 },
  })
})

test('without a cost ledger the day still gets its request and time', { options: { language: 'en' } }, async ($, on) => {
  const { cost, files } = world(on)
  cost.usd = undefined

  await turn($, cost, 't1', undefined)

  expect(daysIn(files, `${DIR}/sessions/2026-11/s1.json`)).toEqual({
    '2026-11-20': { usd: 0, requests: 1, seconds: 3 },
  })
})

test('a resumed session adds to the file it left', { options: { language: 'en' } }, async ($, on) => {
  const { cost, files } = world(on)
  seed(files, `${DIR}/sessions/2026-11/s1.json`, {
    '2026-11-19': { usd: 2, requests: 4, seconds: 40 },
    '2026-11-20': { usd: 3, requests: 2, seconds: 30 },
  })

  await turn($, cost, 't1', 1.25)

  expect(daysIn(files, `${DIR}/sessions/2026-11/s1.json`)).toEqual({
    '2026-11-19': { usd: 2, requests: 4, seconds: 40 },
    '2026-11-20': { usd: 3.25, requests: 3, seconds: 33 },
  })
})

test('the band and the pane show today and the month over every session, money only', { options: { language: 'en' } }, async ($, on) => {
  const { cost, files } = world(on)
  seed(files, `${DIR}/sessions/2026-11/other.json`, {
    '2026-11-19': { usd: 1, requests: 1, seconds: 10 },
    '2026-11-20': { usd: 2, requests: 5, seconds: 60 },
  })

  await turn($, cost, 't1', 1.25)

  expect(await bandText($)).toContain('Today: $2.25')
  const pane = await paneText($)
  expect(pane).toContain('Today | $2.25')
  expect(pane).toContain('This month | $3.25')
  expect(daysIn(files, `${DIR}/sessions/2026-11/other.json`)).toEqual({
    '2026-11-19': { usd: 1, requests: 1, seconds: 10 },
    '2026-11-20': { usd: 2, requests: 5, seconds: 60 },
  })
})

test('the band says today in Russian', { options: { language: 'ru' } }, async ($, on) => {
  const { cost } = world(on)

  await turn($, cost, 't1', 1.25)

  expect(await bandText($)).toContain('Сегодня: $0.25')
  expect(await paneText($)).toContain('Этот месяц | $0.25')
})

test('without a cost ledger no daily money is shown', { options: { language: 'en' } }, async ($, on) => {
  const { cost } = world(on)
  cost.usd = undefined

  await turn($, cost, 't1', undefined)

  expect(await bandText($)).not.toContain('Today')
  expect(await paneText($)).not.toContain('Today')
})

test('a broken file of another session is skipped', { options: { language: 'en' } }, async ($, on) => {
  const { cost, files } = world(on)
  on('ui.log', () => ({ value: undefined }))
  files.set(`${DIR}/sessions/2026-11/broken.json`, { text: 'not json', mtimeMs: 0.5 })

  await turn($, cost, 't1', 1.25)

  expect(await bandText($)).toContain('Today: $0.25')
})

test('the report lists days and months, newest first, with requests and time', { options: { language: 'en' } }, async ($, on) => {
  const { cost, files } = world(on)
  seed(files, `${DIR}/sessions/2026-11/other.json`, {
    '2026-11-19': { usd: 1, requests: 1, seconds: 10 },
    '2026-11-20': { usd: 2, requests: 5, seconds: 60 },
  })
  seed(files, `${DIR}/sessions/2026-10/old.json`, {
    '2026-10-31': { usd: 4, requests: 9, seconds: 3700 },
  })

  await turn($, cost, 't1', 1.25)

  expect(files.get(`${DIR}/costs.md`)?.text).toBe(
    [
      '# Claude Code spending',
      '',
      '| Day | Amount | Requests | Time |',
      '| --- | --- | --- | --- |',
      '| 2026-11-20 | $2.25 | 6 | 0:01:03 |',
      '| 2026-11-19 | $1.00 | 1 | 0:00:10 |',
      '| 2026-10-31 | $4.00 | 9 | 1:01:40 |',
      '',
      '| Month | Amount | Requests | Time |',
      '| --- | --- | --- | --- |',
      '| 2026-11 | $3.25 | 7 | 0:01:13 |',
      '| 2026-10 | $4.00 | 9 | 1:01:40 |',
      '',
    ].join('\n'),
  )
})

test('the report is Russian with the Russian UI, at the path the option names', { options: { language: 'ru', reportPath: '~/notes/claude.md' } }, async ($, on) => {
  const { cost, files } = world(on)

  await turn($, cost, 't1', 1.25)

  const text = files.get('/home/notes/claude.md')?.text ?? ''
  expect(text).toContain('# Расходы Claude Code')
  expect(text).toContain('| День | Сумма | Запросов | Время |')
  expect(text).toContain('| Месяц | Сумма | Запросов | Время |')
  expect(text).toContain('| 2026-11-20 | $0.25 | 1 | 0:00:03 |')
  expect(files.has(`${DIR}/costs.md`)).toBe(false)
})

test('a finished month is rolled up into one file, and read from it afterwards', { options: { language: 'en' } }, async ($, on) => {
  const { cost, files } = world(on)
  seed(files, `${DIR}/sessions/2026-09/a.json`, { '2026-09-30': { usd: 4, requests: 9, seconds: 100 } })
  seed(files, `${DIR}/sessions/2026-09/b.json`, { '2026-09-30': { usd: 1, requests: 1, seconds: 20 } })
  seed(files, `${DIR}/months/2026-08.json`, { '2026-08-15': { usd: 7, requests: 3, seconds: 50 } })
  seed(files, `${DIR}/sessions/2026-08/stale.json`, { '2026-08-15': { usd: 100, requests: 100, seconds: 100 } })

  await turn($, cost, 't1', 1.25)

  expect(daysIn(files, `${DIR}/months/2026-09.json`)).toEqual({
    '2026-09-30': { usd: 5, requests: 10, seconds: 120 },
  })
  expect(files.has(`${DIR}/months/2026-11.json`)).toBe(false)
  const text = files.get(`${DIR}/costs.md`)?.text ?? ''
  expect(text).toContain('| 2026-09 | $5.00 | 10 | 0:02:00 |')
  expect(text).toContain('| 2026-08 | $7.00 | 3 | 0:00:50 |')
})

test('a month with a broken file is not rolled up', { options: { language: 'en' } }, async ($, on) => {
  const { cost, files } = world(on)
  on('ui.log', () => ({ value: undefined }))
  seed(files, `${DIR}/sessions/2026-09/a.json`, { '2026-09-30': { usd: 4, requests: 9, seconds: 100 } })
  files.set(`${DIR}/sessions/2026-09/broken.json`, { text: 'not json', mtimeMs: 0.5 })

  await turn($, cost, 't1', 1.25)

  expect(files.has(`${DIR}/months/2026-09.json`)).toBe(false)
  expect(files.get(`${DIR}/costs.md`)?.text ?? '').toContain('| 2026-09 | $4.00 | 9 | 0:01:40 |')
})
