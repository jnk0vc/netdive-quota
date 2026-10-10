import { FACES, MONO, fitAttr, text, xml } from './palette'
import type { TextOptions } from './palette'

// SVGの中だけで完結する動き(SMIL)の部品。
// 出力は入力だけで決まる。ホストは文字列が1文字でも変わるとSVGを読み込み直して動きを頭から再生するので、
// 乱数も現在時刻も使わず、同じ入力なら必ず同じ文字列を返す

const trim = (n: number, digits: number): number => +n.toFixed(digits)

// 目に見える減速のある進み方。最初に大きく進み、着地に向けて遅くなる
const easeOutCubic = (t: number): number => 1 - (1 - t) * (1 - t) * (1 - t)

export type RollOptions = TextOptions & {
  x: number
  y: number
  size: number
  fill: string
  from: number
  to: number
  format: (n: number) => string
  // 数字のあとにそのまま続ける文字。同じtext要素に入るので右寄せや中央寄せでもずれない
  suffix?: string
  // 数え上げにかける秒数と、その間に切り替える画の数
  duration?: number
  frames?: number
}

// 数字が数え上がっていく文字。fromからtoへ、減速しながら途中の値を順に見せて着地する。
// 末尾の桁をでたらめに回したり、着地で光らせたりはしない(値が動くたびに点滅して見え、うるさい)。
// 画はvisibilityをsetで切り替えて見せる(フレームkはt_kから次のフレームまで。最後の画は残る)。
// fromとtoの表示が同じなら動かさず、普通のtext()と同じ文字列を返す
export const rollText = (o: RollOptions): string => {
  const { x, y, size, fill, from, to, format, suffix = '', duration = 0.9, frames = 12 } = o
  const { anchor = 'start', weight = 700, face = 'gothic', spacing = 0, fit } = o
  const last = format(to)
  if (from === to || format(from) === last) {
    return text(x, y, size, fill, xml(last + suffix), { anchor, weight, face, spacing, fit })
  }
  const at = (k: number) => trim((duration * k) / frames, 2)
  const view = (k: number): string => {
    if (k === 0) return format(from)
    if (k === frames) return last
    return format(from + (to - from) * easeOutCubic(k / frames))
  }
  const letter = spacing ? ` letter-spacing="${spacing}"` : ''
  const pictures = Array.from({ length: frames + 1 }, (_, k) => {
    const body = xml(view(k) + suffix)
    const hidden = k === 0 ? '' : ' visibility="hidden"'
    const show = k === 0 ? '' : `<set attributeName="visibility" to="visible" begin="${at(k)}s"/>`
    const hide = k === frames ? '' : `<set attributeName="visibility" to="hidden" begin="${at(k + 1)}s"/>`
    return `<text x="${x}" y="${y}"${fitAttr(body, size, spacing, fit)}${hidden}>${body}${show}${hide}</text>`
  }).join('')
  return `<g font-family="${FACES[face]}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}"${letter}>${pictures}</g>`
}

// 増えた分を示す小さな文字。置いた位置から14px浮かびながら、2.2秒かけて消える
export const deltaTag = (x: number, y: number, body: string, color: string): string =>
  text(
    x,
    y,
    10,
    color,
    `${xml(body)}<animate attributeName="y" from="${y}" to="${y - 14}" dur="2.2s" fill="freeze"/><animate attributeName="opacity" from="1" to="0" dur="2.2s" fill="freeze"/>`,
    { anchor: 'end', face: 'mono' },
  )

// ── 経過時間の時計 ────────────────────────────────────────
// T+MM:SS を、再描画なしに1秒ごとに数え上げる。等幅の1文字ぶんの幅を固定して桁の位置を決め、
// 桁ごとに0から9の字形を重ねて、そのとき見せる1つ以外をvisibilityで隠す

const ADVANCE = 0.6

// 分の桁数は、いまから10分後まで桁があふれないように取る。最低2桁。
// 余裕を大きく取ると、先頭の空いた桁が「T+ 84:33」のような隙間として長く残る。
// 電脳ログはツールを実行するたびに描き直すので、10分あれば次の描き直しで桁が揃う
const minuteDigits = (seconds0: number): number => Math.max(2, String(Math.floor((seconds0 + 600) / 60)).length)

// 「T+」「分の桁」「:」「秒2桁」の文字数ぶんの幅
export const tickerWidth = (seconds0: number, size: number): number => (minuteDigits(seconds0) + 5) * size * ADVANCE

// seconds0はT+の表示に入るときの経過秒。数え上げる桁は floor(((seconds0 + t) mod modulo) / divisor)。
// isLeadingは先頭の桁で、0のときは字形を出さず空ける(elapsed()の分は、2桁に満たなければ0で埋めるが、3桁以上なら埋めない)
const risingDigit = (seconds0: number, divisor: number, modulo: number, x: number, y: number, isLeading = false): string => {
  const steps = modulo / divisor
  const offset = seconds0 % modulo
  return Array.from({ length: steps }, (_, d) => {
    if (isLeading && d === 0) return ''
    // d番の字形が見えるのは、周期を等分したd番目の区間だけ
    const keys = [0, ...(d > 0 ? [d] : []), ...(d < steps - 1 ? [d + 1] : [])]
    const values = keys.map(key => (key === d ? 'visible' : 'hidden'))
    const times = keys.map(key => trim(key / steps, 5))
    return `<text x="${x}" y="${y}" visibility="hidden">${d}<animate attributeName="visibility" calcMode="discrete" values="${values.join(';')}" keyTimes="${times.join(';')}" dur="${modulo}s" begin="${-offset}s" repeatCount="indefinite"/></text>`
  }).join('')
}

export const ticker = (seconds0: number, x: number, y: number, size: number, fill: string): string => {
  const advance = size * ADVANCE
  const digits = minuteDigits(seconds0)
  const at = (i: number) => trim(x + i * advance, 2)
  const options = { face: 'mono', weight: 700 } as const
  const minutes = Array.from({ length: digits }, (_, j) => {
    const i = digits - 1 - j
    return risingDigit(seconds0, 60 * 10 ** i, 60 * 10 ** (i + 1), at(2 + j), y, digits >= 3 && j === 0)
  }).join('')
  return `${text(at(0), y, size, fill, 'T+', options)}<g font-family="${MONO}" font-size="${size}" font-weight="700" fill="${fill}">${minutes}${risingDigit(seconds0, 10, 60, at(3 + digits), y)}${risingDigit(seconds0, 1, 10, at(4 + digits), y)}</g>${text(at(2 + digits), y, size, fill, ':', options)}`
}
