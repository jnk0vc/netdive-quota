import type { TokenTally } from '../types'
import { deltaTag, rollText } from './motion'
import { CYAN, GREEN, MOSS, PAPER, VOID, crtDefs, group, scanlines, svgSize, tag, text, textWidth, xml } from './palette'
import type { Layout } from './palette'
import { full, percent } from './power'

// ── 数値の書式 ──────────────────────────────────────────

// 小数4桁まで、ドル部分は3桁区切り。$1.7834、$1,234.5000
export const usd = (value: number): string => {
  const [whole = '0', fraction = '0000'] = value.toFixed(4).split('.')
  return `$${group(whole)}.${fraction}`
}

// 開始から5分たつまでは平均がぶれるので、ペースを出さない
const paceOf = (cost: number | null, startedAt: number, now: number): number | undefined => {
  const hours = (now - startedAt) / 3_600_000
  return cost === null || startedAt === 0 || hours < 5 / 60 ? undefined : cost / hours
}

const perHour = (value: number): string => `${usd(value)}/h`

export const costPace = (cost: number | null, startedAt: number, now: number): string | undefined => {
  const pace = paceOf(cost, startedAt, now)
  return pace === undefined ? undefined : perHour(pace)
}

// キャッシュから読んだ入力の割合。入力が1件もなければundefined
export const cacheRate = (tokens: TokenTally): number | undefined => {
  const input = tokens.input + tokens.cacheRead + tokens.cacheWrite
  return input === 0 ? undefined : tokens.cacheRead / input
}

// 入力トークンの合計(キャッシュの読み書きを含む)
const inputOf = (tokens: TokenTally): number => tokens.input + tokens.cacheRead + tokens.cacheWrite

// ── 計器（作戦経費・記憶再利用率・交信量） ─────────────────────

const CELL_H = 126

// 数え上げの起点にする、前に表示した値
export type VitalsShown = { cost: number | null; tokens: TokenTally }

// isBootは最初の描画(起点がすべて0)であること。起点は増分の表示に使うので、最初の描画では増分を出さない
export type VitalsMotion = { from: VitalsShown; isBoot: boolean }

// 数え上げる数値(起点から現在値へ)か、そのまま出す文字
type Figure = { from: number; to: number; format: (n: number) => string } | string

type Readout = { label: string; figure: Figure }

type Cell = {
  title: string
  english: string
  figure: Figure
  readouts: [Readout, Readout]
  // 値が増えたときに浮かべる増分
  delta?: string
  note: string
}

// まだ何も表示していない状態。最初の描画は、ここ(すべて0)から数え上げる
export const NO_VITALS: VitalsShown = { cost: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0 } }

// 数え上げる数値。動きがなければ、起点を現在値にして数え上げずにそのまま出す
const figureOf = (to: number, from: number, motion: VitalsMotion | undefined, format: (n: number) => string): Figure => ({
  from: motion === undefined ? to : from,
  to,
  format,
})

// 1ターンあたりのコスト。コストが無いかターンが無いときはundefined
const perTurn = (cost: number | null, tokens: TokenTally): number | undefined =>
  cost === null || tokens.turns === 0 ? undefined : cost / tokens.turns

const BIG_FRAMES = 24
const ROW_FRAMES = 18

const show = (
  figure: Figure,
  o: { x: number; y: number; size: number; fill: string; anchor?: 'start' | 'middle' | 'end'; face: 'sans' | 'mono'; weight: number; fit: number; frames: number },
): string =>
  typeof figure === 'string' ? text(o.x, o.y, o.size, o.fill, xml(figure), o) : rollText({ ...o, ...figure })

const cell = (x: number, y: number, w: number, one: Cell, valueSize: number): string => {
  const rows = one.readouts
    .map(({ label, figure }, i) => {
      const rowY = 80 + i * 14
      // 数字は右寄せ。ラベルの幅を引いた残りに収める
      const fit = w - 20 - textWidth(label, 10) - 8
      return `${text(10, rowY, 10, MOSS, xml(label), { face: 'mono', weight: 500 })}
  ${show(figure, { x: w - 10, y: rowY, size: 10, fill: PAPER, anchor: 'end', face: 'mono', weight: 500, fit, frames: ROW_FRAMES })}`
    })
    .join('\n  ')
  return `<g transform="translate(${x} ${y})">
  <polygon points="0,0 ${w - 10},0 ${w},10 ${w},${CELL_H} 0,${CELL_H}" fill="url(#grid)" stroke="${MOSS}" stroke-width="1"/>
  ${tag(8, 8, 18, 11, GREEN, VOID, one.title)}
  ${w >= 150 ? text(w - 8, 20, 7, MOSS, one.english, { anchor: 'end', face: 'sans', weight: 800, spacing: 1 }) : ''}
  <g filter="url(#glow)">${show(one.figure, { x: 10, y: 58, size: valueSize, fill: one.figure === '--' ? MOSS : GREEN, face: 'sans', weight: 800, fit: w - 20, frames: BIG_FRAMES })}</g>
  ${rows}
  ${one.delta === undefined ? '' : deltaTag(w - 8, 44, one.delta, CYAN)}
  ${text(10, 116, 9, CYAN, one.note, { weight: 600 })}
</g>`
}

const cellsOf = (
  cost: number | null,
  tokens: TokenTally,
  startedAt: number,
  now: number,
  isNarrow: boolean,
  motion?: VitalsMotion,
): Cell[] => {
  // 前の描画に値が無かった項目(コストの報告前、ペースの計測前など)は、0から数え上げる
  const before = motion?.from ?? NO_VITALS
  const beforeCost = before.cost ?? 0
  const rate = cacheRate(tokens)
  const input = inputOf(tokens)
  const total = input + tokens.output
  const pace = paceOf(cost, startedAt, now)
  const turn = perTurn(cost, tokens)
  const beforeTotal = inputOf(before.tokens) + before.tokens.output
  // 増えたときだけ、増分を浮かべる。最初の描画(起点が0)では出さない
  const rise = (to: number, from: number): number | undefined =>
    motion === undefined || motion.isBoot || to <= from ? undefined : to - from
  const costRise = cost === null ? undefined : rise(cost, beforeCost)
  const tokenRise = rise(total, beforeTotal)
  return [
    {
      title: '作戦経費',
      english: 'OPS COST',
      figure: cost === null ? '--' : figureOf(cost, beforeCost, motion, usd),
      readouts: [
        {
          label: '毎時',
          figure: pace === undefined ? '計測中' : figureOf(pace, paceOf(beforeCost, startedAt, now) ?? 0, motion, perHour),
        },
        {
          label: '1ターン',
          figure: turn === undefined ? '--' : figureOf(turn, perTurn(beforeCost, before.tokens) ?? 0, motion, usd),
        },
      ],
      // 増分が$0.0000に丸まるときは出さない
      delta: costRise !== undefined && Number(costRise.toFixed(4)) > 0 ? `+${usd(costRise)}` : undefined,
      note: isNarrow ? '※ 開始からの平均' : '※ セッション開始からの平均ペース',
    },
    {
      title: '記憶再利用率',
      english: 'CACHE HIT',
      figure: rate === undefined ? '--' : figureOf(rate * 100, (cacheRate(before.tokens) ?? 0) * 100, motion, percent),
      readouts: [
        { label: '読込', figure: figureOf(tokens.cacheRead, before.tokens.cacheRead, motion, full) },
        { label: '書込', figure: figureOf(tokens.cacheWrite, before.tokens.cacheWrite, motion, full) },
      ],
      note: isNarrow ? '※ 読込÷入力' : '※ キャッシュ読み込み÷入力の合計',
    },
    {
      title: '交信量',
      english: 'TOKENS',
      figure: total === 0 ? '--' : figureOf(total, beforeTotal, motion, full),
      readouts: [
        { label: '入力', figure: figureOf(input, inputOf(before.tokens), motion, full) },
        { label: '出力', figure: figureOf(tokens.output, before.tokens.output, motion, full) },
      ],
      delta: tokenRise === undefined ? undefined : `+${full(tokenRise)}`,
      note: `※ ${tokens.turns}ターンの累計`,
    },
  ]
}

// 座標系の幅。作業班トレースと同じにして文字の大きさを揃える
const VITALS_W: Record<Layout, number> = { wide: 1228, medium: 600, narrow: 400 }

// 値の大きさ。広いほど大きく、数字の桁が増えても収まる範囲で選ぶ
const VALUE_SIZE: Record<Layout, number> = { wide: 34, medium: 28, narrow: 20 }

// 計器3つを横に並べる。
// motionを渡すと、数値を前に表示した値から数え上げ、増えた分を浮かべる。渡さないときは最終値をそのまま出す
export const vitalsSvg = (
  cost: number | null,
  tokens: TokenTally,
  startedAt: number,
  now: number,
  layout: Layout,
  drawWidth: number,
  motion?: VitalsMotion,
): { source: string; width: number; height: number } => {
  const width = VITALS_W[layout]
  const isNarrow = layout === 'narrow'
  const cellW = Math.floor((width - 16 - 2 * 10) / 3)
  const cells = cellsOf(cost, tokens, startedAt, now, isNarrow, motion)
    .map((one, i) => cell(8 + i * (cellW + 10), 4, cellW, one, VALUE_SIZE[layout]))
    .join('')
  const height = CELL_H + 8
  const size = svgSize(drawWidth, width, height)
  const source = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${size.width}" height="${size.height}" style="background:${VOID}">
  <rect width="${width}" height="${height}" fill="${VOID}"/>
  <defs>${crtDefs()}</defs>
  ${cells}
  ${scanlines(width, height)}
</svg>`
  return { source, ...size }
}

// Svgのないターミナル向けの1行
export const vitalsRow = (cost: number | null, tokens: TokenTally, startedAt: number, now: number): string => {
  const rate = cacheRate(tokens)
  const pace = costPace(cost, startedAt, now)
  return `作戦経費 ${cost === null ? '--' : usd(cost)}${pace ? ` (${pace})` : ''} ／ 記憶再利用率 ${rate === undefined ? '--' : percent(rate * 100)} ／ 交信量 ${full(inputOf(tokens) + tokens.output)}`
}
