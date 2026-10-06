import type { MemoryMap, MemorySlice, TokenTally } from '../types'
import { AMBER, CYAN, GREEN, MOSS, PAPER, VOID, clip, crtDefs, scanlines, svgSize, tag, text, xml } from './palette'
import type { Layout } from './palette'

// ── 数値の書式 ──────────────────────────────────────────

export const kilo = (tokens: number): string =>
  tokens >= 1_000_000
    ? `${(tokens / 1_000_000).toFixed(1)}M`
    : tokens >= 1000
      ? `${Math.round(tokens / 1000)}k`
      : String(Math.round(tokens))

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

// ── 記憶領域マップ ────────────────────────────────────────
// /contextの内訳を、区画を並べた帯で描く。表示名だけ日本語にし、判定はkindで行う

const SLICE_NAMES: Record<string, string> = {
  'System prompt': '基幹プロンプト',
  'System tools': '標準ツール',
  'MCP tools': '外部回線ツール',
  'Custom agents': '随伴機定義',
  'Memory files': '記憶ファイル',
  Skills: 'スキル',
  Messages: '交信記録',
  'Free space': '空き領域',
  'Autocompact buffer': '圧縮予備域',
}

export const sliceName = (slice: MemorySlice): string => SLICE_NAMES[slice.name] ?? slice.name

const USED_COLORS = [GREEN, '#3FD9A0', '#C8FF7A', '#7FB8FF', PAPER, '#4FAF5A']
const FREE = '#0F3A17'
const BUFFER = '#3A2108'

// 使用中の区分を多い順に、そのあとに空き領域と圧縮予備域を並べる
const ordered = (memory: MemoryMap): { slice: MemorySlice; color: string }[] => {
  const used = memory.slices
    .filter(one => one.kind === 'used' && one.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens)
    .map((slice, i) => ({ slice, color: USED_COLORS[i % USED_COLORS.length]! }))
  const rest = memory.slices
    .filter(one => one.kind === 'free' || one.kind === 'buffer')
    .map(slice => ({ slice, color: slice.kind === 'free' ? FREE : BUFFER }))
  return [...used, ...rest]
}

const memoryMap = (memory: MemoryMap | null, width: number): { svg: string; height: number } => {
  const blocks = width >= 500 ? 50 : 32
  const step = width / blocks
  const head = `${tag(0, 0, 18, 11, GREEN, VOID, '記憶領域マップ')}
  ${text(width, 14, 11, GREEN, memory ? `使用 ${Math.round(memory.percentage)}% ／ ${kilo(memory.max)}` : '', { anchor: 'end', weight: 800 })}`
  if (memory === null || memory.max <= 0) {
    const empty = Array.from({ length: blocks }, (_, i) => `<rect x="${i * step}" y="28" width="${step - 2}" height="18" fill="${FREE}"/>`).join('')
    return { svg: `${head}${empty}${text(0, 66, 9, CYAN, '※ 次の応答のあとで計測します', { weight: 600 })}`, height: 74 }
  }
  const rows = ordered(memory)
  const total = rows.reduce((sum, one) => sum + one.slice.tokens, 0) || memory.max
  // 区画の中心が、累積したトークンのどの区分に入るかで色を決める
  let bufferStart: number | undefined
  const cells = Array.from({ length: blocks }, (_, i) => {
    const at = ((i + 0.5) / blocks) * total
    let sum = 0
    const hit = rows.find(one => (sum += one.slice.tokens) > at) ?? rows.at(-1)!
    if (hit.slice.kind === 'buffer' && bufferStart === undefined) bufferStart = i
    return `<rect x="${i * step}" y="28" width="${step - 2}" height="18" fill="${hit.color}"${hit.slice.kind === 'buffer' ? ` stroke="${AMBER}" stroke-width="0.8"` : ''}/>`
  }).join('')
  // 圧縮が始まる位置に、シアンの引き出し線で印を付ける
  const line =
    bufferStart === undefined
      ? ''
      : `<line x1="${bufferStart * step - 1}" y1="24" x2="${bufferStart * step - 1}" y2="50" stroke="${CYAN}" stroke-width="1.5"/>`
  const columns = width >= 500 ? 3 : 2
  const columnW = width / columns
  const legend = rows
    .map(({ slice, color }, i) => {
      const x = (i % columns) * columnW
      const y = 66 + Math.floor(i / columns) * 16
      return `<rect x="${x}" y="${y - 8}" width="8" height="8" fill="${color}"${slice.kind === 'buffer' ? ` stroke="${AMBER}" stroke-width="0.8"` : ''}/>
  ${text(x + 12, y, 10, slice.kind === 'used' ? PAPER : MOSS, xml(clip(sliceName(slice), 9)))}
  ${text(x + columnW - 10, y, 9, MOSS, kilo(slice.tokens), { anchor: 'end', face: 'mono', weight: 500 })}`
    })
    .join('')
  const noteY = 66 + Math.ceil(rows.length / columns) * 16 + 4
  return {
    svg: `${head}<g filter="url(#glow)">${cells}</g>${line}${legend}
  ${text(0, noteY, 9, CYAN, '※ 使用が圧縮予備域（橙の枠）に達すると、自動で記憶圧縮されます', { weight: 600 })}`,
    height: noteY + 8,
  }
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

// wide: 計器3つの右に記憶領域マップ。medium・narrow: 計器3つの下に記憶領域マップ
export const vitalsSvg = (
  cost: number | null,
  tokens: TokenTally,
  memory: MemoryMap | null,
  startedAt: number,
  now: number,
  layout: Layout,
  drawWidth: number,
): { source: string; width: number; height: number } => {
  const width = VITALS_W[layout]
  const isNarrow = layout === 'narrow'
  const cellW = layout === 'wide' ? 204 : Math.floor((width - 16 - 2 * 10) / 3)
  const cells = cellsOf(cost, tokens, startedAt, now, isNarrow)
    .map((one, i) => cell(8 + i * (cellW + 10), 4, cellW, one, isNarrow ? 20 : 28))
    .join('')
  const mapX = layout === 'wide' ? 8 + 3 * (cellW + 10) + 14 : 8
  const mapY = layout === 'wide' ? 6 : CELL_H + 18
  const map = memoryMap(memory, width - mapX - 8)
  const height = layout === 'wide' ? Math.max(CELL_H + 8, mapY + map.height + 4) : mapY + map.height + 4
  const size = svgSize(drawWidth, width, height)
  const source = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${size.width}" height="${size.height}" style="background:${VOID}">
  <rect width="${width}" height="${height}" fill="${VOID}"/>
  <defs>${crtDefs()}</defs>
  ${cells}
  <g transform="translate(${mapX} ${mapY})">${map.svg}</g>
  ${scanlines(width, height)}
</svg>`
  return { source, ...size }
}

// Svgのないターミナル向けの1〜2行
export const vitalsRows = (
  cost: number | null,
  tokens: TokenTally,
  memory: MemoryMap | null,
  startedAt: number,
  now: number,
): string[] => {
  const rate = cacheRate(tokens)
  const pace = costPace(cost, startedAt, now)
  const first = `作戦経費 ${cost === null ? '--' : usd(cost)}${pace ? ` (${pace})` : ''} ／ 記憶再利用率 ${rate === undefined ? '--' : `${Math.round(rate * 100)}%`} ／ 交信量 ${kilo(tokens.input + tokens.cacheRead + tokens.cacheWrite + tokens.output)}`
  if (memory === null) return [first]
  const top = ordered(memory)
    .filter(one => one.slice.kind === 'used')
    .slice(0, 3)
    .map(one => `${sliceName(one.slice)} ${kilo(one.slice.tokens)}`)
    .join(' ')
  return [first, `記憶領域 使用${Math.round(memory.percentage)}% ${top}`]
}
