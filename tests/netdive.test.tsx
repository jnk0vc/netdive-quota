import { expect, mock, test } from 'claude-code/testing'

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
  expect(await terminal.find({ text: /電脳容量 使用60% 120k \/ 200k \[CAUTION\]/ })).toBeDefined()
  await terminal.unmount()

  // 広い幅では、利用枠2基の右(3基目の位置)に電脳容量マップを置き、高さをタイマーに揃える
  const desktop = await $.ui.mount({ ...PANE, surface: 'desktop', props: { ...PANE_PROPS, bodyColumns: 130 } })
  const power = (await desktop.findAll({ type: 'Svg' })).find(one => String(one.props.alt).startsWith('電脳負荷'))
  const source = String(power?.props.source)
  expect(source).toContain('viewBox="0 0 1228 214"')
  expect(source).toContain('電脳容量マップ')
  expect(source).toContain('使用 60% ／ 200k')
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
    expect(vitals).toContain('$1.50')
    // 内訳は利用枠のタイマーと同じSVGの、電脳容量マップに出す
    const source = String(svgs.find(one => String(one.props.alt).startsWith('電脳負荷'))?.props.source)
    expect(source).toContain('電脳容量マップ')
    expect(source).toContain('使用 60% ／ 200k')
    // 内訳の名前は日本語で出し、遅延読み込みのツール定義は数えない
    expect(source).toContain('交信記録')
    expect(source).toContain('圧縮予備域')
    expect(source).not.toContain('外部回線ツール')
    // 予備域は届いた順によらず帯の右端に置き、凡例でも空き領域のあとに並べる
    const blocks = source.match(/<rect x="[\d.]+" y="34" [^>]*\/>/g) ?? []
    expect(blocks.at(-1)).toContain('stroke="#FFA531"')
    expect(source.indexOf('>空き領域<')).toBeLessThan(source.indexOf('>圧縮予備域<'))
    await desktop.unmount()
  }
})
