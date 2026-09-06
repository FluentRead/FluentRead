/**
 * @file src/core/config/translationLoadingStyle.ts
 * 文件职责：定义网页段落翻译加载指示器的可选视觉样式、默认值与配置归一化规则。
 * 主要内容：维护低干扰默认样式和多种趣味预设的稳定标识、用户可见说明，并拒绝存储或导入中的未知值。
 * 模块边界：本文件只描述纯配置与展示元数据，不创建 DOM、不运行动画，也不读写浏览器存储。
 */

export const translationLoadingStyleOptions = [
  {
    value: 'ring',
    label: '柔和圆环',
    description: '保留熟悉的旋转反馈，颜色和尺寸更克制。',
    labelKey: 'settings.advanced.translationLoadingStyle.ring.label',
    descriptionKey: 'settings.advanced.translationLoadingStyle.ring.description',
  },
  {
    value: 'minimal',
    label: '简洁',
    description: '低存在感的轻柔呼吸点，适合长时间阅读。',
    labelKey: 'settings.advanced.translationLoadingStyle.minimal.label',
    descriptionKey: 'settings.advanced.translationLoadingStyle.minimal.description',
  },
  {
    value: 'dots',
    label: '跳跃圆点',
    description: '三个小点依次轻跳，节奏明快但不刺眼。',
    labelKey: 'settings.advanced.translationLoadingStyle.dots.label',
    descriptionKey: 'settings.advanced.translationLoadingStyle.dots.description',
  },
  {
    value: 'orbit',
    label: '行星轨道',
    description: '小圆点沿轨道缓慢运行，带一点探索感。',
    labelKey: 'settings.advanced.translationLoadingStyle.orbit.label',
    descriptionKey: 'settings.advanced.translationLoadingStyle.orbit.description',
  },
  {
    value: 'sparkle',
    label: '星光',
    description: '两颗小星交替闪烁，为等待增加一点趣味。',
    labelKey: 'settings.advanced.translationLoadingStyle.sparkle.label',
    descriptionKey: 'settings.advanced.translationLoadingStyle.sparkle.description',
  },
  {
    value: 'pulse',
    label: '涟漪扩散',
    description: '柔和圆环向外扩散，像水面落下一滴雨。',
    labelKey: 'settings.advanced.translationLoadingStyle.pulse.label',
    descriptionKey: 'settings.advanced.translationLoadingStyle.pulse.description',
  },
  {
    value: 'wave',
    label: '起伏波形',
    description: '三根短线依次起伏，像一段安静的声波。',
    labelKey: 'settings.advanced.translationLoadingStyle.wave.label',
    descriptionKey: 'settings.advanced.translationLoadingStyle.wave.description',
  },
  {
    value: 'sweep',
    label: '光线扫过',
    description: '一束小光点横向扫过，节奏清晰而轻快。',
    labelKey: 'settings.advanced.translationLoadingStyle.sweep.label',
    descriptionKey: 'settings.advanced.translationLoadingStyle.sweep.description',
  },
  {
    value: 'hourglass',
    label: '流沙沙漏',
    description: '上下两瓣交替翻转，像细沙缓缓流动。',
    labelKey: 'settings.advanced.translationLoadingStyle.hourglass.label',
    descriptionKey: 'settings.advanced.translationLoadingStyle.hourglass.description',
  },
  {
    value: 'comet',
    label: '小彗星',
    description: '小彗星拖着尾巴掠过，带一点探索感。',
    labelKey: 'settings.advanced.translationLoadingStyle.comet.label',
    descriptionKey: 'settings.advanced.translationLoadingStyle.comet.description',
  },
  {
    value: 'flip',
    label: '翻转方块',
    description: '小方块在原地翻面，利落地提示正在处理。',
    labelKey: 'settings.advanced.translationLoadingStyle.flip.label',
    descriptionKey: 'settings.advanced.translationLoadingStyle.flip.description',
  },
  {
    value: 'bounce',
    label: '弹跳小球',
    description: '一颗小球轻轻弹起又落下，反馈直观明快。',
    labelKey: 'settings.advanced.translationLoadingStyle.bounce.label',
    descriptionKey: 'settings.advanced.translationLoadingStyle.bounce.description',
  },
  {
    value: 'typing',
    label: '打字光标',
    description: '细光标规律闪烁，像译文正在逐字准备。',
    labelKey: 'settings.advanced.translationLoadingStyle.typing.label',
    descriptionKey: 'settings.advanced.translationLoadingStyle.typing.description',
  },
  {
    value: 'scan',
    label: '扫描线',
    description: '细线往返扫描，呈现快速检查中的状态。',
    labelKey: 'settings.advanced.translationLoadingStyle.scan.label',
    descriptionKey: 'settings.advanced.translationLoadingStyle.scan.description',
  },
  {
    value: 'signal',
    label: '信号柱',
    description: '三根信号柱按序亮起，显示翻译正在连线。',
    labelKey: 'settings.advanced.translationLoadingStyle.signal.label',
    descriptionKey: 'settings.advanced.translationLoadingStyle.signal.description',
  },
] as const

export type TranslationLoadingStyle = typeof translationLoadingStyleOptions[number]['value']

export const DEFAULT_TRANSLATION_LOADING_STYLE: TranslationLoadingStyle = 'ring'

/** 未知或缺失配置回到柔和圆环；已保存的合法样式保持不变。 */
export function normalizeTranslationLoadingStyle(value: unknown): TranslationLoadingStyle {
  return translationLoadingStyleOptions.some(option => option.value === value)
    ? value as TranslationLoadingStyle
    : DEFAULT_TRANSLATION_LOADING_STYLE
}
