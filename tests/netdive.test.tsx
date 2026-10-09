import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { rollText } from '../hooks/motion'
import { full, percent } from '../hooks/power'
import { usd } from '../hooks/vitals'

const PANE_PROPS = {
  title: 'NETDIVE QUOTA',
  isFocused: false,
  bodyColumns: 48,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 30 },
  view: {},
} as const

const BAND_PROPS = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 3,
  bodyColumns: 80,
  scroll: { offset: 0, bodyRows: 3 },
  view: {},
} as const

const PANE = { plugin: 'netdive-quota', component: 'Pane', requestId: 'netdive-monitor' } as const

test('Bash実行中は潜入中の帯が出て、終わると消える', async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  // 警告がないとき帯はエンジン既定の描画に譲るので、その代役を置く
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  let finish = () => {}
  on('tool.call', () => new Promise(resolve => (finish = () => resolve({ result: 'ok' }))))

  const running = $.tool.call({ tool: 'Bash', command: 'npm test' })
  await clock.settle()

  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({ plugin: 'netdive-quota', surface, component: 'AbovePrompt', props: BAND_PROPS })
    expect(await band.find({ text: /潜入中 DIVE/ })).toBeDefined()
    expect(await band.find({ text: /npm test/ })).toBeDefined()
    await band.unmount()
  }

  finish()
  await running
  const band = await $.ui.mount({ plugin: 'netdive-quota', surface: 'desktop', component: 'AbovePrompt', props: BAND_PROPS })
  expect(await band.find({ text: /潜入中/ })).toBeUndefined()
  await band.unmount()
})

test('利用枠が届くと電脳限界を現在のペースで出し、90%超えで警告帯を出す', async ($, on) => {
  // 5時間枠は開始から3時間で80%使用。このペースなら45分後に使い切る
  mock.clock(on, { now: Date.parse('2026-10-05T10:00:00Z') })
  on('session.measure', (_, e) => ({ changed: e.changed }))
  await $.session.measure({
    context: { window: 200_000 },
    rateLimits: [
      { kind: 'five_hour', percentUsed: 80, resetsAt: '2026-10-05T12:00:00Z' },
      { kind: 'seven_day', percentUsed: 95, resetsAt: '2026-10-08T00:00:00Z' },
      { kind: 'seven_day_fable', percentUsed: 40, resetsAt: '2026-10-08T00:00:00Z' },
    ],
    changed: ['rateLimits'],
  })

  const pane = await $.ui.mount({ ...PANE, surface: 'terminal', props: PANE_PROPS })
  expect(await pane.find({ text: /5時間枠 .* 残20% 電脳限界まで 0:45 \[OVERRUN\]/ })).toBeDefined()
  // Fable週次は枠の63%が経過して40%使用。ペースは半分以上なのでSYNC
  expect(await pane.find({ text: /Fable週次 .* 残60% 再接続まで .* \[SYNC\]/ })).toBeDefined()
  await pane.unmount()

  // 広いパネルは原寸3基を横、中くらいは上下を詰めた帯を縦、狭いパネルは小型を縦に積み、どれも下に電脳容量マップを置く。
  // 枠(iframe)は宣言どおりの大きさで描かれるので、幅はセル数から、高さは縦横比から明示する
  for (const [bodyColumns, viewBox, width, height] of [
    [130, 'viewBox="0 0 1228 350"', 988, 282],
    [100, 'viewBox="0 0 600 500"', 760, 633],
    [48, 'viewBox="0 0 400 542"', 364, 493],
  ] as const) {
    const desktop = await $.ui.mount({ ...PANE, surface: 'desktop', props: { ...PANE_PROPS, bodyColumns } })
    const power = (await desktop.findAll({ type: 'Svg' })).find(one => String(one.props.alt).startsWith('電脳負荷'))
    const source = String(power?.props.source)
    expect(source).toContain('Fable週次')
    expect(source).toContain('L-07F')
    expect(source).toContain(viewBox)
    expect(source).toContain('OVERRUN')
    // 基のすき間から枠(iframe)の白い地が透けないよう、全面を地の色で塗り、走査線を重ねている
    expect(source).toContain('style="background:#020C05"')
    expect(source).toMatch(/<rect width="\d+" height="\d+" fill="#020C05"\/>/)
    expect(source).toContain('fill="url(#scan)"')
    // OVERRUNの基には、数値が消費ペースからの見込みだと注釈する
    expect(source).toContain('※ 今の消費ペースで使い切るまでの見込み')
    expect(source).not.toContain('STAND ALONE')
    // コンテキストの使用量がまだ届いていないので、電脳容量マップは計測待ち
    expect(source).toContain('電脳容量マップ')
    expect(source).toContain('計測待ち')
    expect(power?.props.width).toBe(width)
    expect(power?.props.height).toBe(height)
    expect(source).toContain(`width="${width}" height="${height}"`)
    await desktop.unmount()
  }

  const band = await $.ui.mount({ plugin: 'netdive-quota', surface: 'desktop', component: 'AbovePrompt', props: BAND_PROPS })
  expect(await band.find({ text: /電脳限界接近/ })).toBeDefined()
  expect(await band.find({ text: /週次 残り5%/ })).toBeDefined()
  await band.unmount()
})

test('利用枠が2つのとき、3基目の位置に電脳容量マップを出し、使用率で緑と橙に塗り分ける', async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-10-05T10:00:00Z') })
  on('session.measure', (_, e) => ({ changed: e.changed }))
  // 200kの窓で120k使用。残り40.0%、使用60%なのでCAUTION
  await $.session.measure({
    context: { tokens: 120_000, window: 200_000, percent: 60 },
    rateLimits: [
      { kind: 'five_hour', percentUsed: 18, resetsAt: '2026-10-05T12:00:00Z' },
      { kind: 'seven_day', percentUsed: 12, resetsAt: '2026-10-08T00:00:00Z' },
    ],
    changed: ['rateLimits', 'context'],
  })

  const terminal = await $.ui.mount({ ...PANE, surface: 'terminal', props: PANE_PROPS })
  expect(await terminal.find({ text: /電脳容量 使用60% 120,000 \/ 200,000 \[CAUTION\]/ })).toBeDefined()
  await terminal.unmount()

  // 広い幅では、利用枠2基の右(3基目の位置)に電脳容量マップを置き、高さをタイマーに揃える
  const desktop = await $.ui.mount({ ...PANE, surface: 'desktop', props: { ...PANE_PROPS, bodyColumns: 130 } })
  const power = (await desktop.findAll({ type: 'Svg' })).find(one => String(one.props.alt).startsWith('電脳負荷'))
  const source = String(power?.props.source)
  expect(source).toContain('viewBox="0 0 1228 214"')
  expect(source).toContain('電脳容量マップ')
  expect(source).toContain('使用 60% ／ 200,000')
  expect(source).toContain('CAUTION')
  // 記憶残量のタイマーはマップと重複するので出さない
  expect(source).not.toContain('記憶残量')
  // 残り82%と88%の利用枠は緑、使用60%の電脳容量マップは橙で描く
  expect(source.split('url(#frame-green)').length - 1).toBe(2)
  expect(source.split('url(#frame-amber)').length - 1).toBe(1)
  expect(source).not.toContain('url(#frame-red)')
  // 外枠の中の方眼も段階の色で描く。橙の基に緑の方眼が透けない
  expect(source.split('url(#grid-green)').length - 1).toBe(2)
  expect(source.split('url(#grid-amber)').length - 1).toBe(1)
  expect(source).not.toContain('fill="url(#grid)"')
  await desktop.unmount()
})

test('ツール実行が成功・遮断として記録され、両サーフェスで描ける', async ($, on) => {
  mock.clock(on, { now: 1000 })
  on('tool.call', (_, e) =>
    e.tool === 'Edit' ? { isError: true, result: 'old_string not found' } : { result: 'ok' },
  )

  await $.tool.call({ tool: 'Read', file_path: '/src/app.ts' })
  await $.tool.call({ tool: 'Edit', file_path: '/src/app.ts', old_string: 'a', new_string: 'b' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const pane = await $.ui.mount({ ...PANE, surface, props: PANE_PROPS })
    if (surface === 'desktop') {
      // 文字はすべてSVGの中で描く
      const svg = (await pane.findAll({ type: 'Svg' })).find(one => String(one.props.alt).startsWith('作業班トレース'))
      const source = String(svg?.props.source)
      expect(source).toContain('遮断')
      expect(source).toContain('電脳ログ')
      expect(source).toContain('app.ts')
      expect(source).toContain('Hiragino Kaku Gothic')
      // 3班は横長のレーンに並べる。受け持ちの説明はREADMEに任せ、パネルには注記を出さない
      expect(source).toContain('作業班トレース')
      expect(source).toContain('索敵')
      expect(source).not.toContain('※1')
      expect(await pane.find({ type: 'Text' })).toBeUndefined()
    } else {
      expect(await pane.find({ text: /電脳ログ/ })).toBeDefined()
      expect(await pane.find({ text: /app\.ts/ })).toBeDefined()
      expect(await pane.find({ text: /REWRITE・改竄 遮断/ })).toBeDefined()
    }
    await pane.unmount()

    const band = await $.ui.mount({ plugin: 'netdive-quota', surface, component: 'AbovePrompt', props: BAND_PROPS })
    expect(await band.find({ text: /遮断 BLOCKED/ })).toBeDefined()
    await band.unmount()
  }
})

test('随伴機の実行を専用レーンに打刻し、ターンのトークンから記憶再利用率を出す', async ($, on) => {
  mock.clock(on, { now: 1000 })
  on('agent.spawn', () => ({ model: 'claude-haiku-4-5-20251001', agentId: 'agent-1' }))
  on('tool.call', () => ({ result: 'ok' }))
  on('turn.complete', (_, e) => ({ text: e.answer }))

  await $.agent.spawn({
    tool_use_id: 'toolu_agent',
    prompt: 'src以下を調べる',
    description: '構成調査',
    subagentType: 'Explore',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'claude-opus-5-5',
    background: false,
    fork: false,
  })
  await $.tool.call({ tool: 'Read', file_path: '/src/main.ts', agentId: 'agent-1' })
  // 入力の合計500のうち300をキャッシュから読んだので、記憶再利用率は60%
  await $.turn.complete({
    answer: '調査完了',
    durationMs: 1200,
    isAborted: false,
    turnId: 'turn-1',
    agentId: 'agent-1',
    reason: 'answer',
    usage: {
      model: 'claude-haiku-4-5-20251001',
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 300,
      cache_creation_input_tokens: 100,
    },
  })

  const desktop = await $.ui.mount({ ...PANE, surface: 'desktop', props: PANE_PROPS })
  const svgs = await desktop.findAll({ type: 'Svg' })
  const board = String(svgs.find(one => String(one.props.alt).startsWith('作業班トレース'))?.props.source)
  expect(board).toContain('Explore')
  expect(board).toContain('haiku-4-5 ×1')
  expect(board).toContain('SUB-AGENTS')
  const vitals = String(svgs.find(one => String(one.props.alt).startsWith('電脳バイタル'))?.props.source)
  expect(vitals).toContain('記憶再利用率')
  expect(vitals).toContain('>60%<')
  await desktop.unmount()

  const terminal = await $.ui.mount({ ...PANE, surface: 'terminal', props: PANE_PROPS })
  expect(await terminal.find({ text: /随伴機 Explore「構成調査」 成功 haiku-4-5 ×1/ })).toBeDefined()
  expect(await terminal.find({ text: /記憶再利用率 60%/ })).toBeDefined()
  await terminal.unmount()
})

test('作戦経費を計器に、コンテキストの内訳を電脳容量マップに出す', async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-10-05T10:00:00Z') })
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('session.usage', () => ({
    value: {
    startedAt: Date.parse('2026-10-05T08:00:00Z'),
    rateLimits: [],
    cost: { usd: 1.5 },
    context: {
      tokens: 120_000,
      window: 200_000,
      breakdown: {
        categories: [
          { name: 'System prompt', tokens: 10_000, color: 'promptBorder', isDeferred: false, kind: 'used' },
          { name: 'Messages', tokens: 110_000, color: 'purple', isDeferred: false, kind: 'used' },
          { name: 'MCP server instructions', tokens: 1000, color: 'cyan', isDeferred: false, kind: 'used' },
          // 置き換え表にない英語名。短いものはそのまま、長いものは列の幅で切り詰める
          { name: 'Plugin hooks', tokens: 800, color: 'cyan', isDeferred: false, kind: 'used' },
          { name: 'Some very long category name from a future build', tokens: 600, color: 'cyan', isDeferred: false, kind: 'used' },
          // 実際の内訳と同じく、予備域が空き領域より先に届く
          { name: 'Autocompact buffer', tokens: 33_000, color: 'inactive', isDeferred: false, kind: 'buffer' },
          { name: 'Free space', tokens: 47_000, color: 'promptBorder', isDeferred: false, kind: 'free' },
          { name: 'MCP tools', tokens: 5_000, color: 'cyan', isDeferred: true, kind: 'deferred' },
        ],
        totalTokens: 120_000,
        maxTokens: 200_000,
        rawMaxTokens: 200_000,
        percentage: 60,
        gridRows: [],
        model: 'claude-opus-5-5',
        autocompactSource: 'default',
      },
    },
    },
  }))
  await $.session.measure({
    context: { tokens: 120_000, window: 200_000 },
    rateLimits: [],
    cost: { usd: 1.5 },
    changed: ['context', 'cost'],
  })

  for (const bodyColumns of [130, 100, 48]) {
    const desktop = await $.ui.mount({ ...PANE, surface: 'desktop', props: { ...PANE_PROPS, bodyColumns } })
    const svgs = await desktop.findAll({ type: 'Svg' })
    const vitals = String(svgs.find(one => String(one.props.alt).startsWith('電脳バイタル'))?.props.source)
    expect(vitals).toContain('$1.5000')
    // 内訳は利用枠のタイマーと同じSVGの、電脳容量マップに出す
    const source = String(svgs.find(one => String(one.props.alt).startsWith('電脳負荷'))?.props.source)
    expect(source).toContain('電脳容量マップ')
    expect(source).toContain('使用 60% ／ 200,000')
    // 凡例のトークン数は、kに丸めずすべての桁を出す
    expect(source).toContain('>110,000<')
    expect(source).toContain('>33,000<')
    expect(source).not.toMatch(/>\d+k</)
    // 内訳の名前は日本語で出し、遅延読み込みのツール定義は数えない
    expect(source).toContain('交信記録')
    expect(source).toContain('圧縮予備域')
    expect(source).not.toContain('外部回線ツール')
    // 凡例の名前は文字数ではなく表示幅で切り詰めるので、列に収まる英語名は省略しない
    expect(source).toContain('>MCP server<')
    expect(source).toContain('>Plugin hooks<')
    expect(source).toMatch(/>Some very long[^<]*…</)
    // 予備域は届いた順によらず帯の右端に置き、凡例でも空き領域のあとに並べる
    const blocks = source.match(/<rect x="[\d.]+" y="34" [^>]*\/>/g) ?? []
    expect(blocks.at(-1)).toContain('stroke="#FFA531"')
    expect(source.indexOf('>空き領域<')).toBeLessThan(source.indexOf('>圧縮予備域<'))
    await desktop.unmount()
  }
})

// ── 数字の書式 ────────────────────────────────────────────

test('kやMに丸めず、すべての桁を3桁区切りで出す', () => {
  expect(full(459_312)).toBe('459,312')
  expect(full(200_000)).toBe('200,000')
  expect(full(1_000_000)).toBe('1,000,000')
  expect(full(0)).toBe('0')
  expect(full(999)).toBe('999')
  expect(full(1234.6)).toBe('1,235')
  // コストは小数4桁まで、ドル部分だけを3桁区切りにする
  expect(usd(1.7834)).toBe('$1.7834')
  expect(usd(1234.5)).toBe('$1,234.5000')
  expect(usd(0)).toBe('$0.0000')
  expect(usd(0.77123)).toBe('$0.7712')
})

test('数え上げの途中で、着地する値を飛び越えた数字を見せない', () => {
  const shown = (svg: string) => [...svg.matchAll(/>(\d+)%</g)].map(match => Number(match[1]))
  // 0から46%へ。回るのは一の位だけで、十の位は4を超えない
  const boot = shown(rollText({ x: 0, y: 0, size: 10, fill: '#fff', from: 0, to: 46, format: percent }))
  expect(boot.length > 10).toBe(true)
  expect(boot.every(value => value < 50)).toBe(true)
  // 43から42%へ。1桁だけ違うときは、その桁だけが回る
  const step = shown(rollText({ x: 0, y: 0, size: 10, fill: '#fff', from: 43, to: 42, format: percent }))
  expect(step.every(value => value >= 40 && value < 50)).toBe(true)
})

const USAGE = (input: number, output: number, read: number, write: number) =>
  ({ model: 'claude-opus-5-5', input_tokens: input, output_tokens: output, cache_read_input_tokens: read, cache_creation_input_tokens: write }) as const

const complete = ($: Engine, turnId: string, usage: ReturnType<typeof USAGE>) =>
  $.turn.complete({ answer: '完了', durationMs: 1000, isAborted: false, turnId, reason: 'answer', usage })

const svgSources = async ($: Engine, bodyColumns: number, bodyRows = 30) => {
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop', props: { ...PANE_PROPS, bodyColumns, scroll: { offset: 0, bodyRows } } })
  const svgs = await pane.findAll({ type: 'Svg' })
  await pane.unmount()
  const pick = (head: string) => String(svgs.find(one => String(one.props.alt).startsWith(head))?.props.source)
  return {
    power: pick('電脳負荷'),
    vitals: pick('電脳バイタル'),
    board: pick('作業班トレース'),
    alts: svgs.map(one => String(one.props.alt)),
  }
}

test('計器と端末の行は、トークンとコストを桁を丸めずに出し、桁が増えても枠に収める', async ($, on) => {
  mock.clock(on, { now: 1000 })
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  await $.session.measure({ context: { window: 200_000 }, rateLimits: [], cost: { usd: 1234.5678 }, changed: ['cost'] })
  // 合計は10,000 + 300,000 + 99,312 + 50,000 = 459,312
  await complete($, 'turn-1', USAGE(10_000, 50_000, 300_000, 99_312))

  const { vitals } = await svgSources($, 130)
  expect(vitals).toContain('>459,312<')
  expect(vitals).toContain('>$1,234.5678<')
  expect(vitals).toContain('>300,000<')
  expect(vitals).toContain('>409,312<')
  expect(vitals).not.toMatch(/\d+k</)
  expect(vitals).not.toMatch(/\d+(\.\d)?M</)
  // 計器は動く(SMIL)ので、SVGは動きを許す
  const desktop = await $.ui.mount({ ...PANE, surface: 'desktop', props: PANE_PROPS })
  const svg = (await desktop.findAll({ type: 'Svg' })).find(one => String(one.props.alt).startsWith('電脳バイタル'))
  expect(svg?.props.isInteractive).toBe(true)
  await desktop.unmount()
  // 狭い幅では、桁の多い値は文字を縮めて収める
  const narrow = await svgSources($, 48)
  expect(narrow.vitals).toContain('textLength=')

  const terminal = await $.ui.mount({ ...PANE, surface: 'terminal', props: PANE_PROPS })
  expect(await terminal.find({ text: /作戦経費 \$1,234\.5678 .* 記憶再利用率 73% ／ 交信量 459,312/ })).toBeDefined()
  await terminal.unmount()
})

// ── SVGの作り直し ─────────────────────────────────────────

test('表示するデータが変わらないときは、描き直してもSVGの文字列が1文字も変わらない', async ($, on) => {
  const clock = mock.clock(on, { now: Date.parse('2026-10-05T10:00:00Z') })
  // 開始から2時間たっているので、経費のペース(時刻で変わる)が出る
  on('session.usage', () => ({ value: { startedAt: Date.parse('2026-10-05T08:00:00Z'), rateLimits: [], context: { window: 200_000 } } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('tool.call', () => ({ result: 'ok' }))
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await $.session.measure({
    context: { tokens: 120_000, window: 200_000, percent: 60 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 18, resetsAt: '2026-10-05T12:00:00Z' }],
    cost: { usd: 1.5 },
    changed: ['rateLimits', 'context', 'cost'],
  })
  await $.tool.call({ tool: 'Read', file_path: '/src/app.ts' })

  for (const bodyColumns of [130, 100, 48]) {
    const first = await svgSources($, bodyColumns)
    // 時刻が進んでも、データが変わらなければ同じ文字列(動きを頭から再生し直さない)
    await clock.advance(90_000)
    const second = await svgSources($, bodyColumns)
    expect(second.power).toBe(first.power)
    expect(second.vitals).toBe(first.vitals)
    expect(second.board).toBe(first.board)
    // altも変えない。ペースを描いた時刻で作り直すと、SVGごと描き直しになる
    expect(second.alts).toEqual(first.alts)
  }

  // 3つのSVGは別々に判断する。ログだけが動けば、作業班トレースだけが変わる
  const before = await svgSources($, 130)
  await $.tool.call({ tool: 'Read', file_path: '/src/other.ts' })
  const after = await svgSources($, 130)
  expect(after.board).not.toBe(before.board)
  expect(after.power).toBe(before.power)
  expect(after.vitals).toBe(before.vitals)
})

test('トークンが増えると、計器の数字が前の値から数え上がり、増えた分が浮かぶ', async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-10-05T10:00:00Z') })
  on('turn.complete', (_, e) => ({ text: e.answer }))
  await complete($, 'turn-1', USAGE(1000, 500, 2000, 500))

  // 最初の描画は0から数え上げる。増分は出さない
  const boot = await svgSources($, 130)
  expect(boot.vitals).toContain('<set attributeName="visibility"')
  expect(boot.vitals).toContain('>4,000<')
  expect(boot.vitals).not.toMatch(/>\+[\d,]+</)

  // 交信量が1,500増える(入力1,000 + キャッシュ読込300 + 出力200)
  await complete($, 'turn-2', USAGE(1000, 200, 300, 0))
  const next = await svgSources($, 130)
  expect(next.vitals).toContain('<set attributeName="visibility"')
  expect(next.vitals).toContain('>5,500<')
  expect(next.vitals).toMatch(/>\+1,500</)
  // 前に表示していた4,000が、数え上げの最初の画になる
  expect(next.vitals).toMatch(/<text [^>]*>4,000<set attributeName="visibility" to="hidden"/)
  // 電脳負荷と作業班トレースは、データが動いていないので変わらない
  expect(next.power).toBe(boot.power)
  expect(next.board).toBe(boot.board)
})

// ── 重い構成の文字数 ──────────────────────────────────────

// 重い構成を作る: 利用枠3基・内訳9区分・ログ60件・随伴機3機
const crowd = async ($: Engine, on: Parameters<typeof mock.clock>[0]) => {
  mock.clock(on, { now: Date.parse('2026-10-05T10:00:00Z') })
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('tool.call', () => ({ result: 'ok' }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('agent.spawn', (_, e) => ({ model: 'claude-haiku-4-5-20251001', agentId: `agent-${e.tool_use_id}` }))
  const categories = [
    ['System prompt', 'used', 10_000],
    ['System tools', 'used', 16_000],
    ['Memory files', 'used', 3000],
    ['Skills', 'used', 4500],
    ['Custom agents', 'used', 2200],
    ['MCP server instructions', 'used', 1000],
    ['Messages', 'used', 422_612],
    ['Autocompact buffer', 'buffer', 33_000],
    ['Free space', 'free', 270_000],
  ] as const
  on('session.usage', () => ({
    value: {
      startedAt: Date.parse('2026-10-05T08:00:00Z'),
      rateLimits: [],
      cost: { usd: 1234.5678 },
      context: {
        tokens: 459_312,
        window: 1_000_000,
        breakdown: {
          categories: categories.map(([name, kind, tokens]) => ({ name, tokens, color: 'cyan', isDeferred: false, kind })),
          totalTokens: 459_312,
          maxTokens: 1_000_000,
          rawMaxTokens: 1_000_000,
          percentage: 45.9312,
          gridRows: [],
          model: 'claude-opus-5-5',
          autocompactSource: 'auto',
          memoryFiles: [],
          mcpTools: [],
          agents: [],
          isAutoCompactEnabled: true,
          apiUsage: null,
        },
      },
    },
  }))
  // 週次の枠を3基(残りが6日以上あり、時間が3桁になる、7セグメントが最も長いとき)
  await $.session.measure({
    context: { tokens: 459_312, window: 1_000_000 },
    rateLimits: ['seven_day', 'seven_day_fable', 'seven_day_opus'].map(kind => ({
      kind,
      percentUsed: 30,
      resetsAt: '2026-10-11T23:00:00Z',
    })),
    cost: { usd: 1234.5678 },
    changed: ['rateLimits', 'context', 'cost'],
  })
  for (const id of ['a', 'b', 'c']) {
    await $.agent.spawn({
      tool_use_id: `toolu_agent_${id}`,
      prompt: 'src以下を調べる',
      description: '構成調査と依存の洗い出し',
      subagentType: 'Explore',
      provider: { plugin: 'engine', tier: 'core' },
      parentModel: 'claude-opus-5-5',
      background: false,
      fork: false,
    })
  }
  for (let i = 0; i < 60; i += 1) {
    const file_path = `/src/components/very/long/path/file${i}.tsx`
    if (i % 3 === 0) await $.tool.call({ tool: 'Bash', command: `git diff --stat origin/main...HEAD -- hooks tests ${i}` })
    else if (i % 3 === 1) await $.tool.call({ tool: 'Read', file_path })
    else await $.tool.call({ tool: 'Edit', file_path, old_string: 'a', new_string: 'b' })
  }
  await complete($, 'turn-1', USAGE(1_234_567, 345_678, 9_876_543, 456_789))

}

// 幅ごとに別のテスト(別の描画の履歴)にして、どの幅も最初の描画(すべての数字を0から数え上げる、最も長いとき)を測る
for (const bodyColumns of [130, 100, 48]) {
  test(`利用枠3基・内訳9区分・ログ60件・随伴機3機でも、動きを付けたどのSVGも文字数の上限に収まる(${bodyColumns}列)`, async ($, on) => {
    await crowd($, on)

    const boot = await svgSources($, bodyColumns, 80)
    for (const source of [boot.power, boot.vitals, boot.board]) expect(source.length).toBeLessThan(131_072)
    // 文字数の安全装置(125,000)で動きを外されていない
    expect(boot.power.length).toBeLessThan(125_000)
    expect(boot.power).toContain('<set attributeName="visibility"')
    expect(boot.vitals).toContain('<set attributeName="visibility"')
    expect(boot.power).toContain('>422,612<')

    // 数字が動いたあとの描き直しも収まる
    await complete($, 'turn-2', USAGE(2000, 400, 1000, 0))
    await $.tool.call({ tool: 'Bash', command: 'npm test' })
    const next = await svgSources($, bodyColumns, 80)
    for (const source of [next.power, next.vitals, next.board]) expect(source.length).toBeLessThan(131_072)
    expect(next.vitals).toMatch(/>\+[\d,]+</)
  })
}

test('経過時間の時計と新しい行の打ち込みを、作業班トレースと電脳ログに加える', async ($, on) => {
  const clock = mock.clock(on, { now: Date.parse('2026-10-05T10:00:00Z') })
  // 開始から4,873秒(1時間21分13秒)たっている
  on('session.usage', () => ({ value: { startedAt: Date.parse('2026-10-05T08:38:47Z'), rateLimits: [], context: { window: 200_000 } } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  let finish = () => {}
  on('tool.call', () => new Promise(resolve => (finish = () => resolve({ result: 'ok' }))))
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  const running = $.tool.call({ tool: 'Read', file_path: '/src/app.ts' })
  await clock.settle()

  const during = await svgSources($, 130)
  // 経過時間の時計(T+81:13)。分は10分先まで見ても2桁なので、3桁目を置かず「T+ 81:13」のように空けない
  expect(during.board).toContain('>T+<')
  expect(during.board).toContain('dur="10s" begin="-3s" repeatCount="indefinite"')
  expect(during.board).toContain('dur="60s" begin="-13s" repeatCount="indefinite"')
  expect(during.board).toContain('dur="6000s" begin="-4873s" repeatCount="indefinite"')
  expect(during.board).not.toContain('dur="60000s"')
  // 新しい行は、地の色の覆いを動かして打ち込み、そのあと点滅のカーソルが出る
  expect(during.board).toContain('calcMode="discrete" values="196;')
  expect(during.board).toContain('values="1;0" keyTimes="0;0.5" dur="1.1s"')
  // 状況に応じた波形が、見出しの空きに流れる
  expect(during.board).toContain('clip-path="url(#scope-clip)"')
  expect(during.board).toContain('type="translate"')

  // 同じ行の判定が変わっただけのときは、打ち込み直さない。点滅のカーソルと波形は残る
  finish()
  await running
  const after = await svgSources($, 130)
  expect(after.board).not.toBe(during.board)
  expect(after.board).not.toContain('calcMode="discrete" values="196;')
  expect(after.board).toContain('values="1;0" keyTimes="0;0.5" dur="1.1s"')
  expect(after.board).toContain('clip-path="url(#scope-clip)"')
})

// ── トークンの集計 ────────────────────────────────────────

test('モデルへの要求ごとにトークンが増え、ターンの終わりで二重に数えない', async ($, on) => {
  mock.clock(on, { now: 1000 })
  const steps: Record<string, ReturnType<typeof USAGE>> = {
    'turn-1:0': USAGE(100, 50, 300, 100),
    'turn-1:1': USAGE(10, 5, 0, 0),
    'turn-3:0': USAGE(100, 50, 0, 0),
  }
  on('turn.step', async function* (_, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: steps[`${e.turnId}:${e.index}`] ?? null }
  })
  on('turn.complete', (_, e) => ({ text: e.answer }))

  const step = async (turnId: string, index: number) => {
    const stream = $.turn.step({ turnId, index, model: 'claude-opus-5-5', messageCount: 3 })
    for await (const _chunk of stream) {
      // チャンクは使わない
    }
    await stream.result
  }
  // 端末の行の末尾が、いまの交信量(入力・キャッシュの読み書き・出力の合計)
  const isShowing = async (total: string) => {
    const terminal = await $.ui.mount({ ...PANE, surface: 'terminal', props: PANE_PROPS })
    const row = await terminal.find({ text: new RegExp(`交信量 ${total}$`) })
    await terminal.unmount()
    return row !== undefined
  }

  // ターンが終わる前から、1回の要求ごとに増える
  await step('turn-1', 0)
  expect(await isShowing('550')).toBe(true)
  await step('turn-1', 1)
  expect(await isShowing('565')).toBe(true)
  // ターンの使用量は2回の要求の合計と同じなので、終わっても増えない。ターン数だけ増える
  await complete($, 'turn-1', USAGE(110, 55, 300, 100))
  expect(await isShowing('565')).toBe(true)
  expect((await svgSources($, 130)).vitals).toContain('※ 1ターンの累計')

  // 要求のないターンは、ターンの使用量がそのまま加わる
  await complete($, 'turn-2', USAGE(1000, 0, 0, 0))
  expect(await isShowing('1,565')).toBe(true)
  expect((await svgSources($, 130)).vitals).toContain('※ 2ターンの累計')

  // ステップの合計がターンの使用量を上回っても、累計は減らない
  await step('turn-3', 0)
  expect(await isShowing('1,715')).toBe(true)
  await complete($, 'turn-3', USAGE(80, 40, 0, 0))
  expect(await isShowing('1,715')).toBe(true)
})
