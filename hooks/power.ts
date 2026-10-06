import type { ContextGauge, Limit, MemoryMap, MemorySlice } from '../types'
import { AMBER, CYAN, DARK, DIM, GREEN, GROUND, LIT, PAPER, VOID, clip, crtDefs, scanlines, svgSize, tag, tagWidth, text, xml } from './palette'
import type { Layout } from './palette'

const HOUR = 3_600_000
const DAY = 24 * HOUR
const SLOTS = 3

// 利用枠の種類を、パネルに出す呼び名にする。知らない種類はそのまま出す
export const labelOf = (kind: string): string => {
  if (kind === 'five_hour') return '5時間枠'
  if (kind === 'spend_limit') return '利用上限額'
  const model = /fable|opus|sonnet|haiku/i.exec(kind)?.[0]
  if (model) return `${model[0]!.toUpperCase()}${model.slice(1).toLowerCase()}週次`
  if (kind.startsWith('seven_day')) return '週次'
  return kind
}

const englishOf = (kind: string): string => {
  if (kind === 'five_hour') return 'FIVE-HOUR WINDOW'
  if (kind === 'spend_limit') return 'SPEND LIMIT'
  const model = /fable|opus|sonnet|haiku/i.exec(kind)?.[0]
  if (model) return `${model.toUpperCase()} WEEKLY`
  return kind.startsWith('seven_day') ? 'WEEKLY WINDOW' : kind.toUpperCase()
}

// リングの中に反転表示する回線番号。5時間枠はL-05、週次はL-07、モデル別の週次は頭文字を足す
const codeOf = (kind: string): string => {
  if (kind === 'five_hour') return 'L-05'
  if (kind === 'spend_limit') return 'L-$$'
  const model = /fable|opus|sonnet|haiku/i.exec(kind)?.[0]
  if (kind.startsWith('seven_day')) return model ? `L-07${model[0]!.toUpperCase()}` : 'L-07'
  return 'L-XX'
}

const windowMs = (kind: string): number | undefined =>
  kind === 'five_hour' ? 5 * HOUR : kind.startsWith('seven_day') ? 7 * DAY : undefined

const resetOf = (limit: Limit): number | undefined => {
  const at = limit.resetsAt ? Date.parse(limit.resetsAt) : Number.NaN
  return Number.isNaN(at) ? undefined : at
}

export type Mode = 'halt' | 'low' | 'sync' | 'overrun'

const MODES: { mode: Mode; label: string }[] = [
  { mode: 'halt', label: 'HALT' },
  { mode: 'low', label: 'LOW' },
  { mode: 'sync', label: 'SYNC' },
  { mode: 'overrun', label: 'OVERRUN' },
]

const modeLabel = (mode: Mode): string => MODES.find(one => one.mode === mode)?.label ?? mode

type Reading = {
  mode: Mode
  // 7セグメントが数え下ろす残り時間。undefinedなら「-:--」
  ms: number | undefined
  isDanger: boolean
  caption: string
  captionEn: string
  // 数値が何を数えているかの注釈。引き出し線の先に添える
  note: string
}

// 枠の開始からの消費ペースで、HALT・LOW・SYNC・OVERRUNの4段階に振り分ける
export const readingOf = (limit: Limit, now: number): Reading => {
  const reset = resetOf(limit)
  const untilReset = reset === undefined ? undefined : Math.max(0, reset - now)
  if (limit.percentUsed >= 100) {
    return {
      mode: 'halt',
      ms: 0,
      isDanger: true,
      caption: '電脳停止',
      captionEn: 'SYSTEM DOWN',
      note: '※ 枠のリセットまで使用できません',
    }
  }
  const relink = { caption: '再接続まで', captionEn: 'RE-LINK IN', note: '※ 今のペースなら枠のリセットまで持ちます' }
  const length = windowMs(limit.kind)
  const elapsed = reset !== undefined && length !== undefined ? now - (reset - length) : undefined
  if (elapsed !== undefined && elapsed >= 60_000 && limit.percentUsed > 0 && reset !== undefined) {
    const hitAt = now + ((100 - limit.percentUsed) / limit.percentUsed) * elapsed
    if (hitAt < reset) {
      const ms = hitAt - now
      return {
        mode: 'overrun',
        ms,
        isDanger: ms < 30 * 60_000 || limit.percentUsed >= 90,
        caption: '電脳限界まで',
        captionEn: 'LIMIT ETA',
        note: '※ 今の消費ペースで使い切るまでの見込み',
      }
    }
    // 枠の経過割合に対して、使用率がその半分に満たなければLOW
    const pace = limit.percentUsed / ((elapsed / length!) * 100)
    return { mode: pace < 0.5 ? 'low' : 'sync', ms: untilReset, isDanger: limit.percentUsed >= 90, ...relink }
  }
  return { mode: 'sync', ms: untilReset, isDanger: limit.percentUsed >= 90, ...relink }
}

export const untilText = (ms: number): string => {
  const minutes = Math.max(0, Math.round(ms / 60_000))
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  if (days > 0) return `あと${days}日${hours}時間`
  return hours > 0 ? `あと${hours}時間${minutes % 60}分` : `あと${minutes % 60}分`
}

// ── 7セグメント ──────────────────────────────────────────
// 消灯した区画も暗く残し、液晶表示のように桁の形が透けて見えるようにする

const SEGMENTS: Record<string, string> = {
  '0': 'abcdef', '1': 'bc', '2': 'abged', '3': 'abgcd', '4': 'fgbc',
  '5': 'afgcd', '6': 'afgedc', '7': 'abc', '8': 'abcdefg', '9': 'abcdfg', '-': 'g',
}
const SEGMENT_NAMES = ['a', 'b', 'c', 'd', 'e', 'f', 'g'] as const

type Glyph = { w: number; h: number; t: number }

const segmentPoints = (name: string, x: number, y: number, { w, h, t }: Glyph): string => {
  const half = t / 2
  const inner = w - t
  const leg = (h - 3 * t) / 2 + t
  const across = (x0: number, y0: number) =>
    `${x0},${y0} ${x0 + half},${y0 - half} ${x0 + inner - half},${y0 - half} ${x0 + inner},${y0} ${x0 + inner - half},${y0 + half} ${x0 + half},${y0 + half}`
  const down = (x0: number, y0: number) =>
    `${x0},${y0} ${x0 + half},${y0 + half} ${x0 + half},${y0 + leg - half} ${x0},${y0 + leg} ${x0 - half},${y0 + leg - half} ${x0 - half},${y0 + half}`
  const left = x + half
  const right = x + w - half
  const top = y + half
  const middle = y + h / 2
  const bottom = y + h - half
  switch (name) {
    case 'a': return across(left, top)
    case 'g': return across(left, middle)
    case 'd': return across(left, bottom)
    case 'f': return down(left, top)
    case 'b': return down(right, top)
    case 'e': return down(left, middle)
    default: return down(right, middle)
  }
}

const staticDigit = (char: string, x: number, y: number, glyph: Glyph): string => {
  const lit = SEGMENTS[char] ?? ''
  return SEGMENT_NAMES.map(
    name => `<polygon points="${segmentPoints(name, x, y, glyph)}" fill="${lit.includes(name) ? LIT : DARK}"/>`,
  ).join('')
}

// 数え下ろす1桁。残り秒数Rのとき floor((R mod modulo) / divisor) を表示する。
// 再描画せずに秒を進めるため、各区画の点灯をSMILの離散アニメーションで切り替える
const countingDigit = (seconds: number, divisor: number, modulo: number, x: number, y: number, glyph: Glyph): string => {
  const steps = modulo / divisor
  const offset = modulo - 1 - (seconds % modulo)
  const keyTimes = Array.from({ length: steps }, (_, i) => (i / steps).toFixed(5)).join(';')
  return SEGMENT_NAMES.map(name => {
    const values = Array.from({ length: steps }, (_, i) =>
      (SEGMENTS[String(steps - 1 - i)] ?? '').includes(name) ? LIT : DARK,
    )
    const points = segmentPoints(name, x, y, glyph)
    if (values.every(value => value === values[0])) {
      return `<polygon points="${points}" fill="${values[0]}"/>`
    }
    return `<polygon points="${points}" fill="${DARK}"><animate attributeName="fill" calcMode="discrete" values="${values.join(';')}" keyTimes="${keyTimes}" dur="${modulo}s" begin="${-offset}s" repeatCount="indefinite"/></polygon>`
  }).join('')
}

const colon = (x: number, y: number, h: number, size: number): string =>
  `<rect x="${x}" y="${y + h * 0.28}" width="${size}" height="${size}" fill="${LIT}"/><rect x="${x}" y="${y + h * 0.66}" width="${size}" height="${size}" fill="${LIT}"/>`

const BIG: Glyph = { w: 32, h: 66, t: 7 }
const SMALL: Glyph = { w: 16, h: 32, t: 4 }
const BIG_STEP = BIG.w + 8
const SMALL_STEP = SMALL.w + 5
// 液晶表示のようにわずかに右へ傾ける
const SLANT = 'skewX(-6)'

const zeros = (): string =>
  `${staticDigit('0', 0, 0, BIG)}${colon(BIG_STEP + 1, 0, BIG.h, 7)}${staticDigit('0', BIG_STEP + 14, 0, BIG)}${staticDigit('0', 2 * BIG_STEP + 14, 0, BIG)}`

// 大きい「時:分」と小さい「:秒」を組む
const clock = (ms: number | undefined, x: number, y: number, maxWidth: number): string => {
  if (ms === undefined) {
    return `<g transform="translate(${x} ${y}) ${SLANT}">${staticDigit('-', 0, 0, BIG)}${colon(BIG_STEP + 1, 0, BIG.h, 7)}${staticDigit('-', BIG_STEP + 14, 0, BIG)}${staticDigit('-', 2 * BIG_STEP + 14, 0, BIG)}</g>`
  }
  const seconds = Math.max(0, Math.floor(ms / 1000))
  const hourDigits = Math.max(1, String(Math.floor(seconds / 3600)).length)
  const parts: string[] = []
  let cursor = 0
  for (let i = hourDigits - 1; i >= 0; i -= 1) {
    const divisor = 3600 * 10 ** i
    parts.push(countingDigit(seconds, divisor, divisor * 10, cursor, 0, BIG))
    cursor += BIG_STEP
  }
  parts.push(colon(cursor + 1, 0, BIG.h, 7))
  cursor += 14
  parts.push(countingDigit(seconds, 600, 3600, cursor, 0, BIG))
  cursor += BIG_STEP
  parts.push(countingDigit(seconds, 60, 600, cursor, 0, BIG))
  cursor += BIG_STEP
  const smallY = BIG.h - SMALL.h
  parts.push(colon(cursor, smallY, SMALL.h, 4))
  cursor += 8
  parts.push(countingDigit(seconds, 10, 60, cursor, smallY, SMALL))
  cursor += SMALL_STEP
  parts.push(countingDigit(seconds, 1, 10, cursor, smallY, SMALL))
  cursor += SMALL.w
  const scale = Math.min(1, maxWidth / cursor)
  const frame = `translate(${x} ${y}) scale(${scale}) ${SLANT}`
  if (seconds === 0) {
    return `<g transform="${frame}"><g>${zeros()}<animate attributeName="opacity" values="1;0.15;1" dur="0.8s" repeatCount="indefinite"/></g></g>`
  }
  // 0に達したら数え下ろしを止め、0を点滅させる
  const zero = `<g display="none">${zeros()}<set attributeName="display" to="inline" begin="${seconds}s"/><animate attributeName="opacity" values="1;0.15;1" dur="0.8s" begin="${seconds}s" repeatCount="indefinite"/></g>`
  return `<g transform="${frame}"><g>${parts.join('')}<set attributeName="display" to="none" begin="${seconds}s"/></g>${zero}</g>`
}

// ── 扇形セグメントのリングゲージ ─────────────────────────────
// 36区画の輪で残量を示す。点灯区画は真上から時計回りに並べ、中央に回線番号と数値を出す

const RING_SEGMENTS = 36

const xy = (cx: number, cy: number, r: number, degree: number): [string, string] => {
  const rad = ((degree - 90) * Math.PI) / 180
  return [(cx + r * Math.cos(rad)).toFixed(2), (cy + r * Math.sin(rad)).toFixed(2)]
}

const polar = (cx: number, cy: number, r: number, degree: number): string => xy(cx, cy, r, degree).join(',')

type Ring = { cx: number; cy: number; inner: number; outer: number }

const ring = (
  { cx, cy, inner, outer }: Ring,
  ratio: number | undefined,
  code: string,
  amount: string,
  amountSize: number,
): string => {
  const step = 360 / RING_SEGMENTS
  const lit = ratio === undefined ? 0 : Math.round(Math.max(0, Math.min(1, ratio)) * RING_SEGMENTS)
  const wedges = Array.from({ length: RING_SEGMENTS }, (_, i) => {
    const from = i * step + 1.3
    const to = (i + 1) * step - 1.3
    const points = [polar(cx, cy, outer, from), polar(cx, cy, outer, to), polar(cx, cy, inner, to), polar(cx, cy, inner, from)]
    return `<polygon points="${points.join(' ')}" fill="${i < lit ? LIT : DARK}"/>`
  }).join('')
  const rim = outer + 6
  // 外周の目盛り。90度ごとに長くする
  const ticks = Array.from({ length: 12 }, (_, i) => {
    const [x1, y1] = xy(cx, cy, rim, i * 30)
    const [x2, y2] = xy(cx, cy, rim + (i % 3 === 0 ? 6 : 3), i * 30)
    return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${DIM}" stroke-width="1.2"/>`
  }).join('')
  const codeWidth = tagWidth(8, code, 'sans')
  return `<circle cx="${cx}" cy="${cy}" r="${rim}" fill="none" stroke="${DIM}" stroke-width="1"/>
  <circle cx="${cx}" cy="${cy}" r="${inner - 5}" fill="none" stroke="${DIM}" stroke-width="0.8" stroke-dasharray="1.5 2.5"/>
  ${ticks}
  <g filter="url(#glow)">${wedges}</g>
  ${tag(cx - codeWidth / 2, cy - 15, 12, 8, LIT, GROUND, code, 'sans')}
  ${text(cx, cy + amountSize * 0.55 + 2, amountSize, LIT, amount, { anchor: 'middle', face: 'sans', weight: 800 })}`
}

// ── 1基ぶんの表示内容 ──────────────────────────────────────

// 利用枠のタイマー1基ぶんの表示内容
type Panel = {
  name: string
  english: string
  code: string
  caption: string
  captionEn: string
  digits: (x: number, y: number, maxWidth: number) => string
  ratio: number | undefined
  ringValue: string
  footer: string
  lamps: { label: string; isOn: boolean }[]
  note: string
  isDanger: boolean
  tone: Tone
}

// ── 残量に応じた配色 ──────────────────────────────────────
// 余裕があるうちは燐光の緑、残りが減るにつれて橙、赤へと変える

export type Tone = 'green' | 'amber' | 'red'

// gridは外枠の中に敷く方眼の線の色。地の色からわずかに浮く程度にする
type ToneColors = { lit: string; dark: string; ground: string; dim: string; grid: string; frame: [string, string, string] }

const TONES: Record<Tone, ToneColors> = {
  green: { lit: '#7CFF6B', dark: '#0F3A17', ground: '#041A0A', dim: '#2F8F3A', grid: '#0A2A12', frame: ['#1E7A30', '#7CFF6B', '#D2FFC4'] },
  amber: { lit: '#FFA531', dark: '#3A2108', ground: '#140A02', dim: '#A0601A', grid: '#2A1A06', frame: ['#7CFF6B', '#FFA531', '#FF5A2A'] },
  red: { lit: LIT, dark: DARK, ground: GROUND, dim: DIM, grid: '#2A0A08', frame: ['#FFA531', LIT, '#8A0E08'] },
}

// 残り50%超は緑、20%以上は橙、それ未満と危険時は赤。使い切る見込み(OVERRUN)なら緑にはしない
const toneOf = (left: number | undefined, isDanger: boolean, isOverrun = false): Tone => {
  if (left === undefined) return 'red'
  if (isDanger || left < 20) return 'red'
  return left <= 50 || isOverrun ? 'amber' : 'green'
}

// 赤で描いた1基を、段階の配色に置き換える。警報は点灯時に赤段階になるので置き換えの影響を受けない
const recolor = (svg: string, tone: Tone): string => {
  const colors = TONES[tone]
  return svg
    .split(LIT).join(colors.lit)
    .split(DARK).join(colors.dark)
    .split(GROUND).join(colors.ground)
    .split(DIM).join(colors.dim)
    .split('url(#frame)').join(`url(#frame-${tone})`)
    .split('url(#grid)').join(`url(#grid-${tone})`)
}

// 段階ごとの外枠のグラデーションと方眼。方眼も段階の色にしないと、橙や赤の基の中に緑の線が透ける
const toneDefs = (): string =>
  (Object.keys(TONES) as Tone[])
    .map(tone => {
      const { frame, grid } = TONES[tone]
      const [from, middle, to] = frame
      return `<linearGradient id="frame-${tone}" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stop-color="${from}"/><stop offset="0.55" stop-color="${middle}"/><stop offset="1" stop-color="${to}"/></linearGradient>
  <pattern id="grid-${tone}" width="24" height="24" patternUnits="userSpaceOnUse"><path d="M24 0H0V24" fill="none" stroke="${grid}" stroke-width="1"/></pattern>`
    })
    .join('')

const limitPanel = (limit: Limit, now: number): Panel => {
  const reading = readingOf(limit, now)
  const reset = resetOf(limit)
  const left = Math.max(0, 100 - limit.percentUsed)
  return {
    name: labelOf(limit.kind),
    english: englishOf(limit.kind),
    code: codeOf(limit.kind),
    caption: reading.caption,
    captionEn: reading.captionEn,
    digits: (x, y, maxWidth) => clock(reading.ms, x, y, maxWidth),
    ratio: left / 100,
    ringValue: `${Math.round(left)}%`,
    footer: reset === undefined ? '' : `再接続 ${untilText(reset - now)}`,
    lamps: MODES.map(({ mode, label }) => ({ label, isOn: reading.mode === mode })),
    note: reading.note,
    isDanger: reading.isDanger,
    tone: toneOf(left, reading.isDanger || reading.mode === 'halt', reading.mode === 'overrun'),
  }
}

export const kilo = (tokens: number): string =>
  tokens >= 1_000_000
    ? `${(tokens / 1_000_000).toFixed(1)}M`
    : tokens >= 1000
      ? `${Math.round(tokens / 1000)}k`
      : String(Math.round(tokens))

// コンテキストの使用率で段階を決める。電脳容量マップの最下段のランプに出す
const CONTEXT_STAGES = [
  { label: 'NORMAL', below: 60 },
  { label: 'CAUTION', below: 80 },
  { label: 'CRITICAL', below: 95 },
  { label: 'FULL', below: Number.POSITIVE_INFINITY },
]

// 利用枠のタイマーを、報告された順に最大3基
const panelsOf = (limits: readonly Limit[], now: number): Panel[] =>
  limits.slice(0, SLOTS).map(limit => limitPanel(limit, now))

// ── 部品 ────────────────────────────────────────────────

const BLINK = '<animate attributeName="opacity" values="1;0.3;1" dur="1s" repeatCount="indefinite"/>'

// 点灯時は塗りつぶしに地の色で文字を抜き、消灯時は暗い縁取りだけにする
const lamp = (x: number, y: number, w: number, h: number, label: string, isOn: boolean, size = 9): string =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${isOn ? LIT : 'none'}" stroke="${isOn ? LIT : DARK}" stroke-width="1.2"/>
  ${text(x + w / 2, y + h / 2 + size * 0.36, size, isOn ? GROUND : DIM, label, { anchor: 'middle', face: 'sans', weight: 800, spacing: 0.6 })}`

const alert = (x: number, y: number, w: number, h: number, isOn: boolean, size = 9, label = 'LIMIT ALERT ／ 限界警報'): string =>
  `<g>${lamp(x, y, w, h, label, isOn, size)}${isOn ? BLINK : ''}</g>`

// 上辺の右と下辺の左を斜めに落とした外枠
const plate = (w: number, h: number, cut: number): string =>
  `<polygon points="0,0 ${w - cut},0 ${w},${cut} ${w},${h} ${cut},${h} 0,${h - cut}" fill="${GROUND}" stroke="url(#frame)" stroke-width="2"/>
  <polygon points="0,0 ${w - cut},0 ${w},${cut} ${w},${h} ${cut},${h} 0,${h - cut}" fill="url(#grid)"/>`

// 見出し。名前を反転表示の箱で抜き、英語名と罫線を右へ続ける
const heading = (x: number, y: number, size: number, panel: Panel, lineTo: number): string => {
  const box = tagWidth(size, panel.name)
  const english = x + box + 6
  return `${tag(x, y, size + 7, size, LIT, GROUND, xml(panel.name))}
  ${text(english, y + size * 0.95, size * 0.62, DIM, xml(panel.english), { face: 'sans', weight: 800, spacing: 1 })}
  <line x1="${english + panel.english.length * size * 0.45 + 8}" y1="${y + (size + 7) / 2}" x2="${lineTo}" y2="${y + (size + 7) / 2}" stroke="${DIM}" stroke-width="1"/>`
}

// 欄外の注釈。対象から引き出し線を折り曲げて伸ばし、その先にシアンの小さな文字で補足を書く
const annotate = (fromX: number, fromY: number, x: number, y: number, body: string): string =>
  `<polyline points="${fromX},${fromY} ${fromX},${y - 4} ${x - 4},${y - 4}" fill="none" stroke="${CYAN}" stroke-width="1"/><circle cx="${fromX}" cy="${fromY}" r="1.6" fill="${CYAN}"/>
  ${text(x, y, 10, CYAN, xml(body), { weight: 600 })}`

// ── タイマー1基 ──────────────────────────────────────────

const MODULE_W = 400
const MODULE_H = 214
const GAP = 14

const timerModule = (panel: Panel, x: number, y: number): string => {
  const lamps = panel.lamps.map(({ label, isOn }, i) => lamp(14 + i * 58, 178, 54, 16, label, isOn)).join('')
  return recolor(`<g transform="translate(${x} ${y})">
  ${plate(MODULE_W, MODULE_H, 18)}
  ${heading(12, 10, 13, panel, MODULE_W - 24)}
  ${ring({ cx: 72, cy: 106, inner: 32, outer: 44 }, panel.ratio, panel.code, panel.ringValue, 15)}
  ${text(146, 58, 12, LIT, panel.caption)}
  ${text(150 + panel.caption.length * 12.5, 58, 8, DIM, panel.captionEn, { face: 'sans', weight: 800, spacing: 1 })}
  <g filter="url(#glow)">${panel.digits(150, 66, 236)}</g>
  ${annotate(152, 142, 162, 162, panel.note)}
  ${lamps}
  ${alert(250, 178, 138, 16, panel.isDanger)}
  ${text(14, 207, 10, DIM, xml(panel.footer))}
  ${text(382, 207, 7, DIM, 'NEURAL LOAD MONITOR', { anchor: 'end', face: 'sans', weight: 800, spacing: 1 })}
</g>`, panel.tone)
}

// 中くらいの幅で縦に積むための、上下を詰めた横長のタイマー。
// 左にリングと数値、右に注釈・ランプ・警報を3段で寄せ、原寸の6割弱の高さにする
const STRIP_W = 600
const STRIP_H = 118
const STRIP_GAP = 8

const stripModule = (panel: Panel, x: number, y: number): string => {
  const lamps = panel.lamps.map(({ label, isOn }, i) => lamp(360 + i * 57, 60, 53, 16, label, isOn)).join('')
  const nameEnd = 10 + tagWidth(12, panel.name)
  return recolor(`<g transform="translate(${x} ${y})">
  ${plate(STRIP_W, STRIP_H, 14)}
  ${tag(10, 8, 18, 12, LIT, GROUND, xml(panel.name))}
  ${text(nameEnd + 8, 22, 11, LIT, panel.caption)}
  ${text(nameEnd + 12 + panel.caption.length * 11.5, 22, 7, DIM, xml(panel.english), { face: 'sans', weight: 800, spacing: 1 })}
  ${ring({ cx: 56, cy: 72, inner: 24, outer: 34 }, panel.ratio, panel.code, panel.ringValue, 12)}
  <g filter="url(#glow)">${panel.digits(116, 38, 232)}</g>
  ${annotate(352, 40, 364, 26, panel.note)}
  ${text(588, 47, 10, DIM, xml(panel.footer), { anchor: 'end' })}
  ${lamps}
  ${alert(360, 86, 228, 20, panel.isDanger, 10)}
</g>`, panel.tone)
}

// 狭い幅で縦に積むための小型のタイマー。原寸の6割ほどの高さに詰める。
// 段階の説明は見出しの右に寄せ、7セグメントを縮め、ランプと警報を最下段に1列で並べる
const COMPACT_W = 400
const COMPACT_H = 130
const COMPACT_GAP = 10
const DIGIT_SCALE = 0.78

const compactModule = (panel: Panel, x: number, y: number): string => {
  const lamps = panel.lamps.map(({ label, isOn }, i) => lamp(108 + i * 50, 108, 46, 14, label, isOn, 8)).join('')
  const nameEnd = 10 + tagWidth(12, panel.name)
  return recolor(`<g transform="translate(${x} ${y})">
  ${plate(COMPACT_W, COMPACT_H, 14)}
  ${tag(10, 8, 17, 12, LIT, GROUND, xml(panel.name))}
  ${text(nameEnd + 8, 21, 11, LIT, panel.caption)}
  ${text(390, 21, 9, DIM, xml(panel.footer), { anchor: 'end' })}
  ${ring({ cx: 52, cy: 74, inner: 24, outer: 33 }, panel.ratio, panel.code, panel.ringValue, 12)}
  <g filter="url(#glow)" transform="translate(110 32) scale(${DIGIT_SCALE})">${panel.digits(0, 0, 270 / DIGIT_SCALE)}</g>
  ${annotate(114, 88, 124, 101, panel.note)}
  ${lamps}
  ${alert(310, 108, 80, 14, panel.isDanger, 8, '限界警報')}
</g>`, panel.tone)
}

// ── 電脳容量マップ ────────────────────────────────────────
// /contextの内訳を、区画を並べた帯で描く。タイマーと同じ枠に収め、利用枠のタイマーの下(広い幅では空いた基)に置く。
// 表示名だけ日本語にし、判定はkindで行う

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
  Used: '使用中',
}

export const sliceName = (slice: MemorySlice): string => SLICE_NAMES[slice.name] ?? slice.name

const USED_COLORS = [GREEN, '#3FD9A0', '#C8FF7A', '#7FB8FF', PAPER, '#4FAF5A']

// 使用中の区分を多い順に、そのあとに空き領域、最後に圧縮予備域を並べる。
// 使用が空き領域を食い尽くして予備域に入ると自動圧縮が始まるので、予備域は必ず右端に置く。
// /contextの内訳は予備域を空き領域より先に返すことがあるため、届いた順には頼らない
const ordered = (memory: MemoryMap): { slice: MemorySlice; color: string }[] => {
  const used = memory.slices
    .filter(one => one.kind === 'used' && one.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens)
    .map((slice, i) => ({ slice, color: USED_COLORS[i % USED_COLORS.length]! }))
  const free = memory.slices.filter(one => one.kind === 'free').map(slice => ({ slice, color: DARK }))
  const buffer = memory.slices.filter(one => one.kind === 'buffer').map(slice => ({ slice, color: 'none' }))
  return [...used, ...free, ...buffer]
}

// 内訳が取れないときは、窓の使用量だけで「使用中」と「空き領域」の2区分を作る
export const memoryFrom = (context: ContextGauge | null): MemoryMap | null => {
  if (context === null || context.window <= 0) return null
  const used = context.tokens ?? (context.percent === undefined ? undefined : (context.percent / 100) * context.window)
  if (used === undefined) return null
  return {
    slices: [
      { name: 'Used', tokens: used, kind: 'used' },
      { name: 'Free space', tokens: Math.max(0, context.window - used), kind: 'free' },
    ],
    used,
    max: context.window,
    percentage: (used / context.window) * 100,
  }
}

const stageOf = (memory: MemoryMap | null): string | undefined =>
  memory === null ? undefined : CONTEXT_STAGES.find(one => memory.percentage < one.below)?.label

const memoryTone = (memory: MemoryMap | null): Tone =>
  memory === null ? 'green' : toneOf(Math.max(0, 100 - memory.percentage), memory.percentage >= 80)

const BUFFER_STROKE = ` stroke="${AMBER}" stroke-width="0.8"`

// 電脳容量マップの1基。minHeightを渡すと、その高さまで最下段を下げてタイマーと高さを揃える
const mapModule = (memory: MemoryMap | null, w: number, minHeight = 0): { height: number; draw: (x: number, y: number) => string } => {
  const barX = 12
  const barW = w - 24
  const blocks = w >= 500 ? 50 : 32
  const step = barW / blocks
  const columns = w >= 500 ? 3 : 2
  const rows = memory === null ? [] : ordered(memory)
  const legendRows = Math.ceil(rows.length / columns)
  const natural = 70 + legendRows * 15 + 52
  const height = Math.max(minHeight, natural)
  // タイマーと高さを揃えて余った分は、帯を太くするのに使う(最大で倍の高さまで)
  const barH = 18 + Math.min(18, height - natural)
  const legendTop = 72 + (barH - 18)
  const lampsY = height - 26
  const noteY = lampsY - 9
  const stage = stageOf(memory)
  const isDanger = memory !== null && memory.percentage >= 80

  const total = memory === null ? 0 : rows.reduce((sum, one) => sum + one.slice.tokens, 0) || memory.max
  let bufferStart: number | undefined
  const cells = Array.from({ length: blocks }, (_, i) => {
    if (memory === null || total <= 0) {
      return `<rect x="${barX + i * step}" y="34" width="${step - 2}" height="${barH}" fill="${DARK}"/>`
    }
    // 区画の中心が、累積したトークンのどの区分に入るかで色を決める
    const at = ((i + 0.5) / blocks) * total
    let sum = 0
    const hit = rows.find(one => (sum += one.slice.tokens) > at) ?? rows.at(-1)!
    if (hit.slice.kind === 'buffer' && bufferStart === undefined) bufferStart = i
    return `<rect x="${barX + i * step}" y="34" width="${step - 2}" height="${barH}" fill="${hit.color}"${hit.slice.kind === 'buffer' ? BUFFER_STROKE : ''}/>`
  }).join('')
  // 圧縮が始まる位置に、シアンの線で印を付ける
  const line =
    bufferStart === undefined
      ? ''
      : `<line x1="${barX + bufferStart * step - 1}" y1="30" x2="${barX + bufferStart * step - 1}" y2="${38 + barH}" stroke="${CYAN}" stroke-width="1.5"/>`
  const columnW = barW / columns
  const legend = rows
    .map(({ slice, color }, i) => {
      const x = barX + (i % columns) * columnW
      const y = legendTop + Math.floor(i / columns) * 15
      return `<rect x="${x}" y="${y - 8}" width="8" height="8" fill="${color}"${slice.kind === 'buffer' ? BUFFER_STROKE : ''}/>
  ${text(x + 12, y, 10, slice.kind === 'used' ? PAPER : DIM, xml(clip(sliceName(slice), 9)))}
  ${text(x + columnW - 10, y, 9, DIM, kilo(slice.tokens), { anchor: 'end', face: 'mono', weight: 500 })}`
    })
    .join('')
  const lampW = (barW - 4 * 6) / 5
  const lamps = CONTEXT_STAGES.map(({ label }, i) => lamp(barX + i * (lampW + 6), lampsY, lampW, 16, label, stage === label, 8)).join('')
  const nameEnd = 10 + tagWidth(12, '電脳容量マップ')
  const note =
    memory === null
      ? '※ 次の応答のあとで計測します'
      : '※ 使用が圧縮予備域（橙の枠）に達すると、自動で記憶圧縮されます'

  return {
    height,
    draw: (x, y) =>
      recolor(`<g transform="translate(${x} ${y})">
  ${plate(w, height, 14)}
  ${tag(10, 8, 17, 12, LIT, GROUND, '電脳容量マップ')}
  ${text(nameEnd + 8, 21, 7, DIM, 'NEURAL MEMORY MAP', { face: 'sans', weight: 800, spacing: 1 })}
  ${text(w - 12, 21, 11, LIT, memory === null ? '計測待ち' : `使用 ${Math.round(memory.percentage)}% ／ ${kilo(memory.max)}`, { anchor: 'end', weight: 800 })}
  <g filter="url(#glow)">${cells}</g>${line}
  ${legend}
  ${text(barX, noteY, 9, CYAN, note, { weight: 600 })}
  ${lamps}
  ${alert(barX + 4 * (lampW + 6), lampsY, lampW, 16, isDanger, 8, '限界警報')}
</g>`, memoryTone(memory)),
  }
}

// パネルの座標系の幅。mediumは電脳ログと同じ600にして文字の大きさを揃える
export const layoutWidth = (layout: Layout): number =>
  layout === 'wide' ? SLOTS * MODULE_W + (SLOTS - 1) * GAP : layout === 'medium' ? STRIP_W : COMPACT_W

// 利用枠のタイマーと電脳容量マップを並べる。
// wide: 原寸のタイマーを横に並べ、空いた基に電脳容量マップ。3基とも埋まっていればマップを下に全幅で置く
// medium: 横長の帯を縦に積み、その下にマップ。narrow: 小型を縦に積み、その下にマップ
export const powerSvg = (
  limits: readonly Limit[],
  memory: MemoryMap | null,
  now: number,
  layout: Layout,
  drawWidth: number,
): { source: string; width: number; height: number } => {
  const panels = panelsOf(limits, now)
  const width = layoutWidth(layout)
  let modules: string
  let height: number
  if (layout === 'wide') {
    const timers = panels.map((panel, i) => timerModule(panel, i * (MODULE_W + GAP), 0)).join('')
    if (panels.length < SLOTS) {
      const map = mapModule(memory, MODULE_W, MODULE_H)
      modules = timers + map.draw(panels.length * (MODULE_W + GAP), 0)
      height = MODULE_H
    } else {
      const map = mapModule(memory, width)
      modules = timers + map.draw(0, MODULE_H + GAP)
      height = MODULE_H + GAP + map.height
    }
  } else {
    const isMedium = layout === 'medium'
    const pitch = isMedium ? STRIP_H + STRIP_GAP : COMPACT_H + COMPACT_GAP
    const timers = panels
      .map((panel, i) => (isMedium ? stripModule(panel, 0, i * pitch) : compactModule(panel, 0, i * pitch)))
      .join('')
    const map = mapModule(memory, width)
    modules = timers + map.draw(0, panels.length * pitch)
    height = panels.length * pitch + map.height
  }
  const size = svgSize(drawWidth, width, height)
  // 基と基のすき間や外枠のまわりが透けると、枠(iframe)の白い地が見えるので、全面を地の色で塗る
  const source = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${size.width}" height="${size.height}" style="background:${VOID}">
  <rect width="${width}" height="${height}" fill="${VOID}"/>
  <defs>${crtDefs()}${toneDefs()}</defs>
  ${modules}
  ${scanlines(width, height)}
</svg>`
  return { source, ...size }
}

// Svgのないターミナル向け。同じ内容を文字で並べる
export const powerRows = (
  limits: readonly Limit[],
  memory: MemoryMap | null,
  now: number,
): { text: string; color: string }[] => {
  const rows = limits.map(limit => {
    const reading = readingOf(limit, now)
    const left = Math.max(0, 100 - limit.percentUsed)
    const lit = Math.round((left / 100) * 20)
    const ms = reading.ms ?? 0
    const time = `${Math.floor(ms / HOUR)}:${String(Math.floor((ms % HOUR) / 60_000)).padStart(2, '0')}`
    const tone = toneOf(left, reading.isDanger || reading.mode === 'halt', reading.mode === 'overrun')
    return {
      text: `${labelOf(limit.kind)} ${'▮'.repeat(lit)}${'▯'.repeat(20 - lit)} 残${Math.round(left)}% ${reading.caption} ${time} [${modeLabel(reading.mode)}]`,
      color: TONES[tone].lit,
    }
  })
  if (memory !== null) {
    const top = ordered(memory)
      .filter(one => one.slice.kind === 'used')
      .slice(0, 3)
      .map(one => `${sliceName(one.slice)} ${kilo(one.slice.tokens)}`)
      .join(' ')
    rows.push({
      text: `電脳容量 使用${Math.round(memory.percentage)}% ${kilo(memory.used)} / ${kilo(memory.max)} [${stageOf(memory)}] ${top}`,
      color: TONES[memoryTone(memory)].lit,
    })
  }
  return rows
}

// 警告帯に出すべき、使用率90%以上で最も逼迫した枠
export const critical = (limits: readonly Limit[]): Limit | undefined =>
  limits.filter(one => one.percentUsed >= 90).sort((a, b) => b.percentUsed - a.percentUsed)[0]

export const resetIn = (limit: Limit, now: number): string | undefined => {
  const reset = resetOf(limit)
  return reset === undefined ? undefined : untilText(reset - now)
}
