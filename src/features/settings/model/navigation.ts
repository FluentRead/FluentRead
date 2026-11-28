/**
 * @file src/features/settings/model/navigation.ts
 * 文件职责：定义设置中心侧边栏的导航信息模型，并提供默认分区、哈希解析与搜索过滤等不依赖 Vue 或浏览器 API 的纯规则。
 * 主要内容：按“基础配置 / 翻译与交互 / 规则与工具 / 系统与数据”四组组织单一归属的设置分区，导出完整的导航项、页内分类、控件直达目标、旧入口别名与搜索过滤规则；逐句高亮归入网页翻译的阅读辅助，完整句学习外观归入视频字幕，悬浮球与右键菜单归入悬浮球与右键，输入框翻译与写作助手归入输入与写作，从同一注册表派生导航列表与后台合法分区 ID。
 * 构建表示：完整静态导航组保持字面量，系统与数据组保留品牌来源引用；消费者仍读取同一完整注册表。
 * 请求配置搜索：将 AI 翻译超时、timeout 与慢模型等待关键词归入高级请求限制。
 * 模块边界：该模块只描述导航元数据，不切换 DOM、不写 location.hash 也不保存配置；Options 页面负责路由同步，SettingsSections.vue 负责各分区实际内容。
 */
import brandTaglines from '@/src/core/i18n/messages/brand-taglines.json';

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

export type SettingsSearchTarget = {
  id: string
  sectionId: string
  targetId: string
  label: string
  description: string
  searchTerms: string
}

/** 表单内的直达入口与真实控件共用 targetId，避免搜索只停在长分区顶部。 */
export const settingsSearchTargets: readonly SettingsSearchTarget[] = [
  {
    id: 'privacy-protection', sectionId: 'settings-advanced', targetId: 'privacy-protection-settings',
    label: '翻译隐私防护', description: '高级与隐私', searchTerms: '脱敏 隐私 安全 敏感信息 邮箱 电话 身份证 密钥 隐私防护 privacy redaction PII',
  },
  {
    id: 'information-highlight', sectionId: 'settings-translation', targetId: 'information-highlight-settings',
    label: '智能高亮', description: '网页翻译', searchTerms: '文本智能高亮、信息高亮、重点高亮、意外度、surprisal、关键词、密度、本地模型、隐私',
  },
  {
    id: 'feature-services', sectionId: 'settings-general', targetId: 'feature-services',
    label: '按功能选择翻译服务', description: '通用设置', searchTerms: '按功能选择服务、默认服务、提供商、功能分配、独立服务、视频服务、写作服务、划词服务、输入框服务',
  },
  {
    id: 'floating-ball-toggle', sectionId: 'settings-interactions', targetId: 'floating-ball-settings',
    label: '全文翻译悬浮球', description: '悬浮球与右键', searchTerms: '悬浮球、显示悬浮球、开启悬浮球、悬浮球配置、悬浮球位置',
  },
  {
    id: 'floating-ball-settings', sectionId: 'settings-interactions', targetId: 'floating-ball-settings',
    label: '悬浮球设置', description: '悬浮球与右键', searchTerms: '悬浮球配置、悬浮球设置、悬浮球位置、边距、不透明度',
  },
  {
    id: 'excluded-tags', sectionId: 'settings-translation', targetId: 'excluded-tag-settings',
    label: '不翻译的标签', description: '网页翻译', searchTerms: '不翻译的标签、排除标签、忽略标签、跳过标签、HTML 标签、CSS 选择器、ignoreSelector',
  },
  {
    id: 'translation-sentence-highlight', sectionId: 'settings-translation', targetId: 'translation-sentence-highlight-style',
    label: '双语逐句高亮', description: '网页翻译', searchTerms: '阅读辅助、原文译文、句子对应、高亮颜色、柔光粉、薄荷清风、晴空蓝、细线聚焦、暖光琥珀、雾紫柔光、石墨轻衬、点线引导',
  },
  {
    id: 'translation-sentence-highlight-style', sectionId: 'settings-translation', targetId: 'translation-sentence-highlight-style',
    label: '逐句高亮样式', description: '网页翻译', searchTerms: '阅读辅助、高亮颜色、柔光粉、薄荷清风、晴空蓝、细线聚焦、暖光琥珀、雾紫柔光、石墨轻衬、点线引导',
  },
  {
    id: 'translation-appearance', sectionId: 'settings-interface', targetId: 'translation-appearance-panel',
    label: '译文外观', description: '外观与界面', searchTerms: '译文颜色、线条颜色、标记底色、译文字号、译文字重、译文字体、译文不透明度、双语顺序、原文在上、译文在上',
  },
  {
    id: 'video-sentence-learning-appearance', sectionId: 'settings-video', targetId: 'video-sentence-learning-appearance',
    label: '完整句学习外观', description: '视频字幕', searchTerms: '视频学习、面板样式、紧凑布局、舒适布局、背景不透明度、面板宽度、默认位置、拖动位置',
  },
  {
    id: 'input-translation', sectionId: 'settings-writing', targetId: 'input-translation-settings',
    label: '输入框翻译', description: '输入与写作', searchTerms: '输入框、连按、空格、替换、追加、提示词',
  },
]

const STATIC_NAVIGATION_GROUPS = [
  {
    label: '基础配置',
    items: [
      {
        id: 'settings-general', icon: '⌂', label: '通用设置', description: '日常翻译、服务分配与基本偏好', group: '基础配置',
        heading: '通用设置', summary: '设置默认翻译服务、目标语言、显示模式与基本偏好',
        kicker: '基础配置', title: '通用设置', detail: '设置默认翻译服务、目标语言、显示模式与基本偏好',
        searchDescription: '日常翻译、选择翻译服务、默认服务、配置服务、按功能选择翻译服务、翻译模式、默认目标语言、基本偏好、插件状态、工具栏点击、界面语言、主题',
      },
      {
        id: 'settings-services', icon: '译', label: '翻译服务', description: '服务连接与模型', group: '基础配置',
        heading: '配置翻译服务与模型', summary: '选择翻译服务，配置所需的模型、连接地址和凭据',
        kicker: '基础配置', title: '翻译服务', detail: '配置可用的翻译服务、模型、连接和凭据',
        searchDescription: '机器翻译、云服务厂商、谷歌云、Azure、阿里云、腾讯云、百度、火山引擎、Ollama、模型服务商、聚合平台、OpenAI、DeepSeek、硅基流动、OpenRouter、模型与令牌',
      },
      {
        id: 'settings-interface', icon: '▦', label: '外观与界面', description: '译文样式、弹窗风格与布局', group: '基础配置',
        heading: '外观与界面', summary: '调整网页译文样式、扩展弹窗风格、菜单栏布局与加载动画',
        kicker: '基础配置', title: '外观与界面', detail: '调整网页译文样式、扩展弹窗风格、菜单栏布局与加载动画',
        searchDescription: '译文样式、双语样式、双语上下顺序、原文在上、译文在上、译文颜色、字体颜色、下划线颜色、划线颜色、线条颜色、标记底色、译文字号、译文字重、译文字体、不透明度、模糊遮罩、双下划线、侧边色条、界面设置、界面与弹窗、动画与加载效果、翻译加载样式、弹窗风格、弹窗皮肤、默认经典、液态玻璃、极光幻彩、拟物硬件、新粗野波普、赛博霓虹、经典复古桌面、极客终端、典藏画报、樱雾物语、宇治手账、黑金典藏、菜单栏布局、弹窗栏目、快捷功能栏、当前网站栏目、底部信息栏',
      },
    ],
  },
  {
    label: '翻译与交互',
    items: [
      {
        id: 'settings-translation', icon: '译', label: '网页翻译', description: '全文、悬浮、局部与阅读辅助', group: '翻译与交互',
        heading: '网页翻译', summary: '设置全文、悬浮与局部翻译的触发策略，以及双语阅读辅助',
        kicker: '翻译与交互', title: '网页翻译', detail: '设置全文、悬浮与局部翻译的触发策略，以及双语阅读辅助',
        searchDescription: '全文翻译、AI 智能上下文、AI 多段翻译、翻译进度面板、页面识别、全部节点、网页标题、侧栏、段落处理、最少字符数、长段落换行、鼠标悬浮翻译、局部翻译、快捷方案、阅读辅助、双语逐句高亮、个人校订、段落复制、不翻译的语言、跳过语言、排除语言、自定义快捷键',
      },
      {
        id: 'settings-interactions', icon: '◎', label: '悬浮球与右键', description: '悬浮球交互与浏览器右键菜单', group: '翻译与交互',
        heading: '悬浮球与右键', summary: '统一管理网页悬浮球入口与浏览器右键菜单项',
        kicker: '翻译与交互', title: '悬浮球与右键', detail: '统一管理网页悬浮球入口与浏览器右键菜单项',
        searchDescription: '悬浮球、全文翻译悬浮球、点击行为、按钮显示方式、缩小悬浮球、收起不透明度、边距、展开延迟、右键菜单、选中文本、图片右键、圈选、禁用网站',
      },
      {
        id: 'settings-selection', icon: '文', label: '划词翻译', description: '翻译卡片、词典与 AI 讲解', group: '翻译与交互',
        heading: '划词翻译', summary: '选中文字查看译文、查词、听读或按需进行 AI 讲解',
        kicker: '翻译与交互', title: '划词翻译', detail: '统一管理划词的触发、词典、AI 讲解与朗读偏好',
        searchDescription: '划词翻译、翻译卡片、词典、触发、两点选取、双向划词、朗读、本地朗读、AI 讲解、读懂、拆句、用法、练习、学习程度、学习记忆、自定义指令',
      },
      {
        id: 'settings-writing', icon: '✎', label: '输入与写作', description: '输入框翻译与智能写作助手', group: '翻译与交互',
        heading: '输入与写作', summary: '在网页输入框中快速翻译，或在回复框旁起草与润色草稿',
        kicker: '翻译与交互', title: '输入与写作', detail: '管理输入框翻译触发、输出方式，以及写作助手偏好',
        searchDescription: '输入框翻译、连按空格、替换、追加、提示词、写作助手、起草、润色、回复、草稿、语言、篇幅、语气、邮件、Gmail、GitHub',
      },
      {
        id: 'settings-image-translation', icon: '图', label: '图片与漫画', description: '网页图片、漫画连续翻译与圈选', group: '翻译与交互',
        heading: '图片与漫画', summary: '管理网页单图、漫画连续阅读和圈选区域的识别与翻译',
        kicker: '翻译与交互', title: '图片与漫画', detail: '按需开启图片、漫画连续翻译和圈选翻译，按需管理本地识别资源',
        searchDescription: '漫画、漫画翻译、MANGA Plus、连续翻译、图片翻译、圈选翻译、区域翻译、截图、识图、视觉、OCR、PaddleOCR、Tesseract、语言包、支持网站',
      },
      {
        id: 'settings-video', icon: 'CC', label: '视频字幕', description: 'YouTube/X 边看边译与外观', group: '翻译与交互',
        heading: '视频字幕', summary: '设置视频与网页会议的双语字幕、字幕外观、完整句学习与本地识别',
        kicker: '翻译与交互', title: '视频字幕', detail: '管理视频字幕翻译、外观样式、完整句学习面板和本地 AI 识别',
        searchDescription: 'YouTube、X、Twitter、Bilibili、Udemy、edX、视频字幕、字幕外观、字幕皮肤、字幕字号、译文字号、读音标注、逐字高亮、完整句学习、本地 AI、Whisper、Qwen3 ASR',
      },
    ],
  },
  {
    label: '规则与工具',
    items: [
      {
        id: 'settings-sites', icon: '站', label: '网站规则', description: '网站偏好、正文适配与生效预览', group: '规则与工具',
        heading: '网站规则', summary: '按网站调整翻译、禁用扩展与悬浮球隐藏偏好，扩展正文适配',
        kicker: '规则与工具', title: '网站规则', detail: '网站偏好按主域名生效，正文适配可指定路径和内容区域；预览仅检查已保存配置，不访问网站',
        searchDescription: '网站、域名、网址、主域名、自动翻译、始终翻译、禁用扩展、子域、网站适配、兼容、隐藏悬浮球、生效预览、规则目录、可视化编辑、导入导出、JSON、自定义规则、正文、保护区域',
      },
      {
        id: 'settings-glossary', icon: 'Aa', label: '术语库', description: '固定译名与保留原文', group: '规则与工具',
        heading: '术语库', summary: '为专业术语指定译法，按语言和网站选择适用范围',
        kicker: '规则与工具', title: '术语库', detail: '管理词库、导入术语，并预览当前文本会使用的译法',
        searchDescription: '术语库、专业术语、固定译名、专有名词、保留原文、glossary、CSV、TSV、导入导出',
      },
      {
        id: 'settings-translation-center', icon: '译', label: '翻译中心', description: '多服务对比', group: '规则与工具',
        heading: '比较不同翻译服务', summary: '输入相同文本，对比不同翻译服务的结果，也可重新翻译',
        kicker: '规则与工具', title: '翻译中心', detail: '用同一句话比较不同服务的译文表现',
        searchDescription: '多服务翻译、翻译对比、重复翻译、句子翻译',
      },
      {
        id: 'settings-vocabulary', icon: '★', label: '学习中心', description: '收藏、复习与阅读记录', group: '规则与工具',
        heading: '学习中心', summary: '结合收藏的原句理解词语和表达，通过练习与复习巩固所学',
        kicker: '规则与工具', title: '学习中心', detail: '收藏内容长期保留，阅读问答保留 30 天；所有学习数据只保存在当前浏览器',
        searchDescription: '学习中心、单词本、收藏、词汇、句子、学习用法、造句、原句、复习、阅读记录、问答、30 天、Anki、导入导出',
      },
      {
        id: 'settings-translation-stats', icon: '◔', label: '翻译统计', description: '请求规模、耗时与模型用量', group: '规则与工具',
        heading: '翻译统计', summary: '查看每次翻译请求的规模、耗时与模型 Token 用量',
        kicker: '规则与工具', title: '翻译统计', detail: '查看翻译请求的规模、耗时分布和各服务的表现',
        searchDescription: '翻译统计、请求统计、请求大小、请求规模、字符数、耗时、平均耗时、最长耗时、最大耗时、P95、响应速度、成功率、失败原因、超时、缓存命中、服务对比、性能 · 模型用量、调用统计、Token、请求记录、输入 Token、输出 Token、缓存输入、缓存写入、缓存命中率',
      },
    ],
  },
] as const satisfies readonly NavigationGroup[]

export const navigationGroups = [
  ...STATIC_NAVIGATION_GROUPS,
  {
    label: '系统与数据',
    items: [
      {
        id: 'settings-advanced', icon: '◇', label: '高级与隐私', description: '隐私防护、请求策略与缓存', group: '系统与数据',
        heading: '高级与隐私', summary: '管理翻译隐私脱敏、请求并发限流重试与本地缓存',
        kicker: '系统与数据', title: '高级与隐私', detail: '调整隐私防护、缓存、并发、限流和重试；不确定时建议保留默认值',
        searchDescription: '隐私防护、脱敏、敏感信息、缓存、缓存容量、存储大小、缓存条数、缓存上限、缓存阈值、清空缓存、清除缓存、LRU、并发、限流、重试、超时、timeout、性能、资源占用',
      },
      {
        id: 'settings-data', icon: '⇅', label: '备份与恢复', description: '导出备份、云同步与历史', group: '系统与数据',
        heading: '备份与恢复 FluentRead', summary: '一次备份设置、单词本和模型用量，也可找回之前的设置',
        kicker: '系统与数据', title: '备份与恢复', detail: '导出或恢复设置、单词本和模型用量，并查看自动保存的设置历史',
        searchDescription: '备份、恢复、云同步、WebDAV、Google Drive、最近修改、自动设置快照、六小时、差异、迁移、单词本、模型用量、导出与导入',
      },
      {
        id: 'settings-about', icon: 'i', label: '关于流畅阅读', description: '版本与项目', group: '系统与数据',
        heading: '关于流畅阅读', summary: '查看插件版本、项目主页和反馈渠道',
        kicker: '关于项目', title: '关于流畅阅读', detail: brandTaglines['zh-CN'],
        searchDescription: '版本、开源项目、使用文档与问题反馈',
      },
    ],
  },
] as const satisfies readonly NavigationGroup[]

export type NavigationSectionId = (typeof navigationGroups)[number]['items'][number]['id']
export const navigationItems = navigationGroups.flatMap<NavigationItem>((group) => group.items)
export const NAVIGATION_SECTION_IDS = navigationGroups.flatMap<NavigationSectionId>((group) => group.items.map(item => item.id))

/** 不同任务模式需要独立视图；其他设置保持同页连续展示。 */
export const SETTINGS_TABBED_SECTION_IDS: ReadonlySet<string> = new Set(['settings-translation-stats'])

/** 旧设置入口与历史语义别名统一解析，不增加重复导航项目。 */
export const NAVIGATION_SECTION_ALIASES: ReadonlyMap<string, string> = new Map([
  ['settings-model-usage', 'settings-translation-stats'],
  ['settings-area-translation', 'settings-image-translation'],
  ['settings-harness', 'settings-selection'],
  ['settings-webpage', 'settings-translation'],
  ['settings-shortcuts', 'settings-translation'],
  ['settings-learning-center', 'settings-vocabulary'],
  ['settings-floating-ball', 'settings-interactions'],
  ['settings-context-menu', 'settings-interactions'],
  ['settings-input', 'settings-writing'],
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

/** 控件搜索保留完整标签匹配，支持从搜索结果直达表单中的具体位置。 */
export function filterSettingsSearchTargets(query: string, items: readonly SettingsSearchTarget[] = settingsSearchTargets): SettingsSearchTarget[] {
  const keyword = query.trim().toLocaleLowerCase()
  if (!keyword) return []
  return items.filter(item => `${item.label}${item.description}${item.searchTerms}`.toLocaleLowerCase().includes(keyword))
}

/** 页内分类只决定展示位置，不写入用户配置；搜索与跨页入口共享此注册表。 */
export type SettingsPagePanel = {
  id: string
  labelKey: string
  searchTerms: string
  targetIds: readonly string[]
}
export const settingsPagePanels: Readonly<Record<string, readonly SettingsPagePanel[]>> = {
  'settings-translation-stats': [
    {id: 'overview', labelKey: 'options.panel.statsOverview', searchTerms: '翻译统计 请求 耗时 成功率 缓存', targetIds: []},
    {id: 'usage', labelKey: 'options.panel.modelUsage', searchTerms: '模型用量 Token AI 成本 输入 输出 调用', targetIds: ['settings-model-usage']},
  ],
  'settings-services': [
    {id: 'connections', labelKey: 'featureServices.connections', searchTerms: '连接 服务 密钥 API 模型', targetIds: []},
  ],
  'settings-translation': [
    {id: 'page', labelKey: 'options.panel.page', searchTerms: '全文 快捷键 多段 范围 AI 上下文 进度 页面识别 全部节点 标题 侧栏 段落 最少字符 长段落换行', targetIds: ['full-page-settings', 'page-recognition-settings']},
    {id: 'hover', labelKey: 'options.panel.hoverSection', searchTerms: '鼠标悬浮 快捷键 延迟 局部翻译 分段 区域 快捷方案', targetIds: ['hover-translation-settings', 'section-translation-settings']},
    {id: 'reading', labelKey: 'options.panel.reading', searchTerms: '阅读辅助 双语逐句高亮 原文译文 句子对应 个人校订 修改译文 段落复制', targetIds: ['translation-sentence-highlight', 'translation-sentence-highlight-style', 'information-highlight-settings', 'personal-corrections-settings', 'paragraph-copy-settings']},
    {id: 'excluded-languages', labelKey: 'settings.excludedLanguages.title', searchTerms: '不翻译的语言 跳过语言 排除语言', targetIds: ['excluded-language-settings']},
    {id: 'excluded-tags', labelKey: 'settings.excludedTags.title', searchTerms: '不翻译的标签 排除标签 忽略标签 跳过标签 HTML 标签 CSS 选择器 ignoreSelector tag selector', targetIds: ['excluded-tag-settings']},
  ],
  'settings-interactions': [
    {id: 'floating-ball', labelKey: 'options.panel.floatingBall', searchTerms: '悬浮球 显示悬浮球 点击行为 按钮 位置 边距 透明度 延迟', targetIds: ['floating-ball-settings', 'floating-ball-toggle']},
    {id: 'context-menu', labelKey: 'contextMenuSettings.title', searchTerms: '右键 菜单 选中文本 图片 截图 网站开关', targetIds: ['context-menu-settings']},
  ],
  'settings-writing': [
    {id: 'input', labelKey: 'options.panel.input', searchTerms: '输入框 连按 空格 替换 追加 提示词', targetIds: ['input-translation-settings']},
    {id: 'writing', labelKey: 'options.panel.writing', searchTerms: '写作助手 起草 润色 回复 草稿 语气 篇幅 角色', targetIds: ['writing-assistant-settings']},
  ],
  'settings-interface': [
    {id: 'translation', labelKey: 'options.panel.translation', searchTerms: '译文 样式 颜色 字号 双语上下顺序 原文在上 译文在上', targetIds: ['translation-appearance-panel']},
    {id: 'skin', labelKey: 'options.panel.skin', searchTerms: '弹窗 皮肤 界面风格', targetIds: []},
    {id: 'motion', labelKey: 'options.panel.motion', searchTerms: '动画 加载', targetIds: []},
    {id: 'layout', labelKey: 'options.panel.layout', searchTerms: '菜单栏 布局 栏目 排序 侧边栏显示范围 sidebar scope', targetIds: []},
    {id: 'font', labelKey: 'options.panel.font', searchTerms: '字体 font Inter Noto Sans Roboto Manrope WenKai', targetIds: []},
  ],
  'settings-sites': [
    {id: 'rules', labelKey: 'options.panel.rules', searchTerms: '自动翻译 禁用网站 域名 隐藏悬浮球 网站偏好', targetIds: []},
    {id: 'adaptation', labelKey: 'options.panel.adaptation', searchTerms: '网站适配 JSON 正文 保护区域 自定义规则 可视化编辑 导入 导出', targetIds: []},
    {id: 'preview', labelKey: 'options.panel.sitePreview', searchTerms: '生效预览 网址匹配 检查规则 优先级', targetIds: []},
  ],
  'settings-video': [
    {id: 'general', labelKey: 'options.panel.video', searchTerms: '字幕 开关 课程 会议 人工字幕 术语库 快捷键 显示模式 双语 原文 shortcut hotkey', targetIds: []},
    {id: 'appearance', labelKey: 'options.panel.appearance', searchTerms: '字幕外观 显示模式 颜色 字号 皮肤 轮廓 双语顺序 双语上下顺序 原文在上 译文在上 读音标注 拉丁字母辅助读音 拼音 罗马音 逐字高亮', targetIds: []},
    {id: 'video-learning', labelKey: 'options.panel.videoLearning', searchTerms: '完整句学习 视频学习 面板样式 紧凑 舒适 不透明度 默认位置', targetIds: ['video-sentence-learning-appearance']},
    {id: 'local', labelKey: 'options.panel.local', searchTerms: 'X 本地 AI Whisper Qwen3 语音 识别', targetIds: []},
  ],
  'settings-advanced': [
    {id: 'privacy', labelKey: 'privacy.title', searchTerms: '隐私 脱敏 安全 敏感信息 privacy redaction PII', targetIds: ['privacy-protection-settings']},
    {id: 'requests', labelKey: 'options.panel.requests', searchTerms: '并发 限流 重试 性能 密钥 恢复 退避 AI 请求 超时 timeout 等待 慢模型', targetIds: []},
    {id: 'cache', labelKey: 'options.panel.cache', searchTerms: '缓存 容量 条数 存储 清除', targetIds: []},
  ],
  'settings-data': [
    {id: 'backup', labelKey: 'options.panel.backup', searchTerms: '备份 导入 导出 JSON 云同步 WebDAV Google Drive', targetIds: []},
    {id: 'history', labelKey: 'options.panel.history', searchTerms: '历史 最近修改 自动快照 撤销 恢复', targetIds: []},
  ],
}

/** 控件深链优先打开其所属分类；缺失或过期分类回落到第一页。 */
export function resolveSettingsPanel(sectionId: string, panelOrTargetId?: string): string {
  const resolvedSection = NAVIGATION_SECTION_ALIASES.get(sectionId) ?? sectionId
  const panels = Object.hasOwn(settingsPagePanels, resolvedSection) ? settingsPagePanels[resolvedSection] : []
  if (sectionId === 'settings-model-usage') return 'usage'
  if (sectionId === 'settings-floating-ball') return 'floating-ball'
  if (sectionId === 'settings-context-menu') return 'context-menu'
  if (sectionId === 'settings-input') return 'input'
  if (resolvedSection === 'settings-interactions' && panelOrTargetId === 'tools') return 'floating-ball'
  if (resolvedSection === 'settings-translation' && (panelOrTargetId === 'information-highlight' || panelOrTargetId === 'paragraph-copy')) return 'reading'
  if (resolvedSection === 'settings-translation' && panelOrTargetId === 'section-translation') return 'hover'
  return (panels.find(panel => panel.id === panelOrTargetId || panel.targetIds.includes(panelOrTargetId ?? '')) ?? panels[0])?.id ?? ''
}
