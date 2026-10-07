import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderNode, SessionContextUsage, SessionCost, SessionRateLimit } from 'claude-code'

import type { HudAgent, HudEdits, HudInfo, HudLimit, HudSample, HudUsage } from '../types'

const EMPTY_INFO: HudInfo = {
  model: null,
  effort: null,
  branch: null,
  startedAt: null,
  turns: 0,
  tools: 0,
  lastTurnMs: null,
  turnStartedAt: null,
}

const EMPTY_EDITS: HudEdits = { added: 0, removed: 0, files: [] }

const usageAtom = atom({ plugin: 'session-hud', key: 'usage' } as const, null)
const infoAtom = atom({ plugin: 'session-hud', key: 'info' } as const, EMPTY_INFO)
const nowAtom = atom({ plugin: 'session-hud', key: 'now' } as const, 0)
const editsAtom = atom({ plugin: 'session-hud', key: 'edits' } as const, EMPTY_EDITS)
const agentsAtom = atom({ plugin: 'session-hud', key: 'agents' } as const, [])
const toolCountsAtom = atom({ plugin: 'session-hud', key: 'toolCounts' } as const, {})
const skillCountsAtom = atom({ plugin: 'session-hud', key: 'skillCounts' } as const, {})
const samplesAtom = atom({ plugin: 'session-hud', key: 'samples' } as const, {})
const warnedAtom = atom({ plugin: 'session-hud', key: 'warned' } as const, [])
const modeAtom = atom({ plugin: 'session-hud', key: 'modeLabel' } as const, null)
const compactAtom = atom({ plugin: 'session-hud', key: 'isCompact' } as const, false)

const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max']

const LIMIT_LABELS: Record<string, string> = {
  five_hour: '5ч лимит',
  seven_day: '7д лимит',
  seven_day_opus: '7д Opus',
  seven_day_sonnet: '7д Sonnet',
  spend_limit: 'Расходы',
}

const SHORT_LIMIT_LABELS: Record<string, string> = {
  five_hour: '5ч',
  seven_day: '7д',
  seven_day_opus: '7д·O',
  seven_day_sonnet: '7д·S',
  spend_limit: '$',
}

// How far back a limit's pace is read, and the least history a forecast needs:
// a week's window is judged over hours, so one busy stretch does not alarm it.
const PACE_WINDOWS: Record<string, { windowMs: number; minSpanMs: number }> = {
  five_hour: { windowMs: 90 * 60_000, minSpanMs: 20 * 60_000 },
}
const WEEK_PACE = { windowMs: 12 * 3600_000, minSpanMs: 2 * 3600_000 }
const paceFor = (kind: string) => PACE_WINDOWS[kind] ?? WEEK_PACE

const ORANGE = 'claude'
const SPINNER = ['◐', '◓', '◑', '◒']
const LABEL_WIDTH = 13
const SIDE_WIDTH = 38
const TOP_TOOLS = 5
const TOP_SKILLS = 4

// The engine's footer label for each mode (`⏵⏵ auto mode on`): the HUD sits
// beside it and is sized to the rest of the row.
const MODE_GLYPHS: Record<string, string> = {
  'manual mode on': '⏸',
  'accept edits on': '⏵⏵',
  'plan mode on': '⏸',
  'auto mode on': '⏵⏵',
  'bypass permissions on': '⏵⏵',
  "don't ask on": '⏵⏵',
}

// On a mode change the engine hands the hint once with the label of the mode it
// is leaving still in it; the new mode is the next one in shift+tab's cycle.
const MODE_LABEL = /(manual mode|accept edits|plan mode|auto mode|bypass permissions|don'?t ask) on/i

const NEXT_LABEL: Record<string, string> = {
  'manual mode on': 'accept edits on',
  'accept edits on': 'plan mode on',
  'auto mode on': 'manual mode on',
  'bypass permissions on': 'manual mode on',
  "don't ask on": 'manual mode on',
}

// The permission modes the classic hook events report, by the engine's label.
const PERMISSION_LABELS: Record<string, string> = {
  default: 'manual mode on',
  acceptEdits: 'accept edits on',
  plan: 'plan mode on',
  auto: 'auto mode on',
  bypassPermissions: 'bypass permissions on',
  dontAsk: "don't ask on",
}

// Terminal cells the label takes, with the gap after it: the media glyphs draw
// two cells wide, and the pause glyph's label one cell more.
const labelCells = (label: string) => {
  const glyph = MODE_GLYPHS[label] ?? '⏵⏵'
  const glyphCells = [...glyph].length * 2
  return glyphCells + 1 + label.length + (glyph === '⏸' ? 2 : 1)
}
const DEFAULT_LABEL = 'auto mode on'

// The current mode's label as the renders and classic events tell it.
let modeLabel: string | null = null
// Leaving plan mode goes to auto or manual: the next hint tells which.
let isLeavingPlan = false

const toUsage = (context: SessionContextUsage, rateLimits: SessionRateLimit[], cost?: SessionCost): HudUsage => ({
  tokens: context.tokens ?? null,
  window: context.window,
  percent: context.percent ?? null,
  limits: rateLimits.map((limit): HudLimit => ({
    kind: limit.kind,
    percentUsed: limit.percentUsed,
    resetsAt: limit.resetsAt,
  })),
  usd: cost?.usd ?? null,
})

const prettyModel = (model: string) => {
  const isLong = /\[1m\]/i.test(model)
  const base = model.replace(/\[1m\]/i, '').trim()
  const match = /^claude-(opus|sonnet|haiku|fable)-(\d+)-(\d+)/i.exec(base)
  const [, family = '', major = '', minor = ''] = match ?? []
  const name = match ? `${family.charAt(0).toUpperCase()}${family.slice(1)} ${major}.${minor}` : base
  return isLong ? `${name} · 1M` : name
}

const prettyTool = (tool: string) => (tool.startsWith('mcp__') ? (tool.split('__').pop() ?? tool) : tool)

const plural = (n: number, forms: [string, string, string]) => {
  const tens = n % 100
  const ones = n % 10
  if (tens >= 11 && tens <= 14) return forms[2]
  if (ones === 1) return forms[0]
  if (ones >= 2 && ones <= 4) return forms[1]
  return forms[2]
}

const formatTokens = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`

const formatDuration = (ms: number) => {
  const total = Math.max(0, Math.floor(ms / 1000))
  const d = Math.floor(total / 86400)
  const h = Math.floor((total % 86400) / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (d > 0) return `${d}д ${h}ч`
  if (h > 0) return `${h}ч ${String(m).padStart(2, '0')}м`
  if (m > 0) return `${m}м ${String(s).padStart(2, '0')}с`
  return `${s}с`
}

// Green → yellow → red, by where a cell sits along the bar.
const gradient = (t: number) => {
  const stops: [number, number, number][] = [
    [74, 222, 128],
    [250, 204, 21],
    [248, 113, 113],
  ]
  const x = Math.min(1, Math.max(0, t)) * (stops.length - 1)
  const i = Math.min(stops.length - 2, Math.floor(x))
  const f = x - i
  const from = stops[i] ?? stops[0]!
  const to = stops[i + 1] ?? from
  const mix = from.map((c, k) => Math.round(c + ((to[k] ?? c) - c) * f))
  return `#${mix.map(c => c.toString(16).padStart(2, '0')).join('')}`
}

const levelColor = (percent: number) => (percent >= 85 ? 'error' : percent >= 60 ? 'warning' : 'success')

const countLines = (text: string) => (text === '' ? 0 : text.split('\n').length)

// Lines changed between two texts, after trimming the lines they share at both ends.
const diffLines = (before: string, after: string) => {
  const a = before.split('\n')
  const b = after.split('\n')
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }
  return { added: endB - start, removed: endA - start }
}

type LineDelta = { added: number; removed: number }

const editStats = (tool: string, input: Record<string, unknown>): LineDelta | null => {
  const str = (v: unknown) => (typeof v === 'string' ? v : '')
  if (tool === 'Edit') return diffLines(str(input.old_string), str(input.new_string))
  if (tool === 'Write') return { added: countLines(str(input.content)), removed: 0 }
  if (tool === 'MultiEdit' && Array.isArray(input.edits)) {
    return (input.edits as Record<string, unknown>[]).reduce(
      (sum: LineDelta, edit) => {
        const d = diffLines(str(edit.old_string), str(edit.new_string))
        return { added: sum.added + d.added, removed: sum.removed + d.removed }
      },
      { added: 0, removed: 0 },
    )
  }
  return null
}

// Time until a limit reaches 100% at its recent pace, or null without a pace.
const forecastMs = (kind: string, samples: HudSample[] | undefined) => {
  if (!samples || samples.length < 2) return null
  const first = samples[0]!
  const last = samples[samples.length - 1]!
  const span = last.t - first.t
  const rise = last.p - first.p
  if (span < paceFor(kind).minSpanMs || rise <= 0) return null
  return ((100 - last.p) / rise) * span
}

const refresh = async ($: EngineInterface) => {
  const usage = await $.session.usage()
  const model = await $.session.model()
  await update($, usageAtom, () => toUsage(usage.context, usage.rateLimits, usage.cost))
  await update($, infoAtom, info => ({ ...info, model, startedAt: usage.startedAt }))
  await update($, nowAtom, () => Date.now())
}

const refreshBranch = async ($: EngineInterface) => {
  try {
    const result = await $.process.run(['git', 'branch', '--show-current'], { cwd: await $.session.cwd() })
    const branch = result.exitCode === 0 ? result.stdout.trim() || null : null
    await update($, infoAtom, info => (info.branch === branch ? info : { ...info, branch }))
  } catch {
    // Not a git repository, or git is missing: no branch shown.
  }
}

// Agents seen running at the last poll: background ones outlive the main turn.
let runningAgents = 0

// The model the main loop last sent a request with, by id (`claude-opus-5-5`).
let modelId: string | null = null
// The effort the settings last held for that model: `/effort` writes it at once,
// before any request carries it.
let settingsEffort: string | null = null

const refreshEffort = async ($: EngineInterface) => {
  try {
    const settings = (await $.settings.read()) as {
      effortLevel?: unknown
      modelSettings?: Record<string, { effortLevel?: unknown }>
    }
    const perModel = settings.modelSettings ?? {}
    const entry = modelId ? perModel[modelId] : Object.values(perModel).length === 1 ? Object.values(perModel)[0] : undefined
    const level = entry?.effortLevel ?? settings.effortLevel
    const effort = typeof level === 'string' ? level : null
    if (effort === null || effort === settingsEffort) return
    settingsEffort = effort
    await update($, infoAtom, info => (info.effort === effort ? info : { ...info, effort }))
  } catch {
    // Settings unreadable: the next request's effort still shows.
  }
}

const refreshAgents = async ($: EngineInterface) => {
  try {
    const running: HudAgent[] = (await $.agent.list())
      .filter(agent => agent.status === 'running' || agent.status === 'pending')
      .map(agent => ({ id: agent.id, type: agent.type, description: agent.description }))
    runningAgents = running.length
    await update($, agentsAtom, list =>
      list.length === running.length && list.every((a, i) => a.id === running[i]?.id) ? list : running,
    )
  } catch {
    // Agent roster unavailable: keep the last list.
  }
}

export const register: Register = on => {
  let isWorking = false
  let lastTick = 0
  let lastAgentPoll = 0
  let lastEffortPoll = 0

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await $.command.register({ name: 'hud', description: 'Toggle the session HUD between full and compact' })
    await refresh($).catch(() => undefined)
    void refreshBranch($)

    $.clock.every(1000, () => {
      const now = Date.now()
      // Tick every second while a turn runs, every 15s while idle.
      if (isWorking || runningAgents > 0 || now - lastTick >= 15_000) {
        lastTick = now
        void update($, nowAtom, () => now)
      }
      // Drawing is pure: the timer keeps the mode in state for the next reload.
      const label = modeLabel
      if (label !== null) void update($, modeAtom, m => (m === label ? m : label))
      if (now - lastEffortPoll >= 2000) {
        lastEffortPoll = now
        void refreshEffort($)
      }
      if ((isWorking || runningAgents > 0) && now - lastAgentPoll >= 2000) {
        lastAgentPoll = now
        void refreshAgents($)
      }
    })

    return result
  })

  on('command.run', { command: 'hud' }, async $ => {
    const isCompact = await update($, compactAtom, v => !v)
    return { text: isCompact ? 'HUD: compact' : 'HUD: full' }
  })

  on('classic.UserPromptSubmit', ($, e, next) => {
    const label = e.permission_mode ? PERMISSION_LABELS[e.permission_mode] : undefined
    if (label && label !== modeLabel) {
      modeLabel = label
      isLeavingPlan = false
      $.ui.invalidate('ui.render')
    }
    return next(e)
  })

  on('classic.PostToolUse', ($, e, next) => {
    const label = e.permission_mode ? PERMISSION_LABELS[e.permission_mode] : undefined
    if (label && label !== modeLabel) {
      modeLabel = label
      isLeavingPlan = false
      $.ui.invalidate('ui.render')
    }
    return next(e)
  })

  on('classic.Stop', ($, e, next) => {
    const label = e.permission_mode ? PERMISSION_LABELS[e.permission_mode] : undefined
    if (label && label !== modeLabel) {
      modeLabel = label
      isLeavingPlan = false
      $.ui.invalidate('ui.render')
    }
    return next(e)
  })

  // Every skill the model reads: typed as /name, called through the Skill tool, or preloaded.
  on('skill.prompt', async ($, e, next) => {
    await update($, skillCountsAtom, counts => ({ ...counts, [e.skill]: (counts[e.skill] ?? 0) + 1 }))
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    const now = Date.now()
    await update($, usageAtom, () => toUsage(e.context, e.rateLimits, e.cost))

    await update($, samplesAtom, all => {
      const out: Record<string, HudSample[]> = {}
      for (const limit of e.rateLimits) {
        const prev = (all[limit.kind] ?? []).filter(s => s.t >= now - paceFor(limit.kind).windowMs)
        const last = prev[prev.length - 1]
        // A drop means the window reset: the old pace no longer applies.
        const kept = last && limit.percentUsed < last.p ? [] : prev
        out[limit.kind] = [...kept, { t: now, p: limit.percentUsed }]
      }
      return out
    })

    const readings: { key: string; label: string; percent: number | undefined }[] = [
      { key: 'context', label: 'Контекст', percent: e.context.percent },
      ...e.rateLimits.map(l => ({ key: `limit:${l.kind}`, label: LIMIT_LABELS[l.kind] ?? l.kind, percent: l.percentUsed })),
    ]
    const warned = await read($, warnedAtom)
    const nextWarned = new Set(warned)
    for (const r of readings) {
      if (r.percent === undefined) continue
      if (r.percent >= 90 && !nextWarned.has(r.key)) {
        nextWarned.add(r.key)
        $.ui.toast(`▲ ${r.label}: ${Math.round(r.percent)}%`)
      } else if (r.percent < 80) {
        nextWarned.delete(r.key)
      }
    }
    if (nextWarned.size !== warned.length || [...nextWarned].some(k => !warned.includes(k))) {
      await update($, warnedAtom, () => [...nextWarned])
    }

    return next(e)
  })

  // A subagent's turns raise turn.start too, without saying whose: the main
  // turn is timed from the prompt that starts it.
  on('prompt.submit', async ($, e, next) => {
    isWorking = true
    const now = Date.now()
    await update($, infoAtom, info => ({ ...info, turnStartedAt: now }))
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    if (!(e as { agentId?: string }).agentId) {
      modelId = e.model.replace(/\[1m\]$/i, '')
      const effort = e.effort === undefined ? null : String(e.effort)
      await update($, infoAtom, info => (info.effort === effort ? info : { ...info, effort }))
    }
    return yield* next(e)
  })

  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    if (!(e as { agentId?: string }).agentId) {
      await update($, infoAtom, info => ({ ...info, tools: info.tools + 1 }))
      const name = prettyTool(tool)
      await update($, toolCountsAtom, counts => ({ ...counts, [name]: (counts[name] ?? 0) + 1 }))
    }

    const result = await next(e)

    // The tool's arguments sit beside `tool` on the event itself (`e.file_path`).
    const input = e as unknown as Record<string, unknown>
    const stats = editStats(tool, input)
    const isOk = !('deny' in result && result.deny) && !result.isError
    if (stats && isOk) {
      const file = typeof input.file_path === 'string' ? input.file_path : null
      await update($, editsAtom, edits => ({
        added: edits.added + stats.added,
        removed: edits.removed + stats.removed,
        files: file && !edits.files.includes(file) ? [...edits.files, file] : edits.files,
      }))
    }
    if (tool === 'Agent' || tool === 'Task') void refreshAgents($)

    return result
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId) {
      void refreshAgents($)
      return next(e)
    }
    isWorking = false
    const now = Date.now()
    await update($, infoAtom, info => ({
      ...info,
      turns: info.turns + 1,
      lastTurnMs: info.turnStartedAt === null ? info.lastTurnMs : now - info.turnStartedAt,
      turnStartedAt: null,
    }))
    void refresh($).catch(() => undefined)
    void refreshBranch($)
    void refreshAgents($)
    return next(e)
  })

  // Drawn as the hint line under the prompt: the engine keeps its own mode label
  // at the left of that row, the hint goes on beside it and the frame sits below,
  // stretched by the layout itself so a mode change never waits on this hook.
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    if (e.surface !== 'terminal' && e.surface !== 'desktop') return next(e)

    const { Box, Text } = $.ui.resolve(e)
    const usage = await read($, usageAtom)
    const info = await read($, infoAtom)
    const edits = await read($, editsAtom)
    const agents = await read($, agentsAtom)
    const toolCounts = await read($, toolCountsAtom)
    const skillCounts = await read($, skillCountsAtom)
    const samples = await read($, samplesAtom)
    const isCompact = await read($, compactAtom)
    const now = (await read($, nowAtom)) || Date.now()

    const hint = e.props.hint
    const leaving = MODE_LABEL.exec(hint)?.[0].toLowerCase().replace('dont', "don't") ?? null
    if (leaving !== null) {
      isLeavingPlan = leaving === 'plan mode on'
      modeLabel = NEXT_LABEL[leaving] ?? modeLabel
    } else if (isLeavingPlan) {
      isLeavingPlan = false
      modeLabel = /shift\+tab/i.test(hint) ? 'auto mode on' : 'manual mode on'
    }

    // The hint line goes on beside the engine's mode label; the frame below it
    // reaches back under the label, so it spans the whole footer.
    const labelWidth = labelCells(modeLabel ?? (await read($, modeAtom)) ?? DEFAULT_LABEL)
    const width = Math.max(40, (e.viewport?.columns ?? 80) - 4)
    const inner = width - 4
    const isWide = inner >= 100
    const leftWidth = isWide ? inner - SIDE_WIDTH - 2 : inner

    const bar = (key: string, percent: number | null, barWidth: number) => {
      const p = Math.min(100, Math.max(0, percent ?? 0))
      const filled = Math.round((p / 100) * barWidth)
      const cells = []
      for (let i = 0; i < filled; i++) {
        cells.push(
          <Text key={`${key}-${i}`} color={gradient(i / Math.max(1, barWidth - 1))}>
            ━
          </Text>,
        )
      }
      return (
        <Text>
          {cells}
          <Text dimColor>{'─'.repeat(barWidth - filled)}</Text>
        </Text>
      )
    }

    const spinner = SPINNER[Math.floor(now / 1000) % SPINNER.length]
    const modelText = (
      <Text color={ORANGE} bold>
        {e.props.isWorking ? spinner : '◆'} {info.model ? prettyModel(info.model) : '…'}
      </Text>
    )

    const effortIndex = info.effort ? EFFORT_LEVELS.indexOf(info.effort) : -1
    const effortText =
      info.effort === null ? null : (
        <Text>
          {' '}
          {effortIndex >= 0 && (
            <Text>
              <Text color={gradient(effortIndex / (EFFORT_LEVELS.length - 1))}>{'●'.repeat(effortIndex + 1)}</Text>
              <Text dimColor>{'○'.repeat(EFFORT_LEVELS.length - effortIndex - 1)}</Text>
            </Text>
          )}
          <Text color="subtle"> {info.effort}</Text>
        </Text>
      )

    const sep = <Text color={ORANGE} dimColor>{' │ '}</Text>
    const label = (text: string) => <Text color={ORANGE}>{text.padEnd(LABEL_WIDTH)}</Text>
    const ctxPercent = usage?.percent ?? null
    const limits = usage?.limits ?? []

    const frame = (...children: RenderNode[]) => (
      <Box flexDirection="column" width={width - labelWidth}>
        <Text dimColor wrap="truncate-end">
          {hint.replace(MODE_LABEL, '').replace(/^[\s·]+/, '· ')}
        </Text>
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor={ORANGE}
          paddingX={1}
          marginLeft={-labelWidth}
          width={width}
        >
          {children}
        </Box>
      </Box>
    )

    if (isCompact) {
      return frame(
        <Text wrap="truncate-end">
          {modelText}
          {effortText}
          {sep}
          <Text color="subtle">контекст </Text>
          {bar('ctx', ctxPercent, 12)}
          <Text bold color={ctxPercent === null ? 'subtle' : levelColor(ctxPercent)}>
            {ctxPercent === null ? ' —' : ` ${ctxPercent}%`}
          </Text>
          {limits.map(limit => (
            <Text key={`c-${limit.kind}`}>
              {sep}
              <Text color="subtle">{SHORT_LIMIT_LABELS[limit.kind] ?? limit.kind} </Text>
              <Text bold color={levelColor(limit.percentUsed)}>
                {Math.round(limit.percentUsed)}%
              </Text>
            </Text>
          ))}
          {usage?.usd != null && (
            <Text>
              {sep}
              <Text color="success">≈${usage.usd.toFixed(2)}</Text>
            </Text>
          )}
          <Text dimColor>{'  '}/hud</Text>
        </Text>,
      )
    }

    // Header: who answers, for how long, at what (notional) price.
    const headerRow = (
      <Box flexDirection="row" justifyContent="space-between">
        <Text wrap="truncate-end">
          {modelText}
          {effortText}
          {sep}
          <Text color="subtle">сессия </Text>
          <Text bold>{info.startedAt ? formatDuration(now - info.startedAt) : '—'}</Text>
          {sep}
          {info.turnStartedAt !== null ? (
            <Text>
              <Text color="subtle">текущий ход </Text>
              <Text color="warning" bold>
                {formatDuration(now - info.turnStartedAt)}
              </Text>
            </Text>
          ) : (
            <Text>
              <Text color="subtle">прошлый ход </Text>
              <Text>{info.lastTurnMs !== null ? formatDuration(info.lastTurnMs) : '—'}</Text>
            </Text>
          )}
          {usage?.usd != null && (
            <Text>
              {sep}
              <Text color="success" bold>
                ≈${usage.usd.toFixed(2)}
              </Text>
              <Text dimColor> по ценам API</Text>
            </Text>
          )}
          {sep}
          <Text bold>{info.turns}</Text>
          <Text color="subtle"> {plural(info.turns, ['ответ', 'ответа', 'ответов'])}</Text>
        </Text>
        <Text>
          {info.branch && <Text color="suggestion">⎇ {info.branch}  </Text>}
          <Text color={ORANGE} dimColor>
            /hud
          </Text>
        </Text>
      </Box>
    )

    // Left column: context and rate-limit bars with their forecasts. The text
    // after the bars is measured, so the side column can sit right after it.
    const percentText = (p: number) => ` ${String(Math.round(p)).padStart(3)}%`
    const ctxTokens = `  ${usage?.tokens != null ? formatTokens(usage.tokens) : '—'} из ${usage ? formatTokens(usage.window) : '—'}`
    const ctxWarning = ctxPercent !== null && ctxPercent >= 80 ? ' ▲ пора /compact' : ''
    const limitTexts = limits.map(limit => {
      const resetsIn = limit.resetsAt ? Date.parse(limit.resetsAt) - now : NaN
      const eta = forecastMs(limit.kind, samples[limit.kind])
      const isShort = eta !== null && Number.isFinite(resetsIn) && eta < resetsIn
      return {
        limit,
        reset: Number.isFinite(resetsIn) ? `  сброс ${formatDuration(resetsIn)}` : '',
        forecast: isShort ? ` · ▲ кончится ~${formatDuration(eta)}` : eta !== null ? ' · ✓ темп ок' : '',
        isShort,
      }
    })
    const suffixWidth =
      Math.max(5 + ctxTokens.length + ctxWarning.length, ...limitTexts.map(t => 5 + t.reset.length + t.forecast.length)) + 1
    const barWidth = Math.max(10, Math.min(40, leftWidth - LABEL_WIDTH - suffixWidth))

    const contextRow = (
      <Text key="ctx" wrap="truncate-end">
        {label('Контекст')}
        {bar('ctx', ctxPercent, barWidth)}
        <Text bold color={ctxPercent === null ? 'subtle' : levelColor(ctxPercent)}>
          {ctxPercent === null ? '    —' : percentText(ctxPercent)}
        </Text>
        <Text dimColor>{ctxTokens}</Text>
        {ctxWarning && <Text color="error">{ctxWarning}</Text>}
      </Text>
    )

    const limitRows = limitTexts.map(({ limit, reset, forecast, isShort }) => (
      <Text key={`limit-${limit.kind}`} wrap="truncate-end">
        {label(LIMIT_LABELS[limit.kind] ?? limit.kind)}
        {bar(`lim-${limit.kind}`, limit.percentUsed, barWidth)}
        <Text bold color={levelColor(limit.percentUsed)}>
          {percentText(limit.percentUsed)}
        </Text>
        {reset && <Text dimColor>{reset}</Text>}
        {forecast && <Text color={isShort ? 'error' : 'success'}>{forecast}</Text>}
      </Text>
    ))

    // Right column: what this session changed and who is working on it.
    const shownAgents = agents.slice(0, 2)
    const sideRows = [
      <Text key="edits" wrap="truncate-end">
        <Text color={ORANGE}>✎ Правки   </Text>
        <Text color="diffAdded" bold>
          +{edits.added}
        </Text>
        <Text> </Text>
        <Text color="diffRemoved" bold>
          −{edits.removed}
        </Text>
        <Text dimColor>
          {' '}
          · {edits.files.length} {plural(edits.files.length, ['файл', 'файла', 'файлов'])}
        </Text>
      </Text>,
      <Text key="agents" wrap="truncate-end">
        <Text color={ORANGE}>◈ Агенты   </Text>
        {agents.length === 0 ? (
          <Text dimColor>не запущены</Text>
        ) : (
          <Text color="suggestion" bold>
            {agents.length} {plural(agents.length, ['работает', 'работают', 'работают'])}
          </Text>
        )}
      </Text>,
      ...shownAgents.map(agent => (
        <Text key={`agent-${agent.id}`} wrap="truncate-end">
          <Text dimColor>{'  '}└ </Text>
          <Text color="suggestion">{agent.type}</Text>
          <Text dimColor> · {agent.description}</Text>
        </Text>
      )),
      ...(agents.length > shownAgents.length
        ? [
            <Text key="agents-more" dimColor>
              {'  '}└ ещё {agents.length - shownAgents.length}
            </Text>,
          ]
        : []),
    ]

    // Bottom, full width: which tools and skills the session leaned on.
    const countsRow = (
      key: string,
      title: string,
      counts: Record<string, number>,
      top: number,
      forms: [string, string, string],
    ) => {
      const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1])
      const shown = sorted.slice(0, top)
      const total = sorted.reduce((n, [, c]) => n + c, 0)
      const rest = total - shown.reduce((n, [, c]) => n + c, 0)
      return (
        <Text key={key} wrap="truncate-end">
          {label(title)}
          <Text bold>{total}</Text>
          <Text color="subtle"> {plural(total, forms)}</Text>
          {shown.length > 0 && <Text dimColor>: </Text>}
          {shown.map(([name, count], i) => (
            <Text key={`${key}-${name}`}>
              {i > 0 && <Text dimColor> · </Text>}
              <Text>{name}</Text>
              <Text color={ORANGE}> {count}</Text>
            </Text>
          ))}
          {rest > 0 && <Text dimColor> · прочие {rest}</Text>}
        </Text>
      )
    }
    const toolsRow = countsRow('tools', 'Инструменты', toolCounts, TOP_TOOLS, ['вызов', 'вызова', 'вызовов'])
    const skillsRow = countsRow('skills', 'Скиллы', skillCounts, TOP_SKILLS, ['вызов', 'вызова', 'вызовов'])

    // The bars' column is as wide as its rows need, the side column right after it.
    const left = [contextRow, ...limitRows]
    const barsWidth = Math.min(leftWidth, LABEL_WIDTH + barWidth + suffixWidth)
    const body = isWide ? (
      <Box flexDirection="column">
        <Box flexDirection="row">
          <Box flexDirection="column" width={barsWidth}>
            {left}
          </Box>
          <Box flexDirection="column" width={SIDE_WIDTH} marginLeft={3}>
            {sideRows}
          </Box>
        </Box>
        {toolsRow}
        {skillsRow}
      </Box>
    ) : (
      <Box flexDirection="column">
        {left}
        {sideRows}
        {toolsRow}
        {skillsRow}
      </Box>
    )

    return frame(headerRow, body)
  })
}
