import { atom, read, update } from 'claude-code'
import type { Register, Timer } from 'claude-code'

import type { Alarm, ContextGauge, Escort, Limit, LogEntry, MemoryMap, UnitName, Units, Verdict } from '../types'
import { UNIT_LABEL, UNIT_NAMES, VERDICT_COLOR, VERDICT_TEXT, boardSvg, elapsed, escortsShown, logRowsFor, shortModel } from './board'
import { AMBER, GREEN, MOSS, RED, VOID, clip, drawWidthOf, layoutOf, paneHeightOf } from './palette'
import { critical, labelOf, memoryFrom, powerRows, powerSvg, resetIn } from './power'
import { vitalsRow, vitalsSvg } from './vitals'

const PANE = 'netdive-monitor'
const TITLE = 'NETDIVE QUOTA'
const idleUnit = { verdict: 'idle', count: 0, tool: '' } as const
const units = atom({ plugin: 'netdive-quota', key: 'units' } as const, {
  SCOUT: idleUnit,
  REWRITE: idleUnit,
  DIVE: idleUnit,
})
const log = atom({ plugin: 'netdive-quota', key: 'log' } as const, [])
const startedAt = atom({ plugin: 'netdive-quota', key: 'startedAt' } as const, 0)
const alarm = atom({ plugin: 'netdive-quota', key: 'alarm' } as const, null)
const bash = atom({ plugin: 'netdive-quota', key: 'bash' } as const, null)
const limits = atom({ plugin: 'netdive-quota', key: 'limits' } as const, [])
// コンテキストの使用量。内訳(memory)がまだ取れていないときの電脳容量マップに使う
const context = atom({ plugin: 'netdive-quota', key: 'context' } as const, null)
// タイマーの数え下ろしの起点。秒はSVGの中で進むので、ここは利用枠かコンテキストが動いたときと10分ごとにだけ書き換える。
// 書き換えるとタイマーのSVGが描き直されるため、頻度を上げるとチラつく
const anchor = atom({ plugin: 'netdive-quota', key: 'anchor' } as const, 0)
const REANCHOR_MS = 10 * 60_000
// 随伴機(サブエージェント)。古いものから捨て、直近8機まで持つ
const escorts = atom({ plugin: 'netdive-quota', key: 'escorts' } as const, [])
// セッションの累計コスト(USD)。コストの台帳がない環境ではnull
const cost = atom({ plugin: 'netdive-quota', key: 'cost' } as const, null)
const tokens = atom({ plugin: 'netdive-quota', key: 'tokens' } as const, {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  turns: 0,
})
// コンテキストの内訳。応答のたびにローカルの見積もり(summary)で取り直す
const memory = atom({ plugin: 'netdive-quota', key: 'memory' } as const, null)

// 読む・探すはSCOUT(索敵)、書くはREWRITE(改竄)、実行とそれ以外はDIVE(潜入)が受け持つ
const READERS = ['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'LSP', 'ToolSearch']
const WRITERS = ['Edit', 'Write', 'NotebookEdit']
const unitOf = (tool: string): UnitName =>
  READERS.includes(tool) ? 'SCOUT' : WRITERS.includes(tool) ? 'REWRITE' : 'DIVE'

const arg = (e: Readonly<Record<string, unknown>>, key: string): string => {
  const value = e[key]
  return typeof value === 'string' ? value : ''
}

const baseName = (path: string): string => path.split('/').pop() ?? path

const summarize = (e: Readonly<Record<string, unknown>>): string =>
  arg(e, 'command') || baseName(arg(e, 'file_path')) || arg(e, 'pattern') || arg(e, 'url')

const toLimits = (windows: readonly Limit[]): Limit[] =>
  windows.map(({ kind, percentUsed, resetsAt }) => ({ kind, percentUsed, resetsAt }))

const toContext = ({ tokens, window, percent }: ContextGauge): ContextGauge => ({ tokens, window, percent })

type Breakdown = {
  categories: readonly { name: string; tokens: number; kind: MemoryMap['slices'][number]['kind'] }[]
  totalTokens: number
  rawMaxTokens: number
  percentage: number
}

// 遅延読み込みのツール定義は窓に数えないので外す
const toMemory = (breakdown: Breakdown | undefined): MemoryMap | null =>
  breakdown === undefined
    ? null
    : {
        slices: breakdown.categories
          .filter(one => one.kind !== 'deferred')
          .map(({ name, tokens: count, kind }) => ({ name, tokens: count, kind })),
        used: breakdown.totalTokens,
        max: breakdown.rawMaxTokens,
        percentage: breakdown.percentage,
      }

const settle = (list: readonly Escort[], matches: (one: Escort) => boolean, verdict: Verdict): Escort[] =>
  list.map(one => (matches(one) && one.verdict === 'running' ? { ...one, verdict } : one))

export const register: Register = on => {
  let anchorTimer: Timer | undefined

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'netdive', description: '電脳監視パネルを開く' })
    const usage = await $.session.usage()
    if ((await read($, startedAt)) === 0) {
      await update($, startedAt, () => usage.startedAt)
    }
    await update($, limits, () => toLimits(usage.rateLimits))
    await update($, context, () => toContext(usage.context))
    await update($, cost, () => usage.cost?.usd ?? null)
    const measured = await $.session.usage({ breakdown: 'summary' })
    await update($, memory, () => toMemory(measured.context.breakdown))
    const at = await $.clock.now()
    await update($, anchor, () => at)
    anchorTimer?.cancel()
    anchorTimer = $.clock.every(REANCHOR_MS, () => {
      void $.clock.now().then(t => update($, anchor, () => t))
    })
    void $.ui.open({ id: PANE, title: TITLE })

    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    // どちらかが動けばタイマーのSVGは描き直しになるので、起点も今に合わせる
    const isLimitMoved = e.changed.includes('rateLimits')
    const isContextMoved = e.changed.includes('context')
    if (isLimitMoved || isContextMoved) {
      const at = await $.clock.now()
      if (isLimitMoved) await update($, limits, () => toLimits(e.rateLimits))
      if (isContextMoved) await update($, context, () => toContext(e.context))
      await update($, anchor, () => at)
    }
    if (e.changed.includes('cost')) {
      await update($, cost, () => e.cost?.usd ?? null)
    }
    // 内訳はローカルの見積もりで、トークン数の計算リクエストは送らない
    if (isContextMoved) {
      const measured = await $.session.usage({ breakdown: 'summary' })
      await update($, memory, () => toMemory(measured.context.breakdown))
    }

    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const spawned = await next(e)
    const id = spawned.agentId
    if (id !== undefined) {
      const escort: Escort = {
        id,
        toolUseId: e.tool_use_id,
        type: e.subagentType,
        description: e.description,
        model: spawned.model ?? e.model ?? e.parentModel,
        verdict: 'running',
        count: 0,
        isBackground: e.background,
      }
      await update($, escorts, list => [...list, escort].slice(-8))
    }

    return spawned
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    const usage = done.usage ?? e.usage
    if (usage !== undefined) {
      await update($, tokens, all => ({
        input: all.input + usage.input_tokens,
        output: all.output + usage.output_tokens,
        cacheRead: all.cacheRead + usage.cache_read_input_tokens,
        cacheWrite: all.cacheWrite + usage.cache_creation_input_tokens,
        turns: all.turns + 1,
      }))
    }
    // 随伴機のターンが終わったら、その機体の作業は終わり
    const agentId = e.agentId
    if (agentId !== undefined) {
      const verdict: Verdict = e.reason === 'answer' ? 'approved' : 'denied'
      await update($, escorts, list => settle(list, one => one.id === agentId, verdict))
    }

    return done
  })

  on('command.run', { command: 'netdive' }, async $ => {
    // 開き直したSVGは起点から数え始めるので、起点を今に合わせてから開く
    const at = await $.clock.now()
    await update($, anchor, () => at)
    await $.ui.open({ id: PANE, title: TITLE })

    return { text: '電脳監視パネルを開きました。' }
  })

  on('prompt.submit', async ($, e, next) => {
    await update($, alarm, () => null)

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const unit = unitOf(e.tool)
    const isBash = e.tool === 'Bash'
    const agentId = arg(e, 'agentId') || undefined
    const entry: LogEntry = {
      id: e.tool_use_id,
      at: await $.clock.now(),
      unit,
      tool: e.tool,
      summary: summarize(e),
      verdict: 'running',
      agentId,
    }
    if (agentId !== undefined) {
      await update($, escorts, list => list.map(one => (one.id === agentId ? { ...one, count: one.count + 1 } : one)))
    }
    await update($, units, all => ({
      ...all,
      [unit]: { verdict: 'running', count: all[unit].count + 1, tool: e.tool },
    }))
    await update($, log, list => [...list, entry].slice(-60))
    if (isBash) {
      await update($, bash, () => entry.summary || 'Bash')
    }

    let verdict: Verdict = 'denied'
    try {
      const ran = await next(e)
      const reason = ran.deny ?? (ran.isError ? 'エラーを返しました' : undefined)
      verdict = reason === undefined ? 'approved' : 'denied'
      if (reason !== undefined) {
        const raised: Alarm = { tool: e.tool, reason: clip(reason, 80) }
        await update($, alarm, () => raised)
      }

      return ran
    } finally {
      await update($, units, all => ({ ...all, [unit]: { ...all[unit], verdict } }))
      await update($, log, list => list.map(one => (one.id === entry.id ? { ...one, verdict } : one)))
      if (isBash) {
        await update($, bash, () => null)
      }
      // 前面で動く随伴機は、起動したAgentツールが返った時点で作業を終えている
      if (e.tool === 'Agent') {
        await update($, escorts, list =>
          settle(list, one => one.toolUseId === entry.id && !one.isBackground, verdict),
        )
      }
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const state = await read($, units)
    const list = await read($, log)
    const origin = await read($, startedAt)
    const windows = await read($, limits)
    const gauge = await read($, context)
    const at = (await read($, anchor)) || (await $.clock.now())
    const squad = await read($, escorts)
    const spent = await read($, cost)
    const tally = await read($, tokens)
    // 内訳がまだ取れていなければ、窓の使用量だけで電脳容量マップを描く
    const map = (await read($, memory)) ?? memoryFrom(gauge)
    const now = await $.clock.now()
    const isDiving = (Object.values(state) as Units[UnitName][]).some(one => one.verdict === 'running')
    const decision: Verdict = isDiving ? 'running' : (list.at(-1)?.verdict ?? 'idle')

    // Svgのないターミナルでは、利用枠と3班の状況と記録を燐光の緑の文字で並べる
    if (e.surface === 'terminal') {
      const shown = escortsShown(squad)
      const room = Math.max(4, (e.viewport?.rows ?? 40) - 15 - windows.length - shown.length)
      return (
        <Box flexDirection="column">
          {powerRows(windows, map, at).map(row => (
            <Text color={row.color} bold>
              {row.text}
            </Text>
          ))}
          <Text color={GREEN}>{vitalsRow(spent, tally, origin, now)}</Text>
          <Text color={GREEN} bold>
            ▌作業班トレース ── 状況 {VERDICT_TEXT[decision]}
          </Text>
          {UNIT_NAMES.map(name => (
            <Text color={VERDICT_COLOR[state[name].verdict]}>
              {`${name}・${UNIT_LABEL[name]} ${VERDICT_TEXT[state[name].verdict]} ${state[name].tool}`}
            </Text>
          ))}
          {shown.map(one => (
            <Text color={VERDICT_COLOR[one.verdict]} wrap="truncate-end">
              {`随伴機 ${one.type}「${one.description}」 ${VERDICT_TEXT[one.verdict]} ${shortModel(one.model)} ×${one.count}`}
            </Text>
          ))}
          <Text color={GREEN} bold>
            ▌電脳ログ
          </Text>
          {list.slice(-room).map(one => (
            <Text key={one.id} color={MOSS} wrap="truncate-end">
              {`${elapsed(origin, one.at)} ${one.unit.slice(0, 3)} ${VERDICT_TEXT[one.verdict]} ${one.tool} ${one.summary}`}
            </Text>
          ))}
        </Box>
      )
    }

    // 文字はすべてSVGの中で描く。秒の進みはSVGの中のSMILに任せる
    const { Svg } = $.ui.resolve(e)
    const drawWidth = drawWidthOf(e.props.bodyColumns)
    const layout = layoutOf(drawWidth)
    const power = powerSvg(windows, map, at, layout, drawWidth)
    const vitals = vitalsSvg(spent, tally, origin, now, layout, drawWidth)
    const rows = logRowsFor(layout, drawWidth, paneHeightOf(e.props.scroll.bodyRows), power.height + vitals.height, squad)
    const board = boardSvg(state, decision, list, squad, origin, layout, drawWidth, rows)
    return (
      <Box flexDirection="column" backgroundColor={VOID}>
        <Svg
          source={power.source}
          width={power.width}
          height={power.height}
          alt={`電脳負荷: ${powerRows(windows, map, at)
            .map(row => row.text)
            .join(' / ')}`}
          isInteractive
        />
        <Svg
          source={vitals.source}
          width={vitals.width}
          height={vitals.height}
          alt={`電脳バイタル: ${vitalsRow(spent, tally, origin, now)}`}
        />
        <Svg
          source={board.source}
          width={board.width}
          height={board.height}
          alt={`作業班トレース 状況: ${VERDICT_TEXT[decision]}、電脳ログ ${list.length}件`}
          isInteractive
        />
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) {
      return next(e)
    }
    const command = await read($, bash)
    const warning = await read($, alarm)
    const list = await read($, log)
    const nearLimit = critical(await read($, limits))
    if (command === null && warning === null && nearLimit === undefined && !e.props.isWorking) {
      return next(e)
    }

    const { Box, Button, Text } = $.ui.resolve(e)
    const width = Math.max(20, e.props.bodyColumns - 16)

    // 点滅はさせない。状態を周期的に書き換えると、そのたびにサイドパネルの枠まで作り直されて
    // パネル全体が一瞬消えるため、Bashの実行中は点灯にとどめる
    if (command !== null) {
      return (
        <Box flexDirection="row" backgroundColor={AMBER} paddingX={1} gap={1}>
          <Box flexShrink={0}>
            <Text color={VOID} bold wrap="truncate-end">
              ▲ 潜入中 DIVE
            </Text>
          </Box>
          <Text color={VOID} wrap="truncate-end">
            外部コマンド実行 {clip(command, width)}
          </Text>
        </Box>
      )
    }

    if (warning !== null) {
      return (
        <Box flexDirection="row" backgroundColor={RED} paddingX={1} gap={1}>
          <Box flexShrink={0}>
            <Text color={VOID} bold>
              ▲ 遮断 BLOCKED
            </Text>
          </Box>
          <Text color={VOID} wrap="truncate-end">
            {warning.tool}: {warning.reason}
          </Text>
          <Button key="ack" label="確認" onPress={() => update($, alarm, () => null)} />
        </Box>
      )
    }

    if (nearLimit !== undefined) {
      const left = Math.max(0, Math.round(100 - nearLimit.percentUsed))
      const renewal = resetIn(nearLimit, await $.clock.now())
      return (
        <Box flexDirection="row" backgroundColor={RED} paddingX={1} gap={1}>
          <Box flexShrink={0}>
            <Text color={VOID} bold wrap="truncate-end">
              ▲ {left === 0 ? '電脳停止' : '電脳限界接近'}
            </Text>
          </Box>
          <Text color={VOID} wrap="truncate-end">
            {labelOf(nearLimit.kind)} 残り{left}%{renewal ? ` ・ 再接続${renewal}` : ''}
          </Text>
        </Box>
      )
    }

    return (
      <Box flexDirection="row" backgroundColor={GREEN} paddingX={1} gap={1}>
        <Text color={VOID} bold>
          ◆ 電脳接続中 ONLINE
        </Text>
        <Text color={VOID}>接続 {list.length}件</Text>
      </Box>
    )
  })
}
