/**
 * @file src/features/settings/model/navigation.ts
 * 文件职责：定义设置中心侧边栏的导航信息模型，并提供默认分区、哈希解析与搜索过滤等不依赖 Vue 或浏览器 API 的纯规则。
 * 主要内容：包含按功能分组的标题、副标题、图标、关键词和 section ID，从同一注册表派生导航列表与后台合法分区 ID，导出 resolveNavigationItem、resolveRequestedSection 与 filterNavigationItems。
 * 模块边界：该模块只描述导航元数据，不切换 DOM、不写 location.hash 也不保存配置；Options 页面负责路由同步，SettingsSections.vue 负责各分区实际内容。
 */
export type NavigationItem = {
  id: string
  icon: string
  label: string
  description: string
  group: string
  heading: string
  summary: string
  kicker: string
  title: string
  detail: string
  searchDescription: string
}

export type NavigationGroup = {
  label: string
  items: readonly NavigationItem[]
}

export const navigationGroups = [
  {
    label: '基础配置',
    items: [
      {
        id: 'settings-general', icon: '⌂', label: '通用设置', description: '服务、显示与网页辅助', group: '基础配置',
        heading: '通用设置', summary: '选择默认翻译服务，并管理译文显示、网页辅助和基础偏好。',
        kicker: '基础配置', title: '通用设置', detail: '选择默认翻译服务，并管理译文显示、网页辅助和基础偏好。',
        searchDescription: '选择翻译服务、默认服务、译文显示、双语逐句高亮、网页辅助、AI 精翻、AI 智能上下文、默认目标语言、主题',
      },
      {
        id: 'settings-interface', icon: '▦', label: '界面风格', description: '界面与弹窗、动画与加载、菜单栏布局', group: '基础配置',
        heading: '界面风格', summary: '选择喜欢的界面风格，调整动画加载效果，并编排菜单栏中的模块和快捷功能。',
        kicker: '基础配置', title: '界面风格', detail: '选择喜欢的界面风格，调整动画加载效果，并编排菜单栏中的模块和快捷功能。',
        searchDescription: '界面设置、界面与弹窗、动画与加载效果、界面动画、翻译加载样式、简洁、柔和圆环、跳跃圆点、行星轨道、星光、涟漪扩散、起伏波形、光线扫过、流沙沙漏、小彗星、翻转方块、弹跳小球、打字光标、扫描线、信号柱、弹窗风格、默认风格、简约风格、紧凑风格、高对比、奶酪、海盐、抹茶、樱花、夜幕、纸张护眼、Emoji、菜单栏布局、弹窗栏目、快捷功能栏、当前网站栏目、底部信息栏',
      },
      {
        id: 'settings-services', icon: '译', label: '翻译服务', description: '服务与模型', group: '基础配置',
        heading: '配置翻译服务与模型', summary: '按机器翻译、模型服务商和聚合平台分类，配置各服务的模型、连接参数与凭据。',
        kicker: '基础配置', title: '翻译服务', detail: '配置可用的翻译服务、模型、连接和凭据。',
        searchDescription: '机器翻译、模型服务商、聚合平台、OpenAI、DeepSeek、硅基流动、OpenRouter、模型与令牌',
      },
      {
        id: 'settings-translation', icon: '译', label: '翻译设置', description: '悬浮、划词、输入框与全文', group: '基础配置',
        heading: '翻译设置', summary: '按使用顺序管理鼠标悬浮、划词、输入框和全文翻译。',
        kicker: '基础配置', title: '翻译设置', detail: '设置鼠标悬浮、划词、输入框与全文翻译的触发方式。',
        searchDescription: '鼠标悬浮翻译、划词翻译、输入框翻译、全文翻译、快捷方案、独立模型、AI 多段翻译、自定义快捷键、右键菜单、悬浮球、翻译进度',
      },
    ],
  },
  {
    label: '专项翻译',
    items: [
      {
        id: 'settings-harness', icon: '文', label: '翻译卡', description: '选区学习辅助', group: '专项翻译',
        heading: '翻译卡', summary: '选中文本后按需调用 AI，帮助理解、拆句、掌握用法和练习。',
        kicker: '专项翻译', title: '翻译卡', detail: '配置选区学习辅助的服务、上下文范围和回答偏好。',
        searchDescription: '翻译卡、阅读卡、Harness、DeepSeek、读懂、拆句、用法、练习、选区、段落、学习辅助、解释深度、学习程度、学习记忆、记忆开关',
      },
      {
        id: 'settings-image-translation', icon: '图', label: '图片翻译', description: '网页图片与 OCR', group: '专项翻译',
        heading: '图片翻译', summary: '管理网页图片翻译和本地 OCR 语言包。',
        kicker: '专项翻译', title: '图片翻译', detail: '悬停网页图片，从图片入口识别和翻译文字。',
        searchDescription: '图片翻译、OCR、语言包、中文、英文、日文、下载',
      },
      {
        id: 'settings-area-translation', icon: '▣', label: '圈选翻译', description: '截取区域与文字识别', group: '专项翻译',
        heading: '圈选翻译', summary: '圈选屏幕中的文字，选择标准翻译或 AI 上下文增强。',
        kicker: '专项翻译', title: '圈选翻译', detail: '独立配置圈选翻译的开关、识别语言和翻译服务。',
        searchDescription: '圈选翻译、区域翻译、截图、Shift+Z、OCR、微软、免费翻译、AI、纠错、语言包',
      },
      {
        id: 'settings-video', icon: 'CC', label: '视频字幕翻译', description: 'YouTube/X 边看边译', group: '专项翻译',
        heading: '视频字幕翻译', summary: '在 YouTube/X 原生字幕下方显示译文，X 无字幕时可用本地 AI 生成，并独立选择视频翻译服务。',
        kicker: '专项翻译', title: '视频字幕翻译', detail: '设置 YouTube/X 字幕翻译服务、显示方式和字号。',
        searchDescription: 'YouTube、X、Twitter、视频字幕、本地 AI、Whisper、视频翻译服务、显示模式、字幕字号、DeepLX、微软翻译',
      },
      {
        id: 'settings-sites', icon: '站', label: '网站规则', description: '自动翻译、禁用与网站适配', group: '专项翻译',
        heading: '网站规则', summary: '管理网站翻译偏好，以及正文和界面的翻译范围。',
        kicker: '专项翻译', title: '网站规则', detail: '自动翻译与禁用名单按主域名生效；网站适配可进一步指定路径和内容区域。',
        searchDescription: '网站、域名、网址、主域名、自动翻译、始终翻译、禁用扩展、子域、网站适配、兼容、JSON、自定义规则、正文、保护区域',
      },
    ],
  },
  {
    label: '工具与学习',
    items: [
      {
        id: 'settings-writing', icon: '✎', label: '写作助手', description: '起草、润色与智能回复', group: '工具与学习',
        heading: '写作助手', summary: '在 Gmail 和 GitHub 的回复框旁，起草回复或完善已有草稿。',
        kicker: '写作工具', title: '写作助手', detail: '启用写作助手，选择写作服务和模型。',
        searchDescription: '写作助手、起草、润色、回复、草稿、改进、语言、篇幅、语气、邮件、Gmail、GitHub、AI 服务、模型',
      },
      {
        id: 'settings-translation-center', icon: '译', label: '翻译中心', description: '多服务对比', group: '工具与学习',
        heading: '比较不同翻译服务', summary: '输入一句话，同时查看多个翻译服务的结果，并支持重复翻译。',
        kicker: '翻译工具', title: '翻译中心', detail: '用同一句话比较不同服务的译文表现。',
        searchDescription: '多服务翻译、翻译对比、重复翻译、句子翻译',
      },
      {
        id: 'settings-vocabulary', icon: '★', label: '学习中心', description: '收藏、复习与阅读记录', group: '工具与学习',
        heading: '学习中心', summary: '从收藏原句理解表达，练习自己的用法，再通过复习巩固。',
        kicker: '本地学习', title: '学习中心', detail: '收藏内容长期保留，阅读问答保留 30 天；所有学习数据只保存在当前浏览器。',
        searchDescription: '学习中心、单词本、收藏、词汇、句子、学习用法、造句、原句、复习、阅读记录、问答、30 天、Anki、导入导出',
      },
      {
        id: 'settings-glossary', icon: 'Aa', label: '术语库', description: '固定译名与保留原文', group: '工具与学习',
        heading: '术语库', summary: '为专业术语指定译法，按语言和网站选择适用范围。',
        kicker: '翻译工具', title: '术语库', detail: '管理词库、导入术语，并预览当前文本会使用的译法。',
        searchDescription: '术语库、专业术语、固定译名、专有名词、保留原文、glossary、CSV、TSV、导入导出',
      },
      {
        id: 'settings-model-usage', icon: '▥', label: '模型用量', description: 'Token、缓存与请求记录', group: '工具与学习',
        heading: '查看大模型调用用量', summary: '按服务、模型和时间范围查看本机 FluentRead 的请求与 Token。',
        kicker: '本地工具', title: '模型用量', detail: '查看发起的大模型调用、Token 消耗与使用趋势。',
        searchDescription: '模型用量、调用统计、Token、请求记录、耗时、输入 Token、输出 Token、缓存输入、缓存写入、缓存命中率、导入、导出、Kimi、月之暗面、OpenAI、DeepSeek',
      },
    ],
  },
  {
    label: '系统与数据',
    items: [
      {
        id: 'settings-advanced', icon: '◇', label: '高级选项', description: '性能与模板', group: '系统与数据',
        heading: '高级选项', summary: '管理缓存、并发、限流和重试等运行策略。',
        kicker: '系统与数据', title: '高级选项', detail: '调整缓存、并发、限流和重试；不确定时建议保留默认值。',
        searchDescription: '页面识别、全部节点、菜单、按钮、节点标签、缓存、缓存容量、存储大小、缓存条数、缓存上限、缓存阈值、清空缓存、清除缓存、LRU、并发、限流、重试、性能、资源占用',
      },
      {
        id: 'settings-data', icon: '⇅', label: '备份与恢复', description: '导出备份、恢复数据', group: '系统与数据',
        heading: '备份与恢复 FluentRead', summary: '一次备份设置、单词本和模型用量，也可找回之前的设置。',
        kicker: '系统与数据', title: '备份与恢复', detail: '导出或恢复设置、单词本和模型用量，并查看自动保存的设置历史。',
        searchDescription: '备份、恢复、最近修改、自动设置快照、六小时、差异、迁移、单词本、模型用量、导出与导入',
      },
      {
        id: 'settings-about', icon: 'i', label: '关于流畅阅读', description: '版本与项目', group: '系统与数据',
        heading: '关于流畅阅读', summary: '了解插件版本、核心体验与项目入口。',
        kicker: '关于项目', title: '关于流畅阅读', detail: '一个让双语阅读更自然的开源浏览器翻译插件。',
        searchDescription: '版本、开源项目、使用文档与问题反馈',
      },
    ],
  },
] as const satisfies readonly NavigationGroup[]

export type NavigationSectionId = (typeof navigationGroups)[number]['items'][number]['id']
export const navigationItems = navigationGroups.flatMap<NavigationItem>((group) => group.items)
export const NAVIGATION_SECTION_IDS = navigationGroups.flatMap<NavigationSectionId>((group) => group.items.map(item => item.id))

/** 旧设置入口与学习中心的新语义别名统一解析，不增加重复导航项目。 */
export const NAVIGATION_SECTION_ALIASES: ReadonlyMap<string, string> = new Map([
  ['settings-webpage', 'settings-translation'],
  ['settings-shortcuts', 'settings-translation'],
  ['settings-learning-center', 'settings-vocabulary'],
])

export const DEFAULT_NAVIGATION_SECTION = navigationItems[0].id

/** 根据 section id 返回有效导航项，无效值稳定回落到通用设置。 */
export function resolveNavigationItem(sectionId: string): NavigationItem {
  const resolvedSection = NAVIGATION_SECTION_ALIASES.get(sectionId) ?? sectionId
  return navigationItems.find((item) => item.id === resolvedSection) ?? navigationItems[0]
}

/** 统一解析 URL hash，避免入口组件重复维护导航校验。 */
export function resolveRequestedSection(hash: string): string {
  const requestedSection = hash.startsWith('#') ? hash.slice(1) : hash
  const resolvedSection = NAVIGATION_SECTION_ALIASES.get(requestedSection) ?? requestedSection
  return navigationItems.some((item) => item.id === resolvedSection)
    ? resolvedSection
    : DEFAULT_NAVIGATION_SECTION
}

/** 界面语言恢复词独立于当前界面语言，用户选错语言后仍能搜索回设置。 */
const UI_LANGUAGE_SEARCH_ALIASES = ['language', 'languages', 'ui language', 'app language', 'interface language', '语言', '語言', '软件语言', '界面语言', '言語', 'げんご', '언어', 'langue', 'idioma', 'язык', 'sprache', 'língua', 'lingua', 'لغة', 'भाषा', 'bahasa', 'ngôn ngữ', 'ภาษา']
export function isUiLanguageSearch(query: string): boolean {
  const keyword = query.trim().normalize('NFKC').toLocaleLowerCase()
  return Boolean(keyword) && UI_LANGUAGE_SEARCH_ALIASES.some(alias => alias.includes(keyword))
}

/** 搜索标题和说明，同时保持界面语言恢复入口跨语言可发现。 */
export function filterNavigationItems(query: string, items: readonly NavigationItem[] = navigationItems): NavigationItem[] {
  const keyword = query.trim().toLocaleLowerCase()
  if (!keyword) return []
  const languageSearch = isUiLanguageSearch(query)
  return items.filter(item => (languageSearch && item.id === 'settings-general') ||
    `${item.label}${item.description}${item.heading}${item.summary}${item.searchDescription}`.toLocaleLowerCase().includes(keyword))
    .sort((left, right) => languageSearch ? Number(right.id === 'settings-general') - Number(left.id === 'settings-general') : 0)
}
