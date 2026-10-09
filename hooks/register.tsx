import { atom, read, update } from 'claude-code'
import type { Register, Timer } from 'claude-code'

import type { Alarm, ContextGauge, Escort, Limit, LogEntry, MemoryMap, TokenTally, UnitName, Units, Verdict } from '../types'
import { UNIT_LABEL, UNIT_NAMES, VERDICT_COLOR, VERDICT_TEXT, boardSvg, elapsed, escortsShown, logRowsFor, shortModel } from './board'
import { AMBER, GREEN, MOSS, RED, VOID, clip, drawWidthOf, layoutOf, paneHeightOf } from './palette'
import { NO_POWER, critical, labelOf, memoryFrom, powerRows, powerSvg, resetIn, shownOf } from './power'
import type { PowerShown } from './power'
import { NO_VITALS, vitalsRow, vitalsSvg } from './vitals'
import type { VitalsShown } from './vitals'

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

// ── SVGの作り直しの制御 ─────────────────────────────────────
// ホストは、SVGの文字列が1文字でも変わると読み込み直し、動きを頭から再生し直す(チラつく)。
// そこで、表示する内容が変わらない限り、前に作ったSVGをそのまま返す。
// 数え上げの起点には、そのとき表示していた数値を持っておく

// altも作ったときの文字で持つ。描くたびの時刻で作り直すと(経費のペースが毎回変わる)、SVGごと描き直しになる
type Drawn = { source: string; width: number; height: number; alt?: string }
type Built<S> = { key: string; drawn: Drawn; shown: S }

// 動きの分だけ文字列が長くなる。ホストの上限(131072文字)に近づいたら、動きをやめて作り直す
const SOURCE_LIMIT = 125_000

function rebuild<S>(
  cache: Map<string, Built<S>>,
  slot: string,
  key: string,
  shown: S,
  make: (previous: S | undefined, hasMotion: boolean) => Drawn,
): Drawn {
  const hit = cache.get(slot)
  if (hit?.key === key) return hit.drawn
  let drawn = make(hit?.shown, true)
  if (drawn.source.length > SOURCE_LIMIT) drawn = make(hit?.shown, false)
  cache.set(slot, { key, drawn, shown })
  return drawn
}

// 1回のモデル要求(turn.step)で使ったトークン。ターンの終わりに、足し済みの分を引くために覚えておく
type Spent = Pick<TokenTally, 'input' | 'output' | 'cacheRead' | 'cacheWrite'>
const STEPPED_LIMIT = 64

export const register: Register = on => {
  let anchorTimer: Timer | undefined
  const powers = new Map<string, Built<PowerShown>>()
  const vitalsMap = new Map<string, Built<VitalsShown>>()
  // 作業班トレースと電脳ログは、前に描いたときの最新のログidを覚える
  const boards = new Map<string, Built<string | undefined>>()
  const stepped = new Map<string, Spent>()

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

  // モデルへの要求(ステップ)が返るたびに、使ったトークンを累計へ足す。
  // ターンの終わりまで待たずに、交信量やキャッシュの数字が1回の要求ごとに増えていく。
  // ターンのあいだに足した分は、ターンの終わりに引くために覚えておく
  on('turn.step', async function* ($, e, next) {
    const done = yield* next(e)
    const usage = done.usage
    if (usage !== null) {
      const prior = stepped.get(e.turnId)
      stepped.set(e.turnId, {
        input: (prior?.input ?? 0) + usage.input_tokens,
        output: (prior?.output ?? 0) + usage.output_tokens,
        cacheRead: (prior?.cacheRead ?? 0) + usage.cache_read_input_tokens,
        cacheWrite: (prior?.cacheWrite ?? 0) + usage.cache_creation_input_tokens,
      })
      // ターンの終わりが来ないまま残った分が溜まり続けないよう、古いものから捨てる
      if (stepped.size > STEPPED_LIMIT) stepped.delete(stepped.keys().next().value!)
      await update($, tokens, all => ({
        ...all,
        input: all.input + usage.input_tokens,
        output: all.output + usage.output_tokens,
        cacheRead: all.cacheRead + usage.cache_read_input_tokens,
        cacheWrite: all.cacheWrite + usage.cache_creation_input_tokens,
      }))
    }

    return done
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    const usage = done.usage ?? e.usage
    // ターンの使用量から、ステップごとに足し済みの分を引いた残りだけを足す。合計はターン単位で足していたときと同じになる
    const counted = stepped.get(e.turnId)
    stepped.delete(e.turnId)
    if (usage !== undefined) {
      const rest = (total: number, part = 0) => Math.max(0, total - part)
      await update($, tokens, all => ({
        input: all.input + rest(usage.input_tokens, counted?.input),
        output: all.output + rest(usage.output_tokens, counted?.output),
        cacheRead: all.cacheRead + rest(usage.cache_read_input_tokens, counted?.cacheRead),
        cacheWrite: all.cacheWrite + rest(usage.cache_creation_input_tokens, counted?.cacheWrite),
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
    // 開き直したSVGは起点から数え始めるので、起点を今に合わせてから開く。
    // 経過時間の時計やペースも作った時点の時刻を起点にしているため、描いたSVGを捨てて作り直し、最初から数え上げる
    const at = await $.clock.now()
    await update($, anchor, () => at)
    powers.clear()
    vitalsMap.clear()
    boards.clear()
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
    // 各SVGは、表示する内容(nowを除く入力)が前と同じなら、前に作った文字列をそのまま返す。
    // 内容が変わったときだけ作り直し、数字は前に表示した値から数え上げる
    const newest = list.at(-1)?.id
    const power = rebuild(
      powers,
      `${e.surface}:power`,
      JSON.stringify({ windows, map, at, layout, drawWidth }),
      shownOf(windows, map),
      (previous, hasMotion) =>
        powerSvg(windows, map, at, layout, drawWidth, hasMotion ? { from: previous ?? NO_POWER, isBoot: previous === undefined } : undefined),
    )
    const vitals = rebuild(
      vitalsMap,
      `${e.surface}:vitals`,
      JSON.stringify({ spent, tally, origin, layout, drawWidth }),
      { cost: spent, tokens: tally },
      (previous, hasMotion) => ({
        ...vitalsSvg(spent, tally, origin, now, layout, drawWidth, hasMotion ? { from: previous ?? NO_VITALS, isBoot: previous === undefined } : undefined),
        alt: vitalsRow(spent, tally, origin, now),
      }),
    )
    const rows = logRowsFor(layout, drawWidth, paneHeightOf(e.props.scroll.bodyRows), power.height + vitals.height, squad)
    const board = rebuild(
      boards,
      `${e.surface}:board`,
      JSON.stringify({ state, decision, list, squad, origin, layout, drawWidth, rows }),
      newest,
      // 最新のログが前に描いたときと同じ(判定だけが変わった)なら、打ち込み直さない
      (previous, hasMotion) =>
        boardSvg(state, decision, list, squad, origin, layout, drawWidth, rows, hasMotion ? { now, freshId: newest !== previous ? newest : undefined } : undefined),
    )
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
          alt={`電脳バイタル: ${vitals.alt}`}
          isInteractive
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
