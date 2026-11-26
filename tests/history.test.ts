import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

type Engine = Parameters<TestBody>[0]
type On = Parameters<TestBody>[1]
type Files = Map<string, string>

const DIR = '/home/.claude/tickturn'
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

const norm = (path: string) => path.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '')

/** A disk in memory, plus the engine calls a session start and a turn need. */
const world = (on: On, sessionId = 's1') => {
  mock.env(on, { USERPROFILE: '/home' })
  const files: Files = new Map()
  let tick = 0
  const mtimes = new Map<string, number>()
  on('fs.write', (_, e) => {
    files.set(norm(e.path), e.text)
    mtimes.set(norm(e.path), ++tick)
    return { value: undefined }
  })
  on('fs.read', (_, e) => {
    const text = files.get(norm(e.path))
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: text }
  })
  on('fs.exists', (_, e) => ({ value: files.has(norm(e.path)) }))
  on('fs.list', (_, e) => {
    const prefix = `${norm(e.path)}/`
    const entries = new Map<string, { name: string; kind: 'file' | 'dir'; size: number; mtimeMs: number; isLink: boolean }>()
    for (const [path, text] of files) {
      if (!path.startsWith(prefix)) continue
      const rest = path.slice(prefix.length)
      const name = rest.split('/')[0] ?? rest
      entries.set(
        name,
        rest.includes('/')
          ? { name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false }
          : { name, kind: 'file', size: text.length, mtimeMs: mtimes.get(path) ?? 0, isLink: false },
      )
    }
    if (entries.size === 0) throw new Error(`ENOENT: ${e.path}`)
    return { value: [...entries.values()] }
  })
  const cost: { usd: number } = { usd: 1 }
  on('session.usage', () => ({
    value: { startedAt: 0, context: { window: 200000 }, rateLimits: [], cost: { usd: cost.usd } },
  }))
  on('session.id', () => ({ value: sessionId }))
  on('clock.now', () => ({ value: NOON }))
  on('command.register', () => ({ value: undefined }))
  on('clock.every', () => ({ value: undefined }) as never)
  on('ui.log', () => ({ value: undefined }))
  on('session.start', (_, e) => e)
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  return { cost, files }
}

const turn = async ($: Engine, cost: { usd: number }, turnId: string, text: string, usdAfter: number) => {
  await $.turn.start({ turnId, text })
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
      cache_read_input_tokens: 5,
      cache_creation_input_tokens: 1,
      model: 'claude-opus-5-5',
    },
  })
}

const textOf = async ($: Engine, at: typeof PANE | typeof BAND) => {
  const mounted = await $.ui.mount({ ...at, surface: 'terminal' })
  const text = (await mounted.findAll({ type: 'Text' })).map(f => f.text).join(' | ')
  await mounted.unmount()
  return text
}

const HISTORY = `${DIR}/history/s1.json`

const saved = {
  turns: [
    {
      id: 'old1',
      text: 'first question',
      seconds: 65,
      reason: 'answer',
      tokens: { input: 100, output: 200, cacheRead: 300, cacheWrite: 400 },
      usd: 0.5,
    },
    { id: 'old2', text: 'second question', seconds: 5, reason: 'aborted', usd: 0.25 },
  ],
  tokens: { input: 100, output: 200, cacheRead: 300, cacheWrite: 400 },
}

test('a finished turn is saved to the session history file', { options: { language: 'en' } }, async ($, on) => {
  const { cost, files } = world(on)
  await $.session.start({ cwd: '/w' })

  await turn($, cost, 't1', 'hello there', 1.25)

  expect(JSON.parse(files.get(HISTORY) ?? '{}')).toEqual({
    turns: [
      {
        id: 't1',
        text: 'hello there',
        seconds: 3,
        reason: 'answer',
        endedAt: NOON,
        tokens: { input: 10, output: 20, cacheRead: 5, cacheWrite: 1 },
        usd: 0.25,
      },
    ],
    tokens: { input: 10, output: 20, cacheRead: 5, cacheWrite: 1 },
  })
})

test('a long request is kept to its first 100 characters', { options: { language: 'en' } }, async ($, on) => {
  const { cost, files } = world(on)
  await $.session.start({ cwd: '/w' })

  await turn($, cost, 't1', 'я'.repeat(300), 1.25)

  expect(JSON.parse(files.get(HISTORY) ?? '{}').turns[0].text).toBe('я'.repeat(100))
})

test('a session that starts again gets its history back', { options: { language: 'en' } }, async ($, on) => {
  const { files } = world(on)
  files.set(HISTORY, JSON.stringify(saved))

  await $.session.start({ cwd: '/w', source: 'resume' })

  const pane = await textOf($, PANE)
  expect(pane).toContain('1. first question')
  expect(pane).toContain('2. second question (interrupted)')
  expect(pane).toContain('Total (2)')
  expect(pane).toContain('1:10 · 1.0k · $0.75')
  expect(await textOf($, BAND)).toContain('requests: 2')
})

test('turns after a restore are added to the history it held', { options: { language: 'en' } }, async ($, on) => {
  const { cost, files } = world(on)
  files.set(HISTORY, JSON.stringify(saved))
  await $.session.start({ cwd: '/w', source: 'resume' })

  await turn($, cost, 't3', 'third', 1.25)

  const after = JSON.parse(files.get(HISTORY) ?? '{}')
  expect(after.turns.map((t: { id: string }) => t.id)).toEqual(['old1', 'old2', 't3'])
  expect(after.tokens).toEqual({ input: 110, output: 220, cacheRead: 305, cacheWrite: 401 })
  expect(await textOf($, PANE)).toContain('Total (3)')
})

test('another session does not see this one’s history', { options: { language: 'en' } }, async ($, on) => {
  const { files } = world(on, 's2')
  files.set(HISTORY, JSON.stringify(saved))

  await $.session.start({ cwd: '/w' })

  expect(await textOf($, PANE)).toContain('No requests yet.')
})

test('a session started by /clear does not bring the history back', { options: { language: 'en' } }, async ($, on) => {
  const { files } = world(on)
  files.set(HISTORY, JSON.stringify(saved))

  await $.session.start({ cwd: '/w', source: 'clear' })

  expect(await textOf($, PANE)).toContain('No requests yet.')
})

test('a broken history file starts the session empty', { options: { language: 'en' } }, async ($, on) => {
  const { cost, files } = world(on)
  files.set(HISTORY, 'not json')

  await $.session.start({ cwd: '/w' })
  expect(await textOf($, PANE)).toContain('No requests yet.')

  await turn($, cost, 't1', 'hello', 1.25)
  expect(JSON.parse(files.get(HISTORY) ?? '{}').turns).toHaveLength(1)
})

test('today shows from the session start, before any turn of it ends', { options: { language: 'en' } }, async ($, on) => {
  const { files } = world(on)
  files.set(
    `${DIR}/history/other.json`,
    JSON.stringify({
      turns: [{ id: 'o1', text: 'o1', seconds: 60, reason: 'answer', usd: 2, endedAt: NOON }],
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }),
  )
  await $.session.start({ cwd: '/w' })

  await $.turn.start({ turnId: 't1', text: 'hello' })

  expect(await textOf($, BAND)).toContain('Today: $2.00')
})

test('a save keeps turns and earlier days the file holds that memory has not', { options: { language: 'en' } }, async ($, on) => {
  const { cost, files } = world(on)
  await $.session.start({ cwd: '/w' })
  files.set(HISTORY, JSON.stringify({ ...saved, before: { '2026-11-01': { usd: 9, requests: 3, seconds: 30 } } }))

  await turn($, cost, 't1', 'hello', 1.25)

  const after = JSON.parse(files.get(HISTORY) ?? '{}')
  expect(after.turns.map((t: { id: string }) => t.id)).toEqual(['old1', 'old2', 't1'])
  expect(after.before).toEqual({ '2026-11-01': { usd: 9, requests: 3, seconds: 30 } })
})

test('after /clear the next save starts the file over', { options: { language: 'en' } }, async ($, on) => {
  const { cost, files } = world(on)
  on('session.end', (_, e) => e as never)
  files.set(HISTORY, JSON.stringify(saved))
  await $.session.start({ cwd: '/w' })

  await $.session.end({ reason: 'clear', sessionId: 's1' } as never)
  await turn($, cost, 't1', 'hello', 1.25)

  expect(JSON.parse(files.get(HISTORY) ?? '{}').turns.map((t: { id: string }) => t.id)).toEqual(['t1'])
})
