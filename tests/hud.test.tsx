import { expect, test } from 'claude-code/testing'

const hint = (text: string) =>
  ({ component: 'PromptHint', props: { isDraft: false, isWorking: false, hint: text } }) as const

const IDLE = hint('? for shortcuts · ← for agents')

test('the HUD draws context and rate-limit bars under the prompt', async ($, on) => {
  on('session.measure', (_, e) => ({ changed: e.changed }))
  await $.session.measure({
    context: { tokens: 104_000, window: 200_000, percent: 52 },
    rateLimits: [
      { kind: 'five_hour', percentUsed: 23 },
      { kind: 'seven_day', percentUsed: 81.5 },
    ],
    cost: { usd: 1.25 },
    changed: ['context', 'rateLimits', 'cost'],
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    {
      const ui = await $.ui.mount({ plugin: 'session-hud', surface, ...IDLE })
      expect(await ui.find({ text: /Контекст/ })).toBeDefined()
      expect(await ui.find({ text: /52%/ })).toBeDefined()
      expect(await ui.find({ text: /104k из 200k/ })).toBeDefined()
      expect(await ui.find({ text: /5ч лимит/ })).toBeDefined()
      expect(await ui.find({ text: /82%/ })).toBeDefined()
      expect(await ui.find({ text: /\$1\.25/ })).toBeDefined()
      expect(await ui.find({ text: /Правки/ })).toBeDefined()
      expect(await ui.find({ text: /Агенты/ })).toBeDefined()
      await ui.unmount()
    }
  }
})

test('the hint line keeps the engine hint beside the mode label', async $ => {
  const ui = await $.ui.mount({ plugin: 'session-hud', surface: 'terminal', ...IDLE })
  expect(await ui.find({ text: /for shortcuts/ })).toBeDefined()
  await ui.unmount()
})

test('/hud folds the HUD to one line', async $ => {
  await $.command.run({ command: 'hud', args: '' } as Parameters<typeof $.command.run>[0])
  const ui = await $.ui.mount({ plugin: 'session-hud', surface: 'terminal', ...IDLE })
  expect(await ui.find({ text: /контекст/ })).toBeDefined()
  expect(await ui.find({ text: /Контекст/ })).toBeUndefined()
  await ui.unmount()
})

test('an Edit adds its changed lines to the edits counter', async ($, on) => {
  on('tool.call', () => ({ result: {} as never }))
  await $.tool.call({
    tool: 'Edit',
    file_path: 'C:/tmp/a.txt',
    old_string: 'one',
    new_string: 'two\nthree',
  } as Parameters<typeof $.tool.call>[0])
  const ui = await $.ui.mount({ plugin: 'session-hud', surface: 'terminal', ...IDLE })
  expect(await ui.find({ text: /\+2/ })).toBeDefined()
  expect(await ui.find({ text: /−1/ })).toBeDefined()
  expect(await ui.find({ text: /1 файл/ })).toBeDefined()
  await ui.unmount()
})

test('a context past 90% shows ticks and a warning on the bar', async ($, on) => {
  on('session.measure', (_, e) => ({ changed: e.changed }))
  await $.session.measure({
    context: { tokens: 184_000, window: 200_000, percent: 92 },
    rateLimits: [],
    changed: ['context'],
  })
  const ui = await $.ui.mount({ plugin: 'session-hud', surface: 'terminal', ...IDLE })
  expect(await ui.find({ text: /╋/ })).toBeDefined()
  expect(await ui.find({ text: /контекст почти полон/ })).toBeDefined()
  await ui.unmount()
})

test('a large context warns by tokens even in a big window', async ($, on) => {
  on('session.measure', (_, e) => ({ changed: e.changed }))
  await $.session.measure({
    context: { tokens: 260_000, window: 1_000_000, percent: 26 },
    rateLimits: [],
    changed: ['context'],
  })
  const ui = await $.ui.mount({ plugin: 'session-hud', surface: 'terminal', ...IDLE })
  expect(await ui.find({ text: /контекст большой/ })).toBeDefined()
  await ui.unmount()
})

test('a wide full HUD draws the pixel sprite, a narrow one leaves it out', async $ => {
  const wide = await $.ui.mount({ plugin: 'session-hud', surface: 'terminal', viewport: { columns: 160, rows: 40 }, ...IDLE })
  expect(await wide.find({ text: /[\u{1FB00}-\u{1FB3B}]/u })).toBeDefined()
  await wide.unmount()

  const narrow = await $.ui.mount({ plugin: 'session-hud', surface: 'terminal', viewport: { columns: 100, rows: 40 }, ...IDLE })
  expect(await narrow.find({ text: /[\u{1FB00}-\u{1FB3B}]/u })).toBeUndefined()
  await narrow.unmount()
})
