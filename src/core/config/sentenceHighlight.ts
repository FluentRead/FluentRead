/**
 * @file src/core/config/sentenceHighlight.ts
 * 文件职责：定义双语逐句高亮的预设、自定义外观与旧配置回退规则。
 * 主要内容：维护八种预设、自定义 CSS 与命名外观快照，归一化底色和线条覆盖值，生成网页和设置预览共用的绘制声明。
 * 模块边界：仅处理纯数据和安全 CSS 字符串，不读写配置、不访问 DOM；CSS 限定为高亮绘制属性，不改变字体尺寸或布局。
 */
import {MAX_TRANSLATION_CUSTOM_CSS_LENGTH, normalizeTranslationColor, parseTranslationCustomCss} from './translationAppearance'

export const SENTENCE_HIGHLIGHT_STYLES = [
  {value: 'rose', label: '柔光粉', labelKey: 'sentenceHighlight.rose', backgroundColor: '#ef4776', backgroundOpacity: 20, lineColor: '#ef4776', lineOpacity: 72, lineStyle: 'solid', lineThickness: 1},
  {value: 'mint', label: '薄荷清风', labelKey: 'sentenceHighlight.mint', backgroundColor: '#2db699', backgroundOpacity: 20, lineColor: '#23a087', lineOpacity: 80, lineStyle: 'solid', lineThickness: 1},
  {value: 'sky', label: '晴空蓝', labelKey: 'sentenceHighlight.sky', backgroundColor: '#5397eb', backgroundOpacity: 22, lineColor: '#5397eb', lineOpacity: 85, lineStyle: 'solid', lineThickness: 1},
  {value: 'underline', label: '细线聚焦', labelKey: 'sentenceHighlight.underline', backgroundColor: '#8274e0', backgroundOpacity: 0, lineColor: '#8274e0', lineOpacity: 90, lineStyle: 'solid', lineThickness: 2},
  {value: 'amber', label: '暖光琥珀', labelKey: 'sentenceHighlight.amber', backgroundColor: '#f5b241', backgroundOpacity: 23, lineColor: '#ca851a', lineOpacity: 85, lineStyle: 'solid', lineThickness: 1},
  {value: 'lavender', label: '雾紫柔光', labelKey: 'sentenceHighlight.lavender', backgroundColor: '#a78bfa', backgroundOpacity: 22, lineColor: '#8b6fdb', lineOpacity: 85, lineStyle: 'solid', lineThickness: 1},
  {value: 'slate', label: '石墨轻衬', labelKey: 'sentenceHighlight.slate', backgroundColor: '#94a3b8', backgroundOpacity: 18, lineColor: '#788aa0', lineOpacity: 85, lineStyle: 'solid', lineThickness: 1},
  {value: 'dotted', label: '点线引导', labelKey: 'sentenceHighlight.dotted', backgroundColor: '#5397eb', backgroundOpacity: 0, lineColor: '#5397eb', lineOpacity: 90, lineStyle: 'dotted', lineThickness: 2},
] as const
export type SentenceHighlightStyle = typeof SENTENCE_HIGHLIGHT_STYLES[number]['value']
export const DEFAULT_SENTENCE_HIGHLIGHT_STYLE: SentenceHighlightStyle = 'rose'
export function normalizeSentenceHighlightStyle(value: unknown): SentenceHighlightStyle {
  return SENTENCE_HIGHLIGHT_STYLES.find(style => style.value === value)?.value ?? DEFAULT_SENTENCE_HIGHLIGHT_STYLE
}

export const SENTENCE_HIGHLIGHT_LINE_STYLES = ['default', 'none', 'solid', 'dotted', 'dashed', 'double', 'wavy'] as const
export interface SentenceHighlightAppearance {
  /** 空色值和 null 数值沿用所选预设；0% 底色表示只显示线条。 */
  backgroundColor: string
  backgroundOpacity: number | null
  lineColor: string
  lineOpacity: number | null
  lineStyle: typeof SENTENCE_HIGHLIGHT_LINE_STYLES[number]
  lineThickness: number | null
  customCss: string
}
export const DEFAULT_SENTENCE_HIGHLIGHT_APPEARANCE: Readonly<SentenceHighlightAppearance> = Object.freeze({
  backgroundColor: '', backgroundOpacity: null, lineColor: '', lineOpacity: null, lineStyle: 'default', lineThickness: null, customCss: '',
})

function normalizeNumber(value: unknown, min: number, max: number): number | null {
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return null
  const number = Number(value)
  return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.round(number))) : null
}

export function normalizeSentenceHighlightAppearance(value: unknown): SentenceHighlightAppearance {
  const source = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  return {
    backgroundColor: normalizeTranslationColor(source.backgroundColor),
    backgroundOpacity: normalizeNumber(source.backgroundOpacity, 0, 100),
    lineColor: normalizeTranslationColor(source.lineColor),
    lineOpacity: normalizeNumber(source.lineOpacity, 0, 100),
    lineStyle: SENTENCE_HIGHLIGHT_LINE_STYLES.find(style => style === source.lineStyle) ?? 'default',
    lineThickness: normalizeNumber(source.lineThickness, 1, 4),
    customCss: typeof source.customCss === 'string' ? source.customCss.slice(0, MAX_TRANSLATION_CUSTOM_CSS_LENGTH).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/gu, '') : '',
  }
}

/** 只允许原生高亮支持的绘制属性；background 作为纯色简写映射到 background-color。 */
const SENTENCE_HIGHLIGHT_CSS_PROPERTIES = new Set([
  'color', 'background', 'background-color', 'text-decoration', 'text-decoration-line', 'text-decoration-color',
  'text-decoration-style', 'text-decoration-thickness', 'text-shadow',
  '-webkit-text-stroke-color', '-webkit-text-fill-color', '-webkit-text-stroke-width',
])
export function parseSentenceHighlightCustomCss(value: unknown) {
  const parsed = parseTranslationCustomCss(value, SENTENCE_HIGHLIGHT_CSS_PROPERTIES)
  return {...parsed, declarations: parsed.declarations.map(declaration => ({
    ...declaration, property: declaration.property === 'background' ? 'background-color' : declaration.property,
  }))}
}

export interface SentenceHighlightProfile {
  id: string
  name: string
  style: SentenceHighlightStyle
  appearance: SentenceHighlightAppearance
}
export const MAX_SENTENCE_HIGHLIGHT_PROFILES = 12
export function normalizeSentenceHighlightProfiles(value: unknown): SentenceHighlightProfile[] {
  if (!Array.isArray(value)) return []
  const profiles: SentenceHighlightProfile[] = []
  const ids = new Set<string>()
  for (const item of value.slice(0, 100)) {
    if (!item || typeof item !== 'object') continue
    const source = item as Record<string, unknown>
    const id = typeof source.id === 'string' ? source.id.trim() : ''
    const name = typeof source.name === 'string' ? source.name.replace(/[\u0000-\u001f\u007f]/gu, '').trim().slice(0, 30) : ''
    if (!/^[a-zA-Z0-9_-]{1,64}$/u.test(id) || ids.has(id) || !name
      || !SENTENCE_HIGHLIGHT_STYLES.some(preset => preset.value === source.style)) continue
    profiles.push({id, name, style: source.style as SentenceHighlightStyle, appearance: normalizeSentenceHighlightAppearance(source.appearance)})
    ids.add(id)
    if (profiles.length === MAX_SENTENCE_HIGHLIGHT_PROFILES) break
  }
  return profiles
}

export function isDefaultSentenceHighlightAppearance(value: unknown): boolean {
  const appearance = normalizeSentenceHighlightAppearance(value)
  return Object.entries(DEFAULT_SENTENCE_HIGHLIGHT_APPEARANCE).every(([key, defaultValue]) => appearance[key as keyof SentenceHighlightAppearance] === defaultValue)
}

export function resolveSentenceHighlightAppearance(style: unknown, value: unknown) {
  const preset = SENTENCE_HIGHLIGHT_STYLES.find(preset => preset.value === normalizeSentenceHighlightStyle(style))!
  const appearance = normalizeSentenceHighlightAppearance(value)
  return {
    backgroundColor: appearance.backgroundColor || preset.backgroundColor,
    backgroundOpacity: appearance.backgroundOpacity ?? preset.backgroundOpacity,
    lineColor: appearance.lineColor || preset.lineColor,
    lineOpacity: appearance.lineOpacity ?? preset.lineOpacity,
    lineStyle: appearance.lineStyle === 'default' ? preset.lineStyle : appearance.lineStyle,
    lineThickness: appearance.lineThickness ?? preset.lineThickness,
  }
}

function rgba(color: string, opacity: number): string {
  const channels = [1, 3, 5].map(index => parseInt(color.slice(index, index + 2), 16))
  return `rgba(${channels.join(', ')}, ${opacity / 100})`
}

/** 默认不覆盖共享预设 CSS，自定义时仅生成 Custom Highlight API 支持的绘制属性。 */
export function getSentenceHighlightAppearanceStyle(style: unknown, value: unknown): Record<string, string> {
  if (isDefaultSentenceHighlightAppearance(value)) return {}
  const appearance = resolveSentenceHighlightAppearance(style, value)
  const declarations: Record<string, string> = {
    'background-color': rgba(appearance.backgroundColor, appearance.backgroundOpacity),
    'text-decoration-line': appearance.lineStyle === 'none' ? 'none' : 'underline',
    'text-decoration-style': appearance.lineStyle === 'none' ? 'solid' : appearance.lineStyle,
    'text-decoration-color': rgba(appearance.lineColor, appearance.lineOpacity),
    'text-decoration-thickness': `${appearance.lineThickness}px`,
  }
  // 删除后重新插入，保留 CSS 的先后顺序，避免 shorthand 覆盖用户随后指定的 longhand。
  for (const {property, value: cssValue} of parseSentenceHighlightCustomCss(normalizeSentenceHighlightAppearance(value).customCss).declarations) {
    delete declarations[property]
    declarations[property] = cssValue
  }
  return declarations
}

export function buildSentenceHighlightAppearanceCss(style: unknown, value: unknown): string {
  const declarations = Object.entries(getSentenceHighlightAppearanceStyle(style, value))
  if (!declarations.length) return ''
  return '[data-fr-bilingual-sentence-highlight="true"]::highlight(fluentread-bilingual-sentence),\n'
    + '[data-fr-bilingual-sentence-highlight="true"] ::highlight(fluentread-bilingual-sentence) {\n'
    + declarations.map(([property, value]) => `  ${property}: ${value} !important;`).join('\n') + '\n}\n'
}
