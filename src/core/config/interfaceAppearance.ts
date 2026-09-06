/**
 * @file src/core/config/interfaceAppearance.ts
 * 文件职责：定义 FluentRead 扩展的可插拔皮肤、Popup 模块布局与栏目可见性配置契约，作为 Options、Popup 和配置持久化共同依赖的单一来源。
 * 主要内容：维护界面皮肤的分组、背景图案、预览与尺寸策略，以及 Popup 区域和快捷功能卡片的两级注册表、默认顺序、可见性和安全归一化函数。
 * 模块边界：本文件只描述纯配置规则和用户可见元数据，不读取浏览器存储、不操作 DOM，也不决定具体页面布局；DOM 皮肤应用由 src/ui/interfaceAppearance.ts 负责。
 */

export const interfaceSkinGroups = [
  {
    value: 'utility',
    label: '效率与可读性',
    description: '从熟悉、简洁、紧凑到高对比，按使用场景选择。',
  },
  {
    value: 'palette',
    label: '氛围风格',
    description: '让色彩、背景与小小的图案，陪你自在阅读。',
  },
] as const

export const interfaceSkinOptions = [
  {
    value: 'default',
    motif: 'none',
    label: '默认风格',
    description: '保留当前 FluentRead 的界面布局与视觉效果。',
    group: 'utility',
    kind: 'default',
    popupHeight: 'content',
    popupWidth: 360,
    preview: {canvas: '#f6f7fb', surface: '#ffffff', accent: '#ef4776', ink: '#172033'},
  },
  {
    value: 'minimal',
    motif: 'none',
    label: '简约风格',
    description: '平面留白与轻边界，让主要操作更突出。',
    group: 'utility',
    kind: 'minimal',
    popupHeight: 'content',
    popupWidth: 350,
    preview: {canvas: '#ffffff', surface: '#f3f4f6', accent: '#ef4776', ink: '#313743'},
  },
  {
    value: 'compact',
    motif: 'none',
    label: '紧凑风格',
    description: '压缩间距与控件高度，适合高频快速操作。',
    group: 'utility',
    kind: 'compact',
    popupHeight: 'content',
    popupWidth: 340,
    preview: {canvas: '#f5f6f8', surface: '#ffffff', accent: '#dc315f', ink: '#283042'},
  },
  {
    value: 'contrast',
    motif: 'none',
    label: '高对比 ⚡',
    description: '强化文字、边框与焦点状态，提升辨识度。',
    group: 'utility',
    kind: 'contrast',
    popupHeight: 'content',
    popupWidth: 360,
    preview: {canvas: '#ffffff', surface: '#f6dd00', accent: '#111111', ink: '#000000'},
  },
  {
    value: 'cheese',
    motif: 'cheese',
    label: '奶酪 🧀',
    description: '奶油白与柔和焦糖色，温暖而清爽。',
    group: 'palette',
    kind: 'palette',
    popupHeight: 'content',
    popupWidth: 360,
    preview: {canvas: '#fff9e9', surface: '#fffefa', accent: '#946d2f', ink: '#35322b'},
  },
  {
    value: 'ocean',
    motif: 'ocean',
    label: '海盐 🌊',
    description: '晴空蓝与轻盈水波，像海风一样清爽。',
    group: 'palette',
    kind: 'palette',
    popupHeight: 'content',
    popupWidth: 360,
    preview: {canvas: '#f1fbff', surface: '#ffffff', accent: '#0676b7', ink: '#123c52'},
  },
  {
    value: 'matcha',
    motif: 'matcha',
    label: '抹茶 🍵',
    description: '鲜绿叶片与奶油白，收下一点春日生机。',
    group: 'palette',
    kind: 'palette',
    popupHeight: 'content',
    popupWidth: 360,
    preview: {canvas: '#f7fbed', surface: '#fffffc', accent: '#327b28', ink: '#274025'},
  },
  {
    value: 'sakura',
    motif: 'sakura',
    label: '樱花 🌸',
    description: '明亮花粉与轻柔花瓣，温柔也有好气色。',
    group: 'palette',
    kind: 'palette',
    popupHeight: 'content',
    popupWidth: 360,
    preview: {canvas: '#fff5f7', surface: '#fffefe', accent: '#c83474', ink: '#52263c'},
  },
  {
    value: 'emoji',
    motif: 'emoji',
    label: 'Emoji 乐园 ✨',
    description: '奶油纸、彩色贴纸和小表情，让日常多一点快乐。',
    group: 'palette',
    kind: 'palette',
    popupHeight: 'content',
    popupWidth: 360,
    preview: {canvas: '#fffaf0', surface: '#fffefd', accent: '#7143ca', ink: '#352447'},
  },
  {
    value: 'midnight',
    motif: 'midnight',
    label: '夜幕 🌙',
    description: '墨蓝底色与柔和雾蓝，适合夜间使用。',
    group: 'palette',
    kind: 'palette',
    popupHeight: 'content',
    popupWidth: 360,
    preview: {canvas: '#151c26', surface: '#1d2632', accent: '#9eb5d0', ink: '#e5ebf2'},
  },
  {
    value: 'paper',
    motif: 'paper',
    label: '纸张护眼 📖',
    description: '暖纸白与灰褐墨色，朴素耐看。',
    group: 'palette',
    kind: 'palette',
    popupHeight: 'content',
    popupWidth: 360,
    preview: {canvas: '#f3f0e9', surface: '#fbf9f3', accent: '#806b51', ink: '#37352f'},
  },
  {
    value: 'aurora',
    motif: 'aurora',
    label: '极光舷窗 🛰️',
    description: '青绿极光与深色舷窗，给长文阅读一点远方感。',
    group: 'palette',
    kind: 'palette',
    popupHeight: 'content',
    popupWidth: 360,
    preview: {canvas: '#f4f1ff', surface: '#fcfbff', accent: '#5147a8', ink: '#28264a'},
  },
  {
    value: 'arcade',
    motif: 'arcade',
    label: '像素街机 🎮',
    description: '像素网格与霓虹点亮操作，阅读节奏清晰利落。',
    group: 'palette',
    kind: 'palette',
    popupHeight: 'content',
    popupWidth: 360,
    preview: {canvas: '#f1f7f5', surface: '#fbfffd', accent: '#087f65', ink: '#172c32'},
  },
  {
    value: 'sunset',
    motif: 'sunset',
    label: '落日公路 🛣️',
    description: '夕阳橘、莓果红与暮蓝交汇，适合慢慢读完一页。',
    group: 'palette',
    kind: 'palette',
    popupHeight: 'content',
    popupWidth: 360,
    preview: {canvas: '#fff4ee', surface: '#fffdfa', accent: '#b64f3b', ink: '#422b35'},
  },
] as const

export type InterfaceSkin = typeof interfaceSkinOptions[number]['value']
export type InterfaceSkinOption = typeof interfaceSkinOptions[number]
export type InterfaceMotif = InterfaceSkinOption['motif']

const interfaceSkinByValue = new Map<string, InterfaceSkinOption>(
  interfaceSkinOptions.map((item) => [item.value, item]),
)

export const POPUP_MODULE_IDS = [
  'translation',
  'siteRule',
  'quickFeatures',
  'footer',
] as const

export type PopupModuleId = typeof POPUP_MODULE_IDS[number]

export const POPUP_QUICK_FEATURE_IDS = [
  'hover',
  'selection',
  'appearance',
  'image',
  'area',
  'video',
  'document',
] as const

export type PopupQuickFeatureId = typeof POPUP_QUICK_FEATURE_IDS[number]

export const INTERFACE_VISIBILITY_KEYS = [
  'popupQuickFeatures',
  'popupSiteRule',
  'popupFooter',
] as const

export type InterfaceVisibilityKey = typeof INTERFACE_VISIBILITY_KEYS[number]
export type InterfaceVisibility = Record<InterfaceVisibilityKey, boolean>
export type PopupQuickFeatureVisibility = Record<PopupQuickFeatureId, boolean>

export interface PopupModuleOption {
  id: PopupModuleId
  label: string
  description: string
  labelKey: string
  descriptionKey: string
  visibilityKey?: InterfaceVisibilityKey
  required?: boolean
}

export interface PopupQuickFeatureOption {
  id: PopupQuickFeatureId
  label: string
  description: string
  labelKey: string
  descriptionKey: string
}

/** Popup 的用户可编排模块注册表；顶部品牌和设置入口固定保留，避免失去返回设置页的路径。 */
export const popupModuleOptions: readonly PopupModuleOption[] = [
  {
    id: 'translation',
    label: '翻译控制',
    description: '语言、翻译服务与网页翻译按钮。',
    labelKey: 'settings.interface.popupLayout.modules.translation.label',
    descriptionKey: 'settings.interface.popupLayout.modules.translation.description',
    required: true,
  },
  {
    id: 'siteRule',
    label: '当前网站栏目',
    description: '当前网站的始终翻译和禁用扩展开关。',
    labelKey: 'settings.interface.popupLayout.modules.siteRule.label',
    descriptionKey: 'settings.interface.popupLayout.modules.siteRule.description',
    visibilityKey: 'popupSiteRule',
  },
  {
    id: 'quickFeatures',
    label: '快捷功能栏',
    description: '显示悬停、划词、图片、视频和文档等快捷入口。',
    labelKey: 'settings.interface.popupLayout.modules.quickFeatures.label',
    descriptionKey: 'settings.interface.popupLayout.modules.quickFeatures.description',
    visibilityKey: 'popupQuickFeatures',
  },
  {
    id: 'footer',
    label: '底部信息栏',
    description: '显示翻译统计、开源项目入口和清除缓存操作。',
    labelKey: 'settings.interface.popupLayout.modules.footer.label',
    descriptionKey: 'settings.interface.popupLayout.modules.footer.description',
    visibilityKey: 'popupFooter',
  },
] as const

/** 快捷功能卡片注册表；增加或移除入口时，顺序与可见性归一化会自动兼容旧配置。 */
export const popupQuickFeatureOptions: readonly PopupQuickFeatureOption[] = [
  {
    id: 'hover',
    label: '鼠标悬停翻译',
    description: '鼠标悬停时快速翻译文字。',
    labelKey: 'settings.interface.popupQuickFeatures.modules.hover.label',
    descriptionKey: 'settings.interface.popupQuickFeatures.modules.hover.description',
  },
  {
    id: 'selection',
    label: '划词翻译',
    description: '选中网页文字后翻译。',
    labelKey: 'settings.interface.popupQuickFeatures.modules.selection.label',
    descriptionKey: 'settings.interface.popupQuickFeatures.modules.selection.description',
  },
  {
    id: 'appearance',
    label: '译文显示',
    description: '快速调整译文的显示效果。',
    labelKey: 'settings.interface.popupQuickFeatures.modules.appearance.label',
    descriptionKey: 'settings.interface.popupQuickFeatures.modules.appearance.description',
  },
  {
    id: 'image',
    label: '图片翻译',
    description: '识别并翻译图片中的文字。',
    labelKey: 'settings.interface.popupQuickFeatures.modules.image.label',
    descriptionKey: 'settings.interface.popupQuickFeatures.modules.image.description',
  },
  {
    id: 'area',
    label: '圈选翻译',
    description: '截取页面区域，识别文字后翻译。',
    labelKey: 'settings.interface.popupQuickFeatures.modules.area.label',
    descriptionKey: 'settings.interface.popupQuickFeatures.modules.area.description',
  },
  {
    id: 'video',
    label: '视频翻译',
    description: '打开视频字幕翻译设置。',
    labelKey: 'settings.interface.popupQuickFeatures.modules.video.label',
    descriptionKey: 'settings.interface.popupQuickFeatures.modules.video.description',
  },
  {
    id: 'document',
    label: '文档翻译',
    description: '打开文档翻译入口。',
    labelKey: 'settings.interface.popupQuickFeatures.modules.document.label',
    descriptionKey: 'settings.interface.popupQuickFeatures.modules.document.description',
  },
] as const

export const interfaceVisibilityOptions = INTERFACE_VISIBILITY_KEYS.map((key) => {
  const module = popupModuleOptions.find((item) => item.visibilityKey === key) as PopupModuleOption
  return {key, label: module.label, description: module.description}
})

export const DEFAULT_POPUP_MODULE_ORDER: PopupModuleId[] = [...POPUP_MODULE_IDS]
export const DEFAULT_POPUP_QUICK_FEATURE_ORDER: PopupQuickFeatureId[] = [...POPUP_QUICK_FEATURE_IDS]

export const DEFAULT_INTERFACE_VISIBILITY = Object.fromEntries(
  INTERFACE_VISIBILITY_KEYS.map((key) => [key, true]),
) as InterfaceVisibility

export const DEFAULT_POPUP_QUICK_FEATURE_VISIBILITY = Object.fromEntries(
  POPUP_QUICK_FEATURE_IDS.map((id) => [id, id !== 'appearance']),
) as PopupQuickFeatureVisibility

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** 只接受注册表中的皮肤，未知值稳定回到当前默认界面。 */
export function normalizeInterfaceSkin(value: unknown): InterfaceSkin {
  return getInterfaceSkinOption(value).value
}

/** 返回完整皮肤元数据，让应用层无需识别任何具体皮肤 ID。 */
export function getInterfaceSkinOption(value: unknown): InterfaceSkinOption {
  return typeof value === 'string'
    ? interfaceSkinByValue.get(value) ?? interfaceSkinOptions[0]
    : interfaceSkinOptions[0]
}

/** Popup 根据注册元数据决定是否使用内容高度，新增皮肤不需要修改 Popup 组件。 */
export function interfaceSkinUsesContentHeight(value: unknown): boolean {
  return getInterfaceSkinOption(value).popupHeight === 'content'
}

/** Popup 宽度由皮肤元数据声明，紧凑或未来的窄版皮肤无需在组件中追加 ID 分支。 */
export function interfaceSkinPopupWidth(value: unknown): number {
  return getInterfaceSkinOption(value).popupWidth
}

/** 只保留已注册的栏目开关；旧配置缺少新栏目时默认显示，保证升级不改变现有界面。 */
export function normalizeInterfaceVisibility(value: unknown): InterfaceVisibility {
  const source = isRecord(value) ? value : {}
  return Object.fromEntries(
    interfaceVisibilityOptions.map(({key}) => [
      key,
      typeof source[key] === 'boolean' ? source[key] : DEFAULT_INTERFACE_VISIBILITY[key],
    ]),
  ) as InterfaceVisibility
}

/** 返回新的可见性对象，避免设置页与全局配置共享嵌套引用时提前污染保存基线。 */
export function withInterfaceVisibility(
  value: unknown,
  key: InterfaceVisibilityKey,
  visible: boolean,
): InterfaceVisibility {
  return {
    ...normalizeInterfaceVisibility(value),
    [key]: visible,
  }
}

/** 只接受已注册快捷入口的布尔可见性；旧配置缺少的新入口默认显示。 */
export function normalizePopupQuickFeatureVisibility(value: unknown): PopupQuickFeatureVisibility {
  const source = isRecord(value) ? value : {}
  return Object.fromEntries(
    POPUP_QUICK_FEATURE_IDS.map((id) => [
      id,
      typeof source[id] === 'boolean' ? source[id] : DEFAULT_POPUP_QUICK_FEATURE_VISIBILITY[id],
    ]),
  ) as PopupQuickFeatureVisibility
}

/** 用新对象更新单张快捷卡片的可见性，保证配置保存层能识别嵌套值变化。 */
export function withPopupQuickFeatureVisibility(
  value: unknown,
  id: PopupQuickFeatureId,
  visible: boolean,
): PopupQuickFeatureVisibility {
  return {
    ...normalizePopupQuickFeatureVisibility(value),
    [id]: visible,
  }
}

function normalizeRegisteredOrder<T extends string>(value: unknown, registeredIds: readonly T[]): T[] {
  const registered = new Set<unknown>(registeredIds)
  const seen = new Set<T>()
  const saved = Array.isArray(value)
    ? value.filter((item): item is T => {
        if (!registered.has(item) || seen.has(item as T)) return false
        seen.add(item as T)
        return true
      })
    : []

  return [
    ...saved,
    ...registeredIds.filter((id) => !seen.has(id)),
  ]
}

/**
 * 保存顺序只接受已注册模块，去除重复项，并按注册表顺序补上新模块。
 * 因此删除模块不需要迁移，新增模块也会稳定出现在旧用户布局末尾。
 */
export function normalizePopupModuleOrder(value: unknown): PopupModuleId[] {
  return normalizeRegisteredOrder(value, POPUP_MODULE_IDS)
}

/** 快捷入口顺序采用与顶层模块相同的插件式兼容策略。 */
export function normalizePopupQuickFeatureOrder(value: unknown): PopupQuickFeatureId[] {
  return normalizeRegisteredOrder(value, POPUP_QUICK_FEATURE_IDS)
}
