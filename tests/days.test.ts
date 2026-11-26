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

type Turn = { id: string; seconds: number; reason: 'answer'; text: string; usd?: number; endedAt?: number }

/** A turn of another session, ended at noon of `day`, local time. */
const done = (id: string, day: string, usd: number, seconds: number): Turn => {
  const [y, m, d] = day.split('-').map(Number)
  return { id, text: id, seconds, reason: 'answer', usd, endedAt: new Date(y ?? 0, (m ?? 1) - 1, d, 12).getTime() }
}

const seed = (files: Files, id: string, turns: Turn[], before?: Record<string, unknown>, mtimeMs = 0.5) =>
  files.set(`${DIR}/history/${id}.json`, {
    text: JSON.stringify({ turns, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, ...(before && { before }) }),
    mtimeMs,
  })

const history = (files: Files, id = 's1') => JSON.parse(files.get(`${DIR}/history/${id}.json`)?.text ?? '{}')

const usds = (files: Files) => history(files).turns.map((t: { usd?: number }) => t.usd)

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

const report = (files: Files) => files.get(`${DIR}/costs.md`)?.text ?? ''

test('a turn is kept with its cost and the time it ended', { options: { language: 'en' } }, async ($, on) => {
  const { cost, files } = world(on)

  await turn($, cost, 't1', 1.25)

  expect(history(files).turns).toEqual([
    {
      id: 't1',
      text: 'hello',
      seconds: 3,
      reason: 'answer',
      endedAt: NOON,
      tokens: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0 },
      usd: 0.25,
    },
  ])
  expect(report(files)).toContain('| 2026-11-20 | $0.25 | 1 | 0:00:03 |')
})

test('cost that grew between turns goes to the next turn', { options: { language: 'en' } }, async ($, on) => {
  const { cost, files } = world(on)

  await turn($, cost, 't1', 1.25)
  cost.usd = 1.5
  await turn($, cost, 't2', 2)

  expect(usds(files)).toEqual([0.25, 0.75])
  expect(report(files)).toContain('| 2026-11-20 | $1.00 | 2 | 0:00:06 |')
})

test('a cost counter that started over counts from zero', { options: { language: 'en' } }, async ($, on) => {
  const { cost, files } = world(on)

  await turn($, cost, 't1', 1.25)
  cost.usd = 0.25
  await turn($, cost, 't2', 0.5)

  expect(usds(files)).toEqual([0.25, 0.5])
})

test('without a cost ledger the day still gets its request and time', { options: { language: 'en' } }, async ($, on) => {
  const { cost, files } = world(on)
  cost.usd = undefined

  await turn($, cost, 't1', undefined)

  expect(usds(files)).toEqual([undefined])
  expect(report(files)).toContain('| 2026-11-20 | $0.00 | 1 | 0:00:03 |')
})

test('the band and the pane show today and the month over every session, money only', { options: { language: 'en' } }, async ($, on) => {
  const { cost, files } = world(on)
  seed(files, 'other', [done('o1', '2026-11-19', 1, 10), done('o2', '2026-11-20', 2, 60)])

  await turn($, cost, 't1', 1.25)

  expect(await bandText($)).toContain('Today: $2.25')
  const pane = await paneText($)
  expect(pane).toContain('Today | $2.25')
  expect(pane).toContain('This month | $3.25')
  expect(history(files, 'other').turns).toHaveLength(2)
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
  files.set(`${DIR}/history/broken.json`, { text: 'not json', mtimeMs: 0.5 })

  await turn($, cost, 't1', 1.25)

  expect(await bandText($)).toContain('Today: $0.25')
})

test('a turn with no end time counts on the day its file was written', { options: { language: 'en' } }, async ($, on) => {
  const { cost, files } = world(on)
  seed(files, 'old', [{ id: 'o1', text: 'o1', seconds: 5, reason: 'answer', usd: 2 }], undefined, NOON)

  await turn($, cost, 't1', 1.25)

  expect(report(files)).toContain('| 2026-11-20 | $2.25 | 2 | 0:00:08 |')
})

test('days a session booked before it kept turns are counted', { options: { language: 'en' } }, async ($, on) => {
  const { cost, files } = world(on)
  seed(files, 'legacy', [], { '2026-11-19': { usd: 3, requests: 4, seconds: 40 } })

  await turn($, cost, 't1', 1.25)

  expect(report(files)).toContain('| 2026-11-19 | $3.00 | 4 | 0:00:40 |')
})

test('the old per-month day files are not read', { options: { language: 'en' } }, async ($, on) => {
  const { cost, files } = world(on)
  files.set(`${DIR}/sessions/2026-11/old.json`, {
    text: JSON.stringify({ days: { '2026-11-20': { usd: 100, requests: 9, seconds: 9 } } }),
    mtimeMs: 0.5,
  })

  await turn($, cost, 't1', 1.25)

  expect(await bandText($)).toContain('Today: $0.25')
})

test('the report lists days and months, newest first, with requests and time', { options: { language: 'en' } }, async ($, on) => {
  const { cost, files } = world(on)
  seed(files, 'other', [done('o1', '2026-11-19', 1, 10), done('o2', '2026-11-20', 2, 60)])
  seed(files, 'old', [done('p1', '2026-10-31', 4, 3700)])

  await turn($, cost, 't1', 1.25)

  expect(report(files)).toBe(
    [
      '# Claude Code spending',
      '',
      '| Day | Amount | Requests | Time |',
      '| --- | --- | --- | --- |',
      '| 2026-11-20 | $2.25 | 2 | 0:01:03 |',
      '| 2026-11-19 | $1.00 | 1 | 0:00:10 |',
      '| 2026-10-31 | $4.00 | 1 | 1:01:40 |',
      '',
      '| Month | Amount | Requests | Time |',
      '| --- | --- | --- | --- |',
      '| 2026-11 | $3.25 | 3 | 0:01:13 |',
      '| 2026-10 | $4.00 | 1 | 1:01:40 |',
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
