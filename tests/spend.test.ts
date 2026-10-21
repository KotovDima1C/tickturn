import { expect, mock, test } from 'claude-code/testing'

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
    isWorking: false,
    maxRows: 3,
    bodyColumns: 120,
    scroll: { offset: 0, bodyRows: 3 },
    view: {},
  },
} as const

const SURFACES = ['terminal', 'desktop'] as const

const usage = (input: number, output: number, cacheRead: number, cacheWrite: number) => ({
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: cacheRead,
  cache_creation_input_tokens: cacheWrite,
  model: 'claude-opus-5-5',
})

test('a turn shows its tokens, its subagent included, and its cost', { options: { language: 'en' } }, async ($, on) => {
  mock.env(on, {})
  let usd = 1
  on('session.usage', () => ({
    value: { startedAt: 0, context: { window: 200000 }, rateLimits: [], cost: { usd } },
  }))
  on('clock.now', () => ({ value: 0 }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))

  await $.turn.start({ turnId: 't1', text: 'hello' })
  await $.turn.complete({
    turnId: 'a1',
    agentId: 'agent-1',
    answer: '',
    durationMs: 1000,
    isAborted: false,
    reason: 'answer',
    usage: usage(100, 400, 0, 0),
  })
  usd = 1.25
  await $.turn.complete({
    turnId: 't1',
    answer: 'hi',
    durationMs: 3000,
    isAborted: false,
    reason: 'answer',
    usage: usage(500, 1000, 10000, 0),
  })

  for (const surface of SURFACES) {
    const pane = await $.ui.mount({ ...PANE, surface })
    const texts = (await pane.findAll({ type: 'Text' })).map(f => f.text).join(' | ')
    expect(texts).toContain('0:03 · 12k · $0.25')
    expect(texts).toContain('input 600 · output 1.4k · cache read 10k · cache write 0')
    await pane.unmount()

    const band = await $.ui.mount({ ...BAND, surface })
    const line = (await band.findAll({ type: 'Text' })).map(f => f.text).join(' | ')
    expect(line).toContain('tokens: 12k · $0.25')
    await band.unmount()
  }
})

test('without a cost ledger the tokens still show', { options: { language: 'ru' } }, async ($, on) => {
  mock.env(on, {})
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: [] } }))
  on('clock.now', () => ({ value: 0 }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))

  await $.turn.start({ turnId: 't1', text: 'привет' })
  await $.turn.complete({
    turnId: 't1',
    answer: '',
    durationMs: 2000,
    isAborted: false,
    reason: 'answer',
    usage: usage(10, 20, 0, 0),
  })

  for (const surface of SURFACES) {
    const band = await $.ui.mount({ ...BAND, surface })
    const line = (await band.findAll({ type: 'Text' })).map(f => f.text).join(' | ')
    expect(line).toContain('токенов: 30')
    expect(line).not.toContain('$')
    await band.unmount()
  }
})
