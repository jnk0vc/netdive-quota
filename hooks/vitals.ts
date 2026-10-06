import type { TokenTally } from '../types'
import { CYAN, GREEN, MOSS, PAPER, VOID, crtDefs, scanlines, svgSize, tag, text, xml } from './palette'
import type { Layout } from './palette'
import { kilo } from './power'

// ── 数値の書式 ──────────────────────────────────────────

export const usd = (value: number): string => `$${value.toFixed(2)}`

// 開始から5分たつまでは平均がぶれるので、ペースを出さない
export const costPace = (cost: number | null, startedAt: number, now: number): string | undefined => {
  const hours = (now - startedAt) / 3_600_000
  return cost === null || startedAt === 0 || hours < 5 / 60 ? undefined : `${usd(cost / hours)}/h`
}

// キャッシュから読んだ入力の割合。入力が1件もなければundefined
export const cacheRate = (tokens: TokenTally): number | undefined => {
  const input = tokens.input + tokens.cacheRead + tokens.cacheWrite
  return input === 0 ? undefined : tokens.cacheRead / input
}

// ── 計器（作戦経費・記憶再利用率・交信量） ─────────────────────

const CELL_H = 112

type Cell = { title: string; english: string; value: string; sub: string; note: string }

const cell = (x: number, y: number, w: number, one: Cell, valueSize: number): string =>
  `<g transform="translate(${x} ${y})">
  <polygon points="0,0 ${w - 10},0 ${w},10 ${w},${CELL_H} 0,${CELL_H}" fill="url(#grid)" stroke="${MOSS}" stroke-width="1"/>
  ${tag(8, 8, 18, 11, GREEN, VOID, one.title)}
  ${w >= 150 ? text(w - 8, 20, 7, MOSS, one.english, { anchor: 'end', face: 'sans', weight: 800, spacing: 1 }) : ''}
  <g filter="url(#glow)">${text(10, 62, valueSize, one.value === '--' ? MOSS : GREEN, xml(one.value), { face: 'sans', weight: 800 })}</g>
  ${text(10, 82, 10, PAPER, xml(one.sub), { face: 'mono', weight: 500 })}
  ${text(10, 101, 9, CYAN, one.note, { weight: 600 })}
</g>`

const cellsOf = (cost: number | null, tokens: TokenTally, startedAt: number, now: number, isNarrow: boolean): Cell[] => {
  const rate = cacheRate(tokens)
  const input = tokens.input + tokens.cacheRead + tokens.cacheWrite
  return [
    {
      title: '作戦経費',
      english: 'OPS COST',
      value: cost === null ? '--' : usd(cost),
      sub: costPace(cost, startedAt, now) ?? 'ペース計測中',
      note: isNarrow ? '※ 開始からの平均' : '※ セッション開始からの平均ペース',
    },
    {
      title: '記憶再利用率',
      english: 'CACHE HIT',
      value: rate === undefined ? '--' : `${Math.round(rate * 100)}%`,
      sub: `読${kilo(tokens.cacheRead)}／書${kilo(tokens.cacheWrite)}`,
      note: isNarrow ? '※ 読込÷入力' : '※ キャッシュ読み込み÷入力の合計',
    },
    {
      title: '交信量',
      english: 'TOKENS',
      value: input + tokens.output === 0 ? '--' : kilo(input + tokens.output),
      sub: `入${kilo(input)}／出${kilo(tokens.output)}`,
      note: `※ ${tokens.turns}ターンの累計`,
    },
  ]
}

// 座標系の幅。作業班トレースと同じにして文字の大きさを揃える
const VITALS_W: Record<Layout, number> = { wide: 1228, medium: 600, narrow: 400 }

// 計器3つを横に並べる
export const vitalsSvg = (
  cost: number | null,
  tokens: TokenTally,
  startedAt: number,
  now: number,
  layout: Layout,
  drawWidth: number,
): { source: string; width: number; height: number } => {
  const width = VITALS_W[layout]
  const isNarrow = layout === 'narrow'
  const cellW = Math.floor((width - 16 - 2 * 10) / 3)
  const cells = cellsOf(cost, tokens, startedAt, now, isNarrow)
    .map((one, i) => cell(8 + i * (cellW + 10), 4, cellW, one, isNarrow ? 20 : 28))
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
  return `作戦経費 ${cost === null ? '--' : usd(cost)}${pace ? ` (${pace})` : ''} ／ 記憶再利用率 ${rate === undefined ? '--' : `${Math.round(rate * 100)}%`} ／ 交信量 ${kilo(tokens.input + tokens.cacheRead + tokens.cacheWrite + tokens.output)}`
}
