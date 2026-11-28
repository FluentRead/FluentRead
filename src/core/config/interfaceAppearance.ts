/**
 * @file src/core/config/interfaceAppearance.ts
 * 文件职责：定义 FluentRead 扩展的可插拔皮肤、字体、Popup 模块布局与栏目可见性配置契约，作为 Options、Popup 和配置持久化共同依赖的单一来源。
 * 主要内容：维护界面皮肤的分组、缩略图的配色与造型（画布、卡片描边与圆角、主按钮）以及尺寸策略，并把已下线的风格 ID 换成接替它的现有风格，提供本地字体栈预设，以及 Popup 区域和快捷功能卡片的两级注册表、默认顺序、可见性和安全归一化函数；旧圈选入口迁入图片，视频与信息高亮入口移出 Popup，但保留功能配置。
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
    label: '传统色风格',
    description: '配色取自中国传统色，每套一种造型；全部平涂，不用渐变与光效。',
  },
] as const

export const interfaceSkinOptions = [
  {
    value: 'default',
    label: '默认风格',
    description: '保留当前 FluentRead 的界面布局与视觉效果。',
    group: 'utility',
    kind: 'default',
    popupHeight: 'content',
    popupWidth: 320,
    preview: {canvas: '#ffffff', backdrop: '#ffffff', surface: '#ffffff', border: '#e7eaf1', radius: 5, ink: '#172033', title: '#172033', accent: '#ef4776', action: 'linear-gradient(135deg, #f45686, #e53268)'},
  },
  {
    value: 'minimal',
    label: '简约风格',
    description: '平面留白与轻边界，让主要操作更突出。',
    group: 'utility',
    kind: 'minimal',
    popupHeight: 'content',
    popupWidth: 310,
    preview: {canvas: '#ffffff', backdrop: '#ffffff', surface: '#f7f8fb', border: '#f7f8fb', radius: 5, ink: '#313743', title: '#313743', accent: '#ef4776', action: '#e3e7ee'},
  },
  {
    value: 'compact',
    label: '紧凑风格',
    description: '压缩间距与控件高度，适合高频快速操作。',
    group: 'utility',
    kind: 'compact',
    popupHeight: 'content',
    popupWidth: 300,
    preview: {canvas: '#f6f7fa', backdrop: '#f6f7fa', surface: '#ffffff', border: '#e7eaf1', radius: 4, ink: '#283042', title: '#283042', accent: '#ef4776', action: 'linear-gradient(135deg, #f45686, #e53268)'},
  },
  {
    value: 'contrast',
    label: '高对比 ⚡',
    description: '强化文字、边框与焦点状态，提升辨识度。',
    group: 'utility',
    kind: 'contrast',
    popupHeight: 'content',
    popupWidth: 320,
    preview: {canvas: '#ffffff', backdrop: '#ffffff', surface: '#fff9c4', border: '#000000', radius: 2, ink: '#000000', title: '#000000', accent: '#111111', action: '#000000'},
  },
  {
    value: 'qinghua',
    label: '青花',
    description: '白瓷底配琉璃蓝：主卡片一粗一细两道蓝线，图标是蓝色圆片。',
    group: 'palette',
    kind: 'palette',
    popupHeight: 'content',
    popupWidth: 320,
    preview: {canvas: '#ffffff', backdrop: '#ffffff', surface: '#ffffff', border: '#183a65', radius: 6, ink: '#161823', title: '#161823', accent: '#183a65', action: '#183a65'},
  },
  {
    value: 'zhusha',
    label: '朱砂',
    description: '方正的朱红印面配白字，主卡片顶上一道朱红、一线库金。',
    group: 'palette',
    kind: 'palette',
    popupHeight: 'content',
    popupWidth: 320,
    preview: {canvas: '#ffffff', backdrop: '#ffffff', surface: '#ffffff', border: '#e6ddd0', radius: 2, ink: '#312520', title: '#312520', accent: '#c3272b', action: '#c3272b'},
  },
  {
    value: 'shuimo',
    label: '水墨',
    description: '只用墨的浓淡，主按钮上留一点朱红的印。',
    group: 'palette',
    kind: 'palette',
    popupHeight: 'content',
    popupWidth: 320,
    preview: {canvas: '#f0f0f4', backdrop: '#f0f0f4', surface: '#ffffff', border: '#ffffff', radius: 7, ink: '#161823', title: '#161823', accent: '#3d3b4f', action: '#161823'},
  },
  {
    value: 'zhuqing',
    label: '竹青',
    description: '荼白底配松花绿，快捷入口像一片片竹简。',
    group: 'palette',
    kind: 'palette',
    popupHeight: 'content',
    popupWidth: 320,
    preview: {canvas: '#f3f9f1', backdrop: '#f3f9f1', surface: '#ffffff', border: '#d3e2d5', radius: 4, ink: '#1f2a24', title: '#1f2a24', accent: '#057748', action: '#057748'},
  },
  {
    value: 'ouhe',
    label: '藕荷',
    description: '淡藕色的底，圆润的胶囊控件与黛紫主按钮。',
    group: 'palette',
    kind: 'palette',
    popupHeight: 'content',
    popupWidth: 320,
    preview: {canvas: '#f6ecf1', backdrop: '#f6ecf1', surface: '#ffffff', border: '#ffffff', radius: 10, ink: '#2a2230', title: '#2a2230', accent: '#574266', action: '#574266'},
  },
  {
    value: 'xiangse',
    label: '缃色',
    description: '象牙白的卡片配缃色主按钮与煤黑的字。',
    group: 'palette',
    kind: 'palette',
    popupHeight: 'content',
    popupWidth: 320,
    preview: {canvas: '#ffffff', backdrop: '#ffffff', surface: '#fffbf0', border: '#eadfbe', radius: 5, ink: '#312520', title: '#312520', accent: '#8a6200', action: '#f0c239'},
  },
  {
    value: 'qinglv',
    label: '青绿',
    description: '青绿山水的三种矿物色：沙青、铜绿与赭。',
    group: 'palette',
    kind: 'palette',
    popupHeight: 'content',
    popupWidth: 320,
    preview: {canvas: '#f1f6f6', backdrop: '#f1f6f6', surface: '#ffffff', border: '#d5e0e7', radius: 6, ink: '#172530', title: '#172530', accent: '#205580', action: '#205580'},
  },
  {
    value: 'yuebai',
    label: '月白',
    description: '整块月白的版面，白卡片与花青主按钮。',
    group: 'palette',
    kind: 'palette',
    popupHeight: 'content',
    popupWidth: 320,
    preview: {canvas: '#d6ecf0', backdrop: '#d6ecf0', surface: '#ffffff', border: '#ffffff', radius: 9, ink: '#1c2733', title: '#1c2733', accent: '#576d93', action: '#576d93'},
  },
  {
    value: 'xuanqing',
    label: '玄青',
    description: '漆黑的夜色配月白主按钮；始终为深色。',
    group: 'palette',
    kind: 'palette',
    popupHeight: 'content',
    popupWidth: 320,
    preview: {canvas: '#161823', backdrop: '#161823', surface: '#1e2030', border: '#33364a', radius: 8, ink: '#e6eef2', title: '#e6eef2', accent: '#8db4dc', action: '#d6ecf0'},
  },
  {
    value: 'wujin',
    label: '乌金',
    description: '黑底、乌金细线与赤金主按钮；始终为深色。',
    group: 'palette',
    kind: 'palette',
    popupHeight: 'content',
    popupWidth: 320,
    preview: {canvas: '#131210', backdrop: '#131210', surface: '#1b1a16', border: '#a78e44', radius: 1, ink: '#f2ecdd', title: '#f2be45', accent: '#f2be45', action: '#f2be45'},
  },
] as const

/**
 * 扩展自身页面的字体方案。默认系统字体不下载；其他方案首次使用时下载并缓存。
 * 未覆盖的字符交给系统字体。字体文件只由 Popup / Options 按需加载。
 */
export const interfaceFontOptions = [
  {
    value: 'system',
    labelKey: 'settings.interface.font.options.system.label',
    descriptionKey: 'settings.interface.font.options.system.description',
    fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
  },
  {
    value: 'inter',
    labelKey: 'settings.interface.font.options.inter.label',
    descriptionKey: 'settings.interface.font.options.inter.description',
    fontFamily: '"FluentRead Inter", "FluentRead Noto Sans SC", system-ui, sans-serif',
  },
  {
    value: 'noto-sans-sc',
    labelKey: 'settings.interface.font.options.notoSansSc.label',
    descriptionKey: 'settings.interface.font.options.notoSansSc.description',
    fontFamily: '"FluentRead Noto Sans SC", system-ui, sans-serif',
  },
  {
    value: 'roboto',
    labelKey: 'settings.interface.font.options.roboto.label',
    descriptionKey: 'settings.interface.font.options.roboto.description',
    fontFamily: '"FluentRead Roboto", "FluentRead Noto Sans SC", system-ui, sans-serif',
  },
  {
    value: 'source-sans-3',
    labelKey: 'settings.interface.font.options.sourceSans3.label',
    descriptionKey: 'settings.interface.font.options.sourceSans3.description',
    fontFamily: '"FluentRead Source Sans 3", "FluentRead Noto Sans SC", system-ui, sans-serif',
  },
  {
    value: 'ibm-plex-sans',
    labelKey: 'settings.interface.font.options.ibmPlexSans.label',
    descriptionKey: 'settings.interface.font.options.ibmPlexSans.description',
    fontFamily: '"FluentRead IBM Plex Sans", "FluentRead Noto Sans SC", system-ui, sans-serif',
  },
  {
    value: 'manrope',
    labelKey: 'settings.interface.font.options.manrope.label',
    descriptionKey: 'settings.interface.font.options.manrope.description',
    fontFamily: '"FluentRead Manrope", "FluentRead Noto Sans SC", system-ui, sans-serif',
  },
  {
    value: 'nunito-sans',
    labelKey: 'settings.interface.font.options.nunitoSans.label',
    descriptionKey: 'settings.interface.font.options.nunitoSans.description',
    fontFamily: '"FluentRead Nunito Sans", "FluentRead Noto Sans SC", system-ui, sans-serif',
  },
  {
    value: 'lxgw-wenkai',
    labelKey: 'settings.interface.font.options.lxgwWenkai.label',
    descriptionKey: 'settings.interface.font.options.lxgwWenkai.description',
    fontFamily: '"FluentRead LXGW WenKai", "FluentRead Noto Sans SC", system-ui, sans-serif',
  },
  {
    value: 'noto-serif-sc',
    labelKey: 'settings.interface.font.options.notoSerifSc.label',
    descriptionKey: 'settings.interface.font.options.notoSerifSc.description',
    fontFamily: '"FluentRead Noto Serif SC", "FluentRead Noto Sans SC", system-ui, sans-serif',
  },
] as const

export type InterfaceFont = typeof interfaceFontOptions[number]['value']
export type InterfaceFontOption = typeof interfaceFontOptions[number]

export const DEFAULT_INTERFACE_FONT: InterfaceFont = 'system'

const interfaceFontByValue = new Map<string, InterfaceFontOption>(
  interfaceFontOptions.map((item) => [item.value, item]),
)

export type InterfaceSkin = typeof interfaceSkinOptions[number]['value']
export type InterfaceSkinOption = typeof interfaceSkinOptions[number]

const interfaceSkinByValue = new Map<string, InterfaceSkinOption>(
  interfaceSkinOptions.map((item) => [item.value, item]),
)

/**
 * 已下线的风格与接替它的现有风格。旧配置里保存的是这些 ID，升级后换成气质最接近的一套，
 * 让原本选了配色风格的用户仍停留在一套配色风格里，而不是意外退回默认界面。
 */
const retiredInterfaceSkinSuccessors = new Map<string, InterfaceSkin>([
  ['cheese', 'xiangse'],
  ['ocean', 'yuebai'],
  ['matcha', 'zhuqing'],
  ['sakura', 'ouhe'],
  ['emoji', 'ouhe'],
  ['midnight', 'xuanqing'],
  ['paper', 'shuimo'],
  ['aurora', 'xuanqing'],
  ['arcade', 'qinglv'],
  ['sunset', 'zhusha'],
])

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
    description: '翻译语言与各功能的服务提供商',
    labelKey: 'settings.interface.popupLayout.modules.translation.label',
    descriptionKey: 'settings.interface.popupLayout.modules.translation.description',
    required: true,
  },
  {
    id: 'siteRule',
    label: '当前网站栏目',
    description: '当前网站的始终翻译和禁用扩展开关',
    labelKey: 'settings.interface.popupLayout.modules.siteRule.label',
    descriptionKey: 'settings.interface.popupLayout.modules.siteRule.description',
    visibilityKey: 'popupSiteRule',
  },
  {
    id: 'quickFeatures',
    label: '快捷功能栏',
    description: '显示悬停、划词、图片和文档翻译入口',
    labelKey: 'settings.interface.popupLayout.modules.quickFeatures.label',
    descriptionKey: 'settings.interface.popupLayout.modules.quickFeatures.description',
    visibilityKey: 'popupQuickFeatures',
  },
  {
    id: 'footer',
    label: '底部信息栏',
    description: '显示翻译统计、开源项目入口和清除缓存操作',
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
    description: '鼠标悬停时快速翻译文字',
    labelKey: 'settings.interface.popupQuickFeatures.modules.hover.label',
    descriptionKey: 'settings.interface.popupQuickFeatures.modules.hover.description',
  },
  {
    id: 'selection',
    label: '划词翻译',
    description: '选中网页文字后翻译',
    labelKey: 'settings.interface.popupQuickFeatures.modules.selection.label',
    descriptionKey: 'settings.interface.popupQuickFeatures.modules.selection.description',
  },
  {
    id: 'appearance',
    label: '译文显示',
    description: '快速调整译文的显示效果',
    labelKey: 'settings.interface.popupQuickFeatures.modules.appearance.label',
    descriptionKey: 'settings.interface.popupQuickFeatures.modules.appearance.description',
  },
  {
    id: 'image',
    label: '图片翻译',
    description: '识别并翻译图片中的文字',
    labelKey: 'settings.interface.popupQuickFeatures.modules.image.label',
    descriptionKey: 'settings.interface.popupQuickFeatures.modules.image.description',
  },
  {
    id: 'document',
    label: '文档翻译',
    description: '打开文档翻译入口',
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

/** 只接受注册表中的皮肤：已下线的风格换成接替者，其余未知值稳定回到当前默认界面。 */
export function normalizeInterfaceSkin(value: unknown): InterfaceSkin {
  return getInterfaceSkinOption(value).value
}

/** 只接受内置字体栈，未知值稳定回到默认系统字体。 */
export function normalizeInterfaceFont(value: unknown): InterfaceFont {
  return getInterfaceFontOption(value).value
}

/** 返回字体栈元数据，让页面应用层不需要识别具体字体方案。 */
export function getInterfaceFontOption(value: unknown): InterfaceFontOption {
  return typeof value === 'string'
    ? interfaceFontByValue.get(value) ?? interfaceFontByValue.get(DEFAULT_INTERFACE_FONT)!
    : interfaceFontByValue.get(DEFAULT_INTERFACE_FONT)!
}

/** 返回完整皮肤元数据，让应用层无需识别任何具体皮肤 ID；已下线的风格先换成接替它的现有风格。 */
export function getInterfaceSkinOption(value: unknown): InterfaceSkinOption {
  if (typeof value !== 'string') return interfaceSkinOptions[0]
  return interfaceSkinByValue.get(retiredInterfaceSkinSuccessors.get(value) ?? value) ?? interfaceSkinOptions[0]
}

/** Popup 根据注册元数据决定是否使用内容高度，新增皮肤不需要修改 Popup 组件。 */
export function interfaceSkinUsesContentHeight(value: unknown): boolean {
  return getInterfaceSkinOption(value).popupHeight === 'content'
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
      id === 'image' && source.area === true ? true : typeof source[id] === 'boolean' ? source[id] : DEFAULT_POPUP_QUICK_FEATURE_VISIBILITY[id],
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
  // 旧圈选入口并入图片，保留用户排列意图；视频配置本身不受入口收敛影响。
  const migrated = Array.isArray(value) ? value.map(id => id === 'area' ? 'image' : id) : value
  return normalizeRegisteredOrder(migrated, POPUP_QUICK_FEATURE_IDS)
}
