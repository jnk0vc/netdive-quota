// 電脳モニターの配色。90年代のCRTモニターのような燐光の緑を基調にする。
// 緑は計測値と成功、橙は処理中と残量の目減り、赤は警報と遮断に使う。
// シアンは注釈と引き出し線だけに使い、計測値とは別の層として読めるようにする
export const VOID = '#020C05'
export const GREEN = '#7CFF6B'
export const AMBER = '#FFA531'
export const RED = '#FF4A3D'
export const CYAN = '#5FD8FF'
// 暗い緑。消灯したランプ、補助の文字、罫線に使う
export const MOSS = '#2F8F3A'
// 電脳ログの本文。地の上で読める明るさの淡い緑
export const PAPER = '#B9F5B0'
// 方眼の線。地からわずかに浮く程度にする
export const GRID = '#0A2A12'

// 日本語はゴシック体、英字の見出しはHelvetica系の太い大文字、ログは等幅で描く
export const GOTHIC = "'Hiragino Kaku Gothic StdN','Hiragino Kaku Gothic ProN','Hiragino Sans','Yu Gothic','Noto Sans JP',sans-serif"
export const SANS = "'Helvetica Neue','DIN Alternate',Helvetica,Arial,sans-serif"
export const MONO = "'SF Mono',Menlo,Consolas,'DejaVu Sans Mono',monospace"

// タイマーの基本色(赤段階)。点灯・消灯・地・暗い文字の4色で、緑と橙の段階はpower.tsで置き換える
export const LIT = '#FF4A3D'
export const DARK = '#3A0C08'
export const GROUND = '#160403'
export const DIM = '#A02A20'

// パネルの描画幅で3段階に組み替える。
// wide: 原寸のタイマー3基を横に、作業班トレースの右に電脳ログ
// medium: 背の低いタイマー3基を縦に、その下に作業班トレースと電脳ログ
// narrow: 原寸のタイマーと作業班トレースと電脳ログを縦に積む
export type Layout = 'wide' | 'medium' | 'narrow'

export const layoutOf = (drawWidth: number): Layout =>
  drawWidth >= 900 ? 'wide' : drawWidth >= 440 ? 'medium' : 'narrow'

// 動くSVGは枠(iframe)の中に宣言どおりの大きさで描かれ、枠の幅に合わせて縮んではくれない。
// そこでパネルのセル数からピクセル幅を見積もり、幅と高さを明示する。
// 1セルの幅はデスクトップの等幅13px相当。はみ出すと右が切れるので少し小さめに見積もる
const CELL_PX = 7.6

export const drawWidthOf = (bodyColumns: number): number => Math.max(240, Math.floor(bodyColumns * CELL_PX))

// パネル本体の高さ。見えている行数に1行の高さを掛けて見積もる
const ROW_PX = 18

export const paneHeightOf = (bodyRows: number): number => Math.max(300, bodyRows * ROW_PX)

export const svgSize = (drawWidth: number, viewWidth: number, viewHeight: number) => ({
  width: drawWidth,
  height: Math.round((drawWidth * viewHeight) / viewWidth),
})

// 整数の桁(符号は付いていてよい)を3桁ごとにカンマで区切る。
// ランタイムにはIntlもtoLocaleStringもないので手で区切る。小数部には使えない
export const group = (digits: string): string => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',')

export const xml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export const clip = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text

// 1文字の描画幅の見積もり。漢字・かな・全角記号は文字の大きさと同じ、英数字はその6割強とする
const glyphWidth = (char: string, size: number): number => ((char.codePointAt(0) ?? 0) >= 0x2e80 ? size : size * 0.62)

// 文字列の描画幅の見積もり。字間(letter-spacing)は1文字ごとに加わる
export const textWidth = (body: string, size: number, spacing = 0): number =>
  [...body].reduce((sum, char) => sum + glyphWidth(char, size) + spacing, 0)

// 見積もった幅がfitを超えるときだけ、文字と字間を縮めてfitに収める属性を返す。
// 桁が増えうる数字が、隣の文字やセルの外へはみ出さないようにする
export const fitAttr = (body: string, size: number, spacing: number, fit: number | undefined): string =>
  fit !== undefined && textWidth(body, size, spacing) > fit
    ? ` textLength="${Math.floor(fit)}" lengthAdjust="spacingAndGlyphs"`
    : ''

// 表示幅がmaxWidthに収まるよう切り詰める。英語名は日本語より細いので、文字数で切ると収まる名前まで省略してしまう
export const fitText = (text: string, size: number, maxWidth: number): string => {
  const chars = [...text]
  const widthOf = (list: string[]) => list.reduce((sum, char) => sum + glyphWidth(char, size), 0)
  if (widthOf(chars) <= maxWidth) return text
  const room = maxWidth - glyphWidth('…', size)
  let width = 0
  let count = 0
  for (const char of chars) {
    width += glyphWidth(char, size)
    if (width > room) break
    count += 1
  }
  return `${chars.slice(0, count).join('')}…`
}

export type Face = 'gothic' | 'sans' | 'mono'

export const FACES: Record<Face, string> = { gothic: GOTHIC, sans: SANS, mono: MONO }

export type TextOptions = {
  anchor?: 'start' | 'middle' | 'end'
  weight?: number
  face?: Face
  spacing?: number
  // 桁が増えうる数字の幅の上限。見積もりがこれを超えるときだけ縮めて収める
  fit?: number
}

export const text = (x: number, y: number, size: number, fill: string, body: string, options: TextOptions = {}): string => {
  const { anchor = 'start', weight = 700, face = 'gothic', spacing = 0, fit } = options
  const letter = spacing ? ` letter-spacing="${spacing}"` : ''
  return `<text x="${x}" y="${y}" font-family="${FACES[face]}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}"${letter}${fitAttr(body, size, spacing, fit)}>${body}</text>`
}

// 反転表示のラベル箱。塗りつぶした箱に地の色で文字を抜く
export const tag = (x: number, y: number, h: number, size: number, ground: string, ink: string, body: string, face: Face = 'gothic'): string => {
  const w = Math.ceil(body.length * size * (face === 'gothic' ? 1.02 : 0.68)) + 10
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${ground}"/>${text(x + 5, y + h / 2 + size * 0.36, size, ink, body, { face, weight: 800, spacing: face === 'gothic' ? 0 : 0.6 })}`
}

export const tagWidth = (size: number, body: string, face: Face = 'gothic'): number =>
  Math.ceil(body.length * size * (face === 'gothic' ? 1.02 : 0.68)) + 10

// CRTの走査線と燐光のにじみ。どのSVGにも同じものを敷く
export const crtDefs = (): string =>
  `<pattern id="scan" width="4" height="3" patternUnits="userSpaceOnUse"><rect width="4" height="1" fill="#000" opacity="0.32"/></pattern>
  <pattern id="grid" width="24" height="24" patternUnits="userSpaceOnUse"><path d="M24 0H0V24" fill="none" stroke="${GRID}" stroke-width="1"/></pattern>
  <filter id="glow" x="-10%" y="-10%" width="120%" height="120%"><feGaussianBlur stdDeviation="1.8" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>`

// 走査線。画面を流れるリフレッシュの帯は、明るさの揺れがチラつきに見えるので置かない
export const scanlines = (width: number, height: number): string =>
  `<rect width="${width}" height="${height}" fill="url(#scan)" pointer-events="none"/>`
