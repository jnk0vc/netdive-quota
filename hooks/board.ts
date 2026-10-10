import type { Escort, LogEntry, UnitName, Units, Verdict } from '../types'
import { ticker, tickerWidth } from './motion'
import { AMBER, GREEN, MOSS, PAPER, RED, VOID, clip, crtDefs, scanlines, svgSize, tag, tagWidth, text, textWidth, xml } from './palette'
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

// 動きに使う、描画の時点の情報。nowは経過時間の時計の起点、freshIdは今回新しく増えた(打刻する)ログのid
export type BoardMotion = { now: number; freshId?: string }

// ── オシロスコープ ────────────────────────────────────────
// 作業班トレースの見出しに、状況に応じた波形を流し続ける。
// 1周期ぶんの波形を2周期つなげ、1周期ぶん左へずらすのを繰り返すと、切れ目なく右から左へ流れて見える。
// 波形の両端は必ず中心線に置き、周期の継ぎ目が段差にならないようにする

type Point = [number, number]

const SCOPE_H = 18
// 波形の箱の幅の上限。広い幅で見出しの空きいっぱいに流すと、パネルの中でいちばん目立ってしまう
const SCOPE_MAX_W = 120

const round1 = (n: number): number => +n.toFixed(1)

// 動作中: 平らな線のあいだに、なめらかな波の短い束(交信の塊)が2つ流れる。振れ幅は約3.5
const BURSTS = [
  { from: 0.12, to: 0.42 },
  { from: 0.62, to: 0.8 },
]

const burst = (period: number, mid: number): Point[] => {
  const count = Math.max(2, Math.round(period / 2))
  return Array.from({ length: count + 1 }, (_, i): Point => {
    const at = i / count
    const one = BURSTS.find(b => at > b.from && at < b.to)
    if (one === undefined) return [round1(at * period), mid]
    // 束の両端で振れ幅を0に落とし、平らな線へなめらかにつなぐ
    const fade = Math.sin(((at - one.from) / (one.to - one.from)) * Math.PI)
    return [round1(at * period), round1(mid + Math.sin((at * period * 2 * Math.PI) / 8) * 3.5 * fade)]
  })
}

// 遮断: 平らな線に、ときおり鋭いスパイクが立つ
const spiked = (period: number, mid: number): Point[] => {
  const spike = (at: number, up: number, down: number): Point[] => [
    [round1(at - 2), mid],
    [round1(at), mid - up],
    [round1(at + 2), mid + down],
    [round1(at + 4), mid],
  ]
  return [[0, mid], ...spike(period * 0.3, 5, 3), ...spike(period * 0.74, 4, 2), [period, mid]]
}

// 平常: 振れ幅1ほどのさざ波に、1周期に1回、心拍のような山が立つ
const RIPPLE = [0, 0.5, 1, 0.5, 0, -0.5, -1, -0.5]
const BEAT: Point[] = [[-14, 0], [-11, -1], [-8, 0], [-3, 0], [-1, 1], [0, -5], [2, 3.5], [4, 0], [9, 0], [13, -1.5], [17, 0]]

const calm = (period: number, mid: number): Point[] => {
  const beat = period / 2
  const count = Math.max(2, Math.round(period / 4))
  const ripple = Array.from({ length: count + 1 }, (_, i): Point => {
    if (i === 0 || i === count) return [i === 0 ? 0 : period, mid]
    return [round1((i * period) / count), mid + RIPPLE[i % RIPPLE.length]!]
  }).filter(([x]) => x < beat - 16 || x > beat + 20 || x === 0 || x === period)
  const blip = BEAT.map(([dx, dy]): Point => [round1(beat + dx), mid + dy]).filter(([x]) => x > 0 && x < period)
  return [...ripple, ...blip].sort((a, b) => a[0] - b[0])
}

// speedは流れる速さ(px/秒)。箱の幅で周期の秒数を決めると、広い箱ほど速く流れてしまう
const WAVES: Record<Verdict, { color: string; speed: number; points: (period: number, mid: number) => Point[] }> = {
  running: { color: AMBER, speed: 36, points: burst },
  denied: { color: RED, speed: 24, points: spiked },
  approved: { color: GREEN, speed: 18, points: calm },
  idle: { color: GREEN, speed: 18, points: calm },
}

// 波形の箱。xは左端、yは上端、wは幅。1周期を箱の幅にする。clipPathのidはSVGの中で唯一にする
const scope = (decision: Verdict, x: number, y: number, w: number): string => {
  const { color, speed, points } = WAVES[decision]
  const seconds = round1(w / speed)
  const mid = y + SCOPE_H / 2
  const period = points(w, mid)
  // 2周期目は1周期目を右へw移す。継ぎ目の点は重なるので1つ省く
  const [start, ...rest] = [...period, ...period.slice(1).map(([px, py]): Point => [round1(px + w), py])].map(
    ([px, py]) => `${round1(px + x)},${py}`,
  )
  return `<clipPath id="scope-clip"><rect x="${x}" y="${y}" width="${w}" height="${SCOPE_H}"/></clipPath>
  <rect x="${x}" y="${y}" width="${w}" height="${SCOPE_H}" fill="none" stroke="${MOSS}" stroke-width="1" stroke-dasharray="2 2"/>
  <line x1="${x}" y1="${mid}" x2="${x + w}" y2="${mid}" stroke="${MOSS}" stroke-width="0.8" opacity="0.5"/>
  <g clip-path="url(#scope-clip)"><path d="M${start} L${rest.join(' ')}" fill="none" stroke="${color}" stroke-width="1" stroke-linejoin="round" opacity="0.85"><animateTransform attributeName="transform" type="translate" from="0 0" to="${-w} 0" dur="${seconds}s" repeatCount="indefinite"/></path></g>`
}

// ── 作業班トレース ────────────────────────────────────────
// 3班を横長のレーンに並べ、ツールの実行を1回1列で打刻する。右端が最新。
// その下に随伴機(サブエージェント)のレーンを足し、その機体が行った実行を同じ列に重ねて打刻する。
// 列の下には通し番号の目盛りを振る

const LANE_TOP = 46
const LANE_H = 40
const STEP = 12
// 随伴機のレーンの上の見出し行の高さ
const ESCORT_HEAD = 22
const ESCORT_SLOTS = 3

// 実行中の機体を先に、そのあとに新しい順で、最大3機を出す
export const escortsShown = (escorts: readonly Escort[]): Escort[] =>
  [...escorts]
    .reverse()
    .sort((a, b) => Number(b.verdict === 'running') - Number(a.verdict === 'running'))
    .slice(0, ESCORT_SLOTS)

const tapeY = (escortCount: number): number => LANE_TOP + 3 * LANE_H + ESCORT_HEAD + escortCount * LANE_H

// 目盛りの番号(目盛りの18px下)まで入る高さ
export const traceHeight = (escortCount: number): number => tapeY(escortCount) + 26

// claude-haiku-4-5-20251001 → haiku-4-5
export const shortModel = (model: string): string => model.replace(/^claude-/, '').replace(/-\d{8}$/, '')

type Lane = {
  label: string
  english: string
  isEscort: boolean
  verdict: Verdict
  detail: string
  hits: (one: LogEntry) => boolean
}

const trace = (
  state: Units,
  decision: Verdict,
  list: readonly LogEntry[],
  escorts: readonly Escort[],
  width: number,
  motion?: BoardMotion,
): string => {
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
  const shown = escortsShown(escorts)
  const tapeTop = tapeY(shown.length)
  const escortTop = LANE_TOP + 3 * LANE_H + ESCORT_HEAD

  const unitLanes: Lane[] = UNIT_NAMES.map(name => ({
    label: UNIT_LABEL[name],
    english: name,
    isEscort: false,
    verdict: state[name].verdict,
    detail: `${clip(state[name].tool || '------', 12)}${state[name].count ? ` ×${state[name].count}` : ''}`,
    hits: one => one.unit === name,
  }))
  const escortLanes: Lane[] = shown.map(escort => ({
    label: clip(escort.type, 10),
    english: clip(escort.description, 9),
    isEscort: true,
    verdict: escort.verdict,
    detail: `${clip(shortModel(escort.model), 12)}${escort.count ? ` ×${escort.count}` : ''}`,
    hits: one => one.agentId === escort.id,
  }))

  const lane = (one: Lane, y: number): string => {
    const color = VERDICT_COLOR[one.verdict]
    const marks = recent
      .map((entry, i) => {
        if (!one.hits(entry)) return ''
        const pulse =
          entry.verdict === 'running'
            ? '<animate attributeName="opacity" values="1;0.25;1" dur="0.7s" repeatCount="indefinite"/>'
            : ''
        return `<rect x="${columnX(i) + 2}" y="${y + 6}" width="${STEP - 4}" height="${LANE_H - 16}" fill="${VERDICT_COLOR[entry.verdict]}">${pulse}</rect>`
      })
      .join('')
    // 班の名前は反転表示、随伴機の名前は縁取りだけにして区別する
    const label = one.isEscort
      ? `<rect x="0" y="${y + 4}" width="${labelW - 8}" height="18" fill="none" stroke="${GREEN}" stroke-width="1"/>${text(5, y + 17, 9, GREEN, xml(one.label), { face: 'sans', weight: 800, spacing: 0.4 })}
  ${text(0, y + 34, 8, MOSS, xml(one.english))}`
      : `${tag(0, y + 4, 18, 12, GREEN, VOID, one.label)}
  ${text(0, y + 34, 8, MOSS, one.english, { face: 'sans', weight: 800, spacing: 1.2 })}`
    return `${label}
  <line x1="${trackX}" y1="${y + LANE_H / 2 - 2}" x2="${trackX + columns * STEP}" y2="${y + LANE_H / 2 - 2}" stroke="${MOSS}" stroke-width="1" stroke-dasharray="1 3"/>
  <g filter="url(#glow)">${marks}</g>
  ${text(width, y + 18, 14, color, VERDICT_TEXT[one.verdict], { anchor: 'end', weight: 800 })}
  ${text(width, y + 32, 9, one.verdict === 'idle' ? MOSS : PAPER, xml(one.detail), { anchor: 'end', face: 'mono', weight: 500 })}`
  }

  const lanes = [
    ...unitLanes.map((one, row) => lane(one, LANE_TOP + row * LANE_H)),
    ...escortLanes.map((one, row) => lane(one, escortTop + row * LANE_H)),
  ].join('')
  const escortHead = `${text(0, escortTop - 7, 10, GREEN, '随伴機', { weight: 800 })}
  ${text(36, escortTop - 7, 7, MOSS, 'SUB-AGENTS', { face: 'sans', weight: 800, spacing: 1.2 })}
  ${text(width, escortTop - 7, 9, MOSS, escorts.length === 0 ? '出撃なし' : `出撃 ${escorts.length}機`, { anchor: 'end' })}
  <line x1="0" y1="${escortTop - 3}" x2="${width}" y2="${escortTop - 3}" stroke="${MOSS}" stroke-dasharray="2 3"/>`

  // 通し番号の目盛り。5回ごとに長い目盛りと番号を付ける
  const tape = Array.from({ length: columns }, (_, c) => {
    const i = c - shift
    const seq = i >= 0 ? total - (recent.length - 1 - i) : undefined
    const x = trackX + c * STEP + STEP / 2
    const isMajor = seq !== undefined && seq % 5 === 0
    return `<line x1="${x}" y1="${tapeTop}" x2="${x}" y2="${tapeTop + (isMajor ? 8 : 4)}" stroke="${MOSS}" stroke-width="1"/>${
      isMajor ? text(x, tapeTop + 18, 8, MOSS, `#${seq}`, { anchor: 'middle', face: 'mono', weight: 500 }) : ''
    }`
  }).join('')

  const title = tagWidth(13, '作業班トレース')
  const escortFrame = shown.length
    ? `<rect x="${trackX - 4}" y="${escortTop}" width="${columns * STEP + 8}" height="${shown.length * LANE_H}" fill="url(#grid)" stroke="${MOSS}" stroke-width="1"/>`
    : ''
  // 見出しの「UNIT TRACE」と右寄せの「状況」のあいだの空きに、オシロスコープを置く。
  // 両方の幅を見積もり、空きが48px未満なら置かない。幅はSCOPE_MAX_Wまでにして、「状況」の文字の左に寄せる
  const status = `状況　${VERDICT_TEXT[decision]}`
  const labelEnd = title + 8 + textWidth('UNIT TRACE', 8, 1.5)
  const gap = width - textWidth(status, 15) - labelEnd
  const scopeW = Math.min(SCOPE_MAX_W, Math.floor(gap - 16))
  return `${tag(0, 4, 20, 13, GREEN, VOID, '作業班トレース')}
  ${text(title + 8, 20, 8, MOSS, 'UNIT TRACE', { face: 'sans', weight: 800, spacing: 1.5 })}
  ${gap < 48 ? '' : scope(decision, Math.round(labelEnd + 8 + Math.floor(gap - 16) - scopeW), 6, scopeW)}
  ${text(width, 21, 15, VERDICT_COLOR[decision], status, { anchor: 'end', weight: 800 })}
  <line x1="0" y1="32" x2="${width}" y2="32" stroke="${MOSS}"/>
  <rect x="${trackX - 4}" y="${LANE_TOP - 2}" width="${columns * STEP + 8}" height="${3 * LANE_H}" fill="url(#grid)" stroke="${MOSS}" stroke-width="1"/>
  ${escortFrame}
  ${escortHead}
  ${lanes}
  ${tape}
  ${text(trackX + columns * STEP + 4, LANE_TOP - 6, 7, MOSS, 'LATEST ▾', { anchor: 'end', face: 'sans', weight: 800, spacing: 1 })}`
}

const ROW_H = 22

// 列の左端。経過時刻は「T+120:00」の8文字まで入る幅を取る
const UNIT_X = 70
const VERDICT_X = 140
const TOOL_X = 196
// 等幅の1文字ぶんの幅。全角の文字だけは文字の大きさ(12px)いっぱいを取る
const CHAR = 7.3
const advanceOf = (char: string): number => ((char.codePointAt(0) ?? 0) >= 0x2e80 ? 12 : CHAR)

// 最新の行の仕上げ。対象の文字のすぐ右に、ゆっくり明暗する緑の四角いカーソルを置く。
// 点いたり消えたりする点滅はチラつきに見えるので、消し切らずに明暗させる。
// isFreshのとき(今回増えた行)は、さらに打ち込みの演出を重ねる。
//   地の色の覆いが対象の左端から1文字ずつ右へ動いて文字を現し、先頭には緑のカーソルが付く。
//   1文字あたり0.03秒で、全体は0.6秒までに収める。明暗するカーソルは打ち終わってから現れる
const newestRow = (row: string, tool: string, summary: string, y: number, width: number, isFresh: boolean): string => {
  // 各文字の手前の位置。最後は文字列の右端
  let at = TOOL_X
  const stops = [at, ...[...`${tool} ${summary}`].map(char => (at += advanceOf(char)))]
  const typing = isFresh ? +(stops.length * Math.min(0.03, 0.6 / stops.length)).toFixed(2) : 0
  const blink = `<rect x="${round1(at + 1)}" y="${y - 11}" width="${CHAR}" height="14" fill="${GREEN}"${isFresh ? ' visibility="hidden"' : ''}>${
    isFresh ? `<set attributeName="visibility" to="visible" begin="${typing}s"/>` : ''
  }<animate attributeName="opacity" values="0.9;0.3;0.9" dur="2.4s"${isFresh ? ` begin="${typing}s"` : ''} repeatCount="indefinite"/></rect>`
  if (!isFresh) return `${row}${blink}`
  const move = `<animate attributeName="x" calcMode="discrete" values="${stops.map(round1).join(';')}" dur="${typing}s" fill="freeze"/>`
  const cover = `<rect x="${TOOL_X}" y="${y - 13}" width="${width - TOOL_X}" height="19" fill="${VOID}">${move}</rect>`
  const lead = `<rect x="${TOOL_X}" y="${y - 11}" width="${CHAR}" height="14" fill="${GREEN}">${move}<set attributeName="visibility" to="hidden" begin="${typing}s"/></rect>`
  return `${row}${cover}${lead}${blink}`
}

// 電脳ログ。端末のコード表示のように等幅で並べ、幅に収まる文字数で対象を切り詰める。
// motionを渡すと、見出しに経過時間の時計を出し、今回増えた行を打ち込んで見せる
const log = (list: readonly LogEntry[], origin: number, width: number, rows: number, motion?: BoardMotion): string => {
  // 経過時間の時計は「DIVE LOG」の左に置く。起点(セッションの開始)が分からないときは出さない
  const clock =
    motion !== undefined && origin > 0
      ? (() => {
          const seconds = Math.max(0, Math.floor((motion.now - origin) / 1000))
          return ticker(seconds, round1(width - textWidth('DIVE LOG', 8, 1.5) - 10 - tickerWidth(seconds, 11)), 20, 11, GREEN)
        })()
      : ''
  const head = `${tag(0, 4, 20, 13, GREEN, VOID, '電脳ログ')}${text(width, 20, 8, MOSS, 'DIVE LOG', { anchor: 'end', face: 'sans', weight: 800, spacing: 1.5 })}${clock}
  <line x1="0" y1="32" x2="${width}" y2="32" stroke="${MOSS}"/>`
  if (list.length === 0) {
    return `${head}${text(0, 58, 12, MOSS, '接続記録なし。指示を入力すると、ツールの実行がここに記録されます。')}${text(0, 80, 12, GREEN, '&gt; _', { face: 'mono' })}`
  }
  const room = Math.max(8, Math.floor((width - TOOL_X - 12) / CHAR))
  const shown = list.slice(-rows)
  const lines = shown
    .map((one, i) => {
      const y = 54 + i * ROW_H
      const summary = clip(one.summary.replace(/\s+/g, ' '), room - one.tool.length - 1)
      const row = `${text(0, y, 12, MOSS, elapsed(origin, one.at), { face: 'mono', weight: 500 })}
  ${text(UNIT_X, y, 12, GREEN, one.unit, { face: 'mono', weight: 700 })}
  ${text(VERDICT_X, y, 13, VERDICT_COLOR[one.verdict], VERDICT_TEXT[one.verdict], { weight: 800 })}
  ${text(TOOL_X, y, 12, GREEN, xml(one.tool), { face: 'mono', weight: 700 })}
  ${text(TOOL_X + one.tool.length * CHAR + CHAR, y, 12, PAPER, xml(summary), { face: 'mono', weight: 400 })}`
      return i === shown.length - 1 ? newestRow(row, one.tool, summary, y, width, motion?.freshId === one.id) : row
    })
    .join('')
  return `${head}${lines}`
}

// 座標系の幅。中くらい・狭いときは電脳ログの文字が読める大きさになる幅にする
const BOARD_W: Record<Layout, number> = { wide: 1228, medium: 600, narrow: 400 }

type Frame = { traceW: number; traceH: number; logX: number; logY: number; logW: number }

const frameOf = (layout: Layout, escortCount: number): Frame => {
  const width = BOARD_W[layout]
  const traceH = traceHeight(escortCount)
  if (layout === 'wide') {
    const traceW = 640
    return { traceW, traceH, logX: 8 + traceW + 24, logY: 4, logW: width - traceW - 40 }
  }
  return { traceW: width - 16, traceH, logX: 8, logY: traceH + 16, logW: width - 16 }
}

const LOG_HEAD = 56

// wide: 作業班トレースの右に電脳ログ。medium・narrow: トレースの下に電脳ログ。
// motionを渡すと、経過時間の時計と、新しい行の打ち込みと打刻の光を加える(オシロスコープと点滅のカーソルは常に動く)
export const boardSvg = (
  state: Units,
  decision: Verdict,
  list: readonly LogEntry[],
  escorts: readonly Escort[],
  origin: number,
  layout: Layout,
  drawWidth: number,
  rows: number,
  motion?: BoardMotion,
): { source: string; width: number; height: number } => {
  const width = BOARD_W[layout]
  const { traceW, traceH, logX, logY, logW } = frameOf(layout, escortsShown(escorts).length)
  const logH = LOG_HEAD + rows * ROW_H
  const height = layout === 'wide' ? Math.max(traceH + 8, logY + logH) : logY + logH
  const size = svgSize(drawWidth, width, height)
  const source = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${size.width}" height="${size.height}" style="background:${VOID}">
  <rect width="${width}" height="${height}" fill="${VOID}"/>
  <defs>${crtDefs()}</defs>
  <g transform="translate(8 4)">${trace(state, decision, list, escorts, traceW, motion)}</g>
  <g transform="translate(${logX} ${logY})">${log(list, origin, logW, rows, motion)}</g>
  ${scanlines(width, height)}
</svg>`
  return { source, ...size }
}

// 電脳ログに何行出すか。パネルの残りの高さ(タイマーと計器の下)を埋める行数にする
export const logRowsFor = (
  layout: Layout,
  drawWidth: number,
  paneHeight: number,
  aboveHeight: number,
  escorts: readonly Escort[],
): number => {
  const scale = drawWidth / BOARD_W[layout]
  const { traceH, logY } = frameOf(layout, escortsShown(escorts).length)
  const room = (paneHeight - aboveHeight) / scale - logY - LOG_HEAD
  const fit = Math.floor(room / ROW_H)
  const least = layout === 'wide' ? Math.ceil((traceH - LOG_HEAD) / ROW_H) : 6
  return Math.max(least, Math.min(40, fit))
}
