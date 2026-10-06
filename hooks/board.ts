import type { LogEntry, UnitName, Units, Verdict } from '../types'
import { AMBER, CYAN, GREEN, MOSS, PAPER, RED, VOID, clip, crtDefs, scanlines, svgSize, tag, tagWidth, text, xml } from './palette'
import type { Layout } from './palette'

export const UNIT_LABEL: Record<UnitName, string> = { SCOUT: '索敵', REWRITE: '改竄', DIVE: '潜入' }
// 読む→書く→実行する、の順に上から並べる
export const UNIT_NAMES: UnitName[] = ['SCOUT', 'REWRITE', 'DIVE']
export const VERDICT_TEXT: Record<Verdict, string> = {
  idle: '待機',
  running: '潜行中',
  approved: '成功',
  denied: '遮断',
}
export const VERDICT_COLOR: Record<Verdict, string> = {
  idle: MOSS,
  running: AMBER,
  approved: GREEN,
  denied: RED,
}

export const elapsed = (from: number, at: number): string => {
  const seconds = Math.max(0, Math.floor((at - from) / 1000))
  const mm = String(Math.floor(seconds / 60)).padStart(2, '0')
  const ss = String(seconds % 60).padStart(2, '0')
  return `T+${mm}:${ss}`
}

// ── 作業班トレース ────────────────────────────────────────
// 3班を横長のレーンに並べ、ツールの実行を1回1列で打刻する。右端が最新。
// 列の下に通し番号の目盛りを振り、欄外にシアンで班の受け持ちを注釈する

const LANE_TOP = 46
const LANE_H = 40
const STEP = 12
const TAPE_Y = LANE_TOP + 3 * LANE_H
export const TRACE_H = TAPE_Y + 74

const NOTES = [
  '※1 索敵＝読み取り（Read・Grep・Glob ほか）',
  '　  改竄＝書き換え（Edit・Write）／潜入＝実行（Bash ほか）',
  '※2 1列が1回の実行。右端が最新で、点滅は実行中',
]

const trace = (state: Units, decision: Verdict, list: readonly LogEntry[], width: number): string => {
  const labelW = 86
  const statusW = width >= 500 ? 128 : 100
  const trackX = labelW
  const trackW = width - labelW - statusW - 10
  const columns = Math.max(4, Math.min(40, Math.floor(trackW / STEP)))
  const recent = list.slice(-columns)
  const total = UNIT_NAMES.reduce((sum, name) => sum + state[name].count, 0)
  // 右詰めにするため、まだ埋まっていない列の数だけずらす
  const shift = columns - recent.length
  const columnX = (i: number) => trackX + (shift + i) * STEP

  const lanes = UNIT_NAMES.map((name, row) => {
    const y = LANE_TOP + row * LANE_H
    const unit = state[name]
    const color = VERDICT_COLOR[unit.verdict]
    const marks = recent
      .map((one, i) => {
        if (one.unit !== name) return ''
        const pulse =
          one.verdict === 'running'
            ? '<animate attributeName="opacity" values="1;0.25;1" dur="0.7s" repeatCount="indefinite"/>'
            : ''
        return `<rect x="${columnX(i) + 2}" y="${y + 6}" width="${STEP - 4}" height="${LANE_H - 16}" fill="${VERDICT_COLOR[one.verdict]}">${pulse}</rect>`
      })
      .join('')
    return `${tag(0, y + 4, 18, 12, GREEN, VOID, UNIT_LABEL[name])}
  ${text(0, y + 34, 8, MOSS, name, { face: 'sans', weight: 800, spacing: 1.2 })}
  <line x1="${trackX}" y1="${y + LANE_H / 2 - 2}" x2="${trackX + columns * STEP}" y2="${y + LANE_H / 2 - 2}" stroke="${MOSS}" stroke-width="1" stroke-dasharray="1 3"/>
  <g filter="url(#glow)">${marks}</g>
  ${text(width, y + 18, 14, color, VERDICT_TEXT[unit.verdict], { anchor: 'end', weight: 800 })}
  ${text(width, y + 32, 9, unit.verdict === 'idle' ? MOSS : PAPER, `${xml(clip(unit.tool || '------', 12))}${unit.count ? ` ×${unit.count}` : ''}`, { anchor: 'end', face: 'mono', weight: 500 })}`
  }).join('')

  // 通し番号の目盛り。5回ごとに長い目盛りと番号を付ける
  const tape = Array.from({ length: columns }, (_, c) => {
    const i = c - shift
    const seq = i >= 0 ? total - (recent.length - 1 - i) : undefined
    const x = trackX + c * STEP + STEP / 2
    const isMajor = seq !== undefined && seq % 5 === 0
    return `<line x1="${x}" y1="${TAPE_Y}" x2="${x}" y2="${TAPE_Y + (isMajor ? 8 : 4)}" stroke="${MOSS}" stroke-width="1"/>${
      isMajor ? text(x, TAPE_Y + 18, 8, MOSS, `#${seq}`, { anchor: 'middle', face: 'mono', weight: 500 }) : ''
    }`
  }).join('')

  const title = tagWidth(13, '作業班トレース')
  const notes = NOTES.map((one, i) => text(14, TAPE_Y + 34 + i * 14, 10, CYAN, one, { weight: 600 })).join('')
  return `${tag(0, 4, 20, 13, GREEN, VOID, '作業班トレース')}
  ${text(title + 4, 12, 9, CYAN, '※1', { weight: 700 })}
  ${text(title + 26, 20, 8, MOSS, 'UNIT TRACE', { face: 'sans', weight: 800, spacing: 1.5 })}
  ${text(width, 21, 15, VERDICT_COLOR[decision], `状況　${VERDICT_TEXT[decision]}`, { anchor: 'end', weight: 800 })}
  <line x1="0" y1="32" x2="${width}" y2="32" stroke="${MOSS}"/>
  <rect x="${trackX - 4}" y="${LANE_TOP - 2}" width="${columns * STEP + 8}" height="${3 * LANE_H}" fill="url(#grid)" stroke="${MOSS}" stroke-width="1"/>
  ${lanes}
  ${tape}
  ${text(trackX + columns * STEP + 4, LANE_TOP - 6, 7, MOSS, 'LATEST ▾', { anchor: 'end', face: 'sans', weight: 800, spacing: 1 })}
  <polyline points="6,${LANE_TOP + 3 * LANE_H - 4} 6,${TAPE_Y + 30} 10,${TAPE_Y + 30}" fill="none" stroke="${CYAN}" stroke-width="1"/>
  ${notes}`
}

const ROW_H = 22

// 電脳ログ。端末のコード表示のように等幅で並べ、幅に収まる文字数で対象を切り詰める
const log = (list: readonly LogEntry[], origin: number, width: number, rows: number): string => {
  const head = `${tag(0, 4, 20, 13, GREEN, VOID, '電脳ログ')}${text(width, 20, 8, MOSS, 'DIVE LOG', { anchor: 'end', face: 'sans', weight: 800, spacing: 1.5 })}
  <line x1="0" y1="32" x2="${width}" y2="32" stroke="${MOSS}"/>`
  if (list.length === 0) {
    return `${head}${text(0, 58, 12, MOSS, '接続記録なし。指示を入力すると、ツールの実行がここに記録されます。')}${text(0, 80, 12, GREEN, '&gt; _', { face: 'mono' })}`
  }
  // 列の左端。経過時刻は「T+120:00」の8文字まで入る幅を取る
  const UNIT_X = 70
  const VERDICT_X = 140
  const TOOL_X = 196
  const CHAR = 7.3
  const room = Math.max(8, Math.floor((width - TOOL_X - 12) / CHAR))
  const lines = list
    .slice(-rows)
    .map((one, i) => {
      const y = 54 + i * ROW_H
      const summary = clip(one.summary.replace(/\s+/g, ' '), room - one.tool.length - 1)
      return `${text(0, y, 12, MOSS, elapsed(origin, one.at), { face: 'mono', weight: 500 })}
  ${text(UNIT_X, y, 12, GREEN, one.unit, { face: 'mono', weight: 700 })}
  ${text(VERDICT_X, y, 13, VERDICT_COLOR[one.verdict], VERDICT_TEXT[one.verdict], { weight: 800 })}
  ${text(TOOL_X, y, 12, GREEN, xml(one.tool), { face: 'mono', weight: 700 })}
  ${text(TOOL_X + one.tool.length * CHAR + CHAR, y, 12, PAPER, xml(summary), { face: 'mono', weight: 400 })}`
    })
    .join('')
  return `${head}${lines}`
}

// 座標系の幅。中くらい・狭いときは電脳ログの文字が読める大きさになる幅にする
const BOARD_W: Record<Layout, number> = { wide: 1228, medium: 600, narrow: 400 }

type Frame = { traceW: number; logX: number; logY: number; logW: number }

const frameOf = (layout: Layout): Frame => {
  const width = BOARD_W[layout]
  if (layout === 'wide') {
    const traceW = 640
    return { traceW, logX: 8 + traceW + 24, logY: 4, logW: width - traceW - 40 }
  }
  return { traceW: width - 16, logX: 8, logY: TRACE_H + 16, logW: width - 16 }
}

const LOG_HEAD = 56

// wide: 作業班トレースの右に電脳ログ。medium・narrow: トレースの下に電脳ログ
export const boardSvg = (
  state: Units,
  decision: Verdict,
  list: readonly LogEntry[],
  origin: number,
  layout: Layout,
  drawWidth: number,
  rows: number,
): { source: string; width: number; height: number } => {
  const width = BOARD_W[layout]
  const { traceW, logX, logY, logW } = frameOf(layout)
  const logH = LOG_HEAD + rows * ROW_H
  const height = layout === 'wide' ? Math.max(TRACE_H + 8, logY + logH) : logY + logH
  const size = svgSize(drawWidth, width, height)
  const source = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${size.width}" height="${size.height}" style="background:${VOID}">
  <rect width="${width}" height="${height}" fill="${VOID}"/>
  <defs>${crtDefs()}</defs>
  <g transform="translate(8 4)">${trace(state, decision, list, traceW)}</g>
  <g transform="translate(${logX} ${logY})">${log(list, origin, logW, rows)}</g>
  ${scanlines(width, height)}
</svg>`
  return { source, ...size }
}

// 電脳ログに何行出すか。パネルの残りの高さを埋める行数にする
export const logRowsFor = (layout: Layout, drawWidth: number, paneHeight: number, powerHeight: number): number => {
  const scale = drawWidth / BOARD_W[layout]
  const { logY } = frameOf(layout)
  const room = (paneHeight - powerHeight) / scale - logY - LOG_HEAD
  const fit = Math.floor(room / ROW_H)
  const least = layout === 'wide' ? Math.ceil((TRACE_H - LOG_HEAD) / ROW_H) : 6
  return Math.max(least, Math.min(40, fit))
}
